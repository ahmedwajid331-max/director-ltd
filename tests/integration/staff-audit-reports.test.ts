/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are loosely typed JSON */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { parse } from "csv-parse/sync";
import { api, BASE, createUser, db, group, makeCompany, rule, sessionFor, type Session } from "./helpers";
import { appTimezone, dayKey } from "../../src/lib/staff/periods";

after(async () => {
  await db.$disconnect();
});

const uniq = () => Math.random().toString(36).slice(2, 8);
const page = (s: Session, path: string) => fetch(`${BASE}${path}`, { headers: { cookie: `director_session=${s.cookie}` }, redirect: "manual" });
const csvRows = async (s: Session, qs: string) => {
  const res = await page(s, `/api/staff/report?${qs}`);
  assert.equal(res.status, 200, qs);
  return parse(await res.text(), { columns: true }) as any[];
};

// ---------------------------------------------------------------- period comparisons, filters, CSV
test("Period reports: previous-period comparison, staff / role / team filters and CSV agree for day, week, month, year and custom", async () => {
  const sup = await sessionFor("SUPER_ADMIN");
  const staff = await createUser("USER", "cmp");
  const fresh = await createUser("USER", "cmpnew");
  const ev = (userId: string, iso: string, n = 1) => Array.from({ length: n }, () => ({ userId, action: "search", createdAt: new Date(iso), meta: JSON.stringify({ q: "x", total: 1 }) }));
  await db.activityLog.createMany({
    data: [
      ...ev(staff.id, "2026-07-06T12:00:00Z", 2), // Mon, current week
      ...ev(staff.id, "2026-07-07T12:00:00Z", 1), // Tue
      ...ev(staff.id, "2026-07-09T12:00:00Z", 1), // Thu  -> current week = 4
      ...ev(staff.id, "2026-07-01T12:00:00Z", 1), // previous week
      ...ev(staff.id, "2026-07-02T12:00:00Z", 1), //      -> previous week = 2
      ...ev(staff.id, "2026-06-10T12:00:00Z", 1), // June
      ...ev(staff.id, "2025-05-05T12:00:00Z", 2), // 2025
      ...ev(fresh.id, "2026-07-07T12:00:00Z", 1), // nothing before it
    ],
  });
  const actions = async (qs: string, id: string) => (await csvRows(sup, `${qs}&staff=${id}`))[0]["Recorded actions"];
  assert.equal(await actions("period=day&anchor=2026-07-07", staff.id), "1");
  assert.equal(await actions("period=day&anchor=2026-07-06", staff.id), "2");
  assert.equal(await actions("period=week&anchor=2026-07-08", staff.id), "4");
  assert.equal(await actions("period=week&anchor=2026-07-01", staff.id), "2", "the previous week on its own");
  assert.equal(await actions("period=month&anchor=2026-07-15", staff.id), "6");
  assert.equal(await actions("period=month&anchor=2026-06-15", staff.id), "1");
  assert.equal(await actions("period=year&anchor=2026-03-03", staff.id), "7");
  assert.equal(await actions("period=year&anchor=2025-03-03", staff.id), "2");
  assert.equal(await actions("period=custom&from=2026-07-06&to=2026-07-12", staff.id), "4");
  assert.equal(await actions("period=custom&from=2026-07-07&to=2026-07-07", staff.id), "1");

  // The page's comparison against the immediately preceding period of the same kind.
  const html = async (qs: string, id: string) => (await page(sup, `/admin/activity?${qs}&staff=${id}`)).text();
  assert.match(await html("period=week&anchor=2026-07-08", staff.id), /\+100% vs 2/, "week: 4 vs 2");
  assert.match(await html("period=day&anchor=2026-07-07", staff.id), /-50% vs 2/, "day: 1 vs 2");
  assert.match(await html("period=month&anchor=2026-07-15", staff.id), /\+500% vs 1/, "month: 6 vs June's 1");
  assert.match(await html("period=year&anchor=2026-07-15", staff.id), /\+250% vs 2/, "year: 7 vs 2025's 2");
  assert.match(await html("period=custom&from=2026-07-06&to=2026-07-12", staff.id), /\+100% vs 2/, "custom 7 days vs the 7 days before");
  const freshHtml = await html("period=week&anchor=2026-07-08", fresh.id);
  assert.match(freshHtml, /previous period: 0/, "no percentage against zero");
  assert.doesNotMatch(freshHtml, /Infinity|NaN/);

  // Filters: person, role, team.
  const admin = await createUser("ADMIN", "cmpadm");
  await db.user.update({ where: { id: staff.id }, data: { managerId: admin.id } });
  const byRole = await csvRows(sup, "period=week&anchor=2026-07-08&role=ADMIN");
  assert.ok(byRole.length > 0 && byRole.every((r) => r["Role"] === "ADMIN"));
  assert.ok(byRole.some((r) => r["Email"] === admin.email));
  assert.ok(!byRole.some((r) => r["Email"] === staff.email));
  const byTeam = await csvRows(sup, `period=week&anchor=2026-07-08&team=${admin.id}`);
  assert.deepEqual(byTeam.map((r) => r["Email"]), [staff.email]);
  assert.equal(byTeam[0]["Recorded actions"], "4");
  // Quoting survives a name with quotes and commas, and the column order is stable.
  const odd = await createUser("USER", "odd");
  await db.user.update({ where: { id: odd.id }, data: { name: 'Quote "Q", Comma' } });
  const oddRow = (await csvRows(sup, `period=week&staff=${odd.id}`))[0];
  assert.equal(oddRow["Staff member"], 'Quote "Q", Comma');
  assert.deepEqual(Object.keys(oddRow).slice(0, 5), ["Staff member", "Email", "Role", "Account", "Session state now"]);
});

// ---------------------------------------------------------------- pay display and Admin / User restrictions
test("Approved hours show the pay indication; Admins and Users are confined to what they may see", async () => {
  const sup = await sessionFor("SUPER_ADMIN");
  const admin = await sessionFor("ADMIN");
  const member = await sessionFor("USER");
  const other = await sessionFor("USER");
  const adminRow = await db.user.findUniqueOrThrow({ where: { id: admin.userId } });
  const supRow = await db.user.findUniqueOrThrow({ where: { id: sup.userId } });
  const otherRow = await db.user.findUniqueOrThrow({ where: { id: other.userId } });
  const memberRow = await db.user.update({ where: { id: member.userId }, data: { managerId: admin.userId, hourlyRateMinor: 2000, rateCurrency: "GBP" } });
  const today = dayKey(new Date(), appTimezone());

  const t = await api(member, "/api/timesheets", { body: { workDate: today, minutes: 600 } });
  assert.equal((await api(admin, `/api/timesheets/${t.json.timesheet.id}`, { method: "PATCH", body: { action: "approve", approvedMinutes: 540 } })).status, 200);
  const queue = await (await page(admin, "/admin/timesheets")).text();
  assert.match(queue, /9h 00m/);
  assert.match(queue, /£180\.00/, "9 hours at 20.00 = 180.00");
  // Staff see their hours but not pay.
  const mine = await (await page(member, "/work/timesheets")).text();
  assert.match(mine, /9h 00m/);
  assert.doesNotMatch(mine, /£180/);

  // The Admin's directory, profile pages and CSV contain only their own team and themselves.
  const dir = await (await page(admin, "/admin/staff")).text();
  assert.ok(dir.includes(adminRow.email), "themself");
  assert.ok(dir.includes(memberRow.email), "their team member");
  assert.ok(!dir.includes(supRow.email), "never the Super Admin");
  assert.ok(!dir.includes(otherRow.email), "never a stranger");
  assert.equal((await page(admin, `/admin/staff/${sup.userId}`)).status, 404);
  const csv = await csvRows(admin, "period=week");
  assert.deepEqual(csv.map((r) => r["Email"]).sort(), [adminRow.email, memberRow.email].sort());
  // The Super Admin sees everyone.
  const all = await csvRows(sup, "period=week");
  for (const e of [adminRow.email, supRow.email, otherRow.email, memberRow.email]) assert.ok(all.some((r) => r["Email"] === e), e);
  // Users get nothing from the staff APIs or pages.
  for (const path of ["/api/users", "/api/staff/report?period=week"]) assert.equal((await api(member, path)).status, 403, path);
  for (const path of ["/admin", "/admin/staff", "/admin/activity", "/admin/timesheets", "/admin/columns", "/users"]) assert.equal((await page(member, path)).status, 307, path);
  // An Admin gets the staff screens but not the Super Admin-only ones.
  for (const path of ["/admin/staff", "/admin/activity", "/admin/timesheets", "/users"]) assert.equal((await page(admin, path)).status, 200, path);
  for (const path of ["/admin", "/admin/columns"]) assert.equal((await page(admin, path)).status, 307, path);
});

// ---------------------------------------------------------------- nothing returns a server error
test("Every screen and read API answers without a server error for every role", async () => {
  const sup = await sessionFor("SUPER_ADMIN");
  const admin = await sessionFor("ADMIN");
  const member = await sessionFor("USER");
  const basic = await sessionFor("USER");
  await db.user.update({ where: { id: basic.userId }, data: { permissions: JSON.stringify(["companies.view"]) } });
  await db.user.update({ where: { id: member.userId }, data: { managerId: admin.userId } });
  const co = await makeCompany({ name: `SWEEP ${uniq()}` });
  const rep = await api(member, "/api/reports", { body: { name: `sweep ${uniq()}`, filter: group("AND", rule("name", "startsWith", "SWEEP")), dailyRefresh: false } });
  const rid = rep.json.report.id;
  const pages = ["/dashboard", "/companies", "/companies/advanced", `/companies/${co.id}`, "/reports", "/reports/new", `/reports/${rid}`, `/reports/${rid}/edit`, "/watches", "/saved", "/red-flags", "/trash", "/calendar", "/work", "/work/timesheets", "/users", "/settings", "/admin", "/admin/staff", `/admin/staff/${member.userId}`, "/admin/activity", "/admin/activity?period=year", "/admin/timesheets", "/admin/columns"];
  const apis = ["/api/users", "/api/reports", "/api/followups", "/api/staff/report?period=week", "/api/calendar/status", "/api/health", "/api/columns/preference"];
  const bad: string[] = [];
  for (const [name, s] of [["super", sup], ["admin", admin], ["member", member], ["basic", basic]] as const) {
    for (const p of pages) {
      const res = await page(s, p);
      const body = res.status === 200 ? await res.text() : "";
      if (![200, 307, 404].includes(res.status) || /Internal Server Error|Application error|PrismaClient|Unhandled Runtime Error/.test(body)) bad.push(`${name} ${p} -> ${res.status}`);
    }
    for (const p of apis) {
      const res = await page(s, p);
      if (res.status >= 500) bad.push(`${name} ${p} -> ${res.status}`);
    }
  }
  assert.deepEqual(bad, []);
});
