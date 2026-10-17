/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are loosely typed JSON */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parse } from "csv-parse/sync";
import { SignJWT } from "jose";
import { api, BASE, createUser, db, group, login, makeCompany, rule, sessionFor, STRONG_PASSWORD, type Session } from "./helpers";
import { addDays, appTimezone, dayKey } from "../../src/lib/staff/periods";
import { ALL_PERMISSION_KEYS } from "../../src/lib/auth/permissions";

after(async () => {
  await db.$disconnect();
});

const uniq = () => Math.random().toString(36).slice(2, 8);
const page = (s: Session | { cookie: string } | null, path: string) => fetch(`${BASE}${path}`, { headers: s ? { cookie: `director_session=${s.cookie}` } : {}, redirect: "manual" });
const csvRows = async (s: Session, qs: string) => {
  const res = await page(s, `/api/staff/report?${qs}`);
  assert.equal(res.status, 200, qs);
  return parse(await res.text(), { columns: true }) as any[];
};

// ------------------------------------------------------------------------------------ sessions: legacy and ended cookies
test("A cookie without a session id (issued before tracking) is refused everywhere, and no redirect loop exists", async () => {
  const user = await createUser("USER", "legacy");
  const legacy = await new SignJWT({ userId: user.id, email: user.email, name: user.name, role: "USER" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));

  assert.equal((await api({ cookie: legacy, userId: user.id, email: user.email }, "/api/reports")).status, 401, "API refuses it");
  const dash = await page({ cookie: legacy }, "/dashboard");
  assert.equal(dash.status, 307);
  assert.match(dash.headers.get("location") ?? "", /\/login/);
  // /login must NOT bounce a refused cookie back to the app.
  const loginPage = await page({ cookie: legacy }, "/login");
  assert.equal(loginPage.status, 200, "the sign-in page shows instead of redirecting to /dashboard");
  assert.equal(await db.userSession.count({ where: { userId: user.id } }), 0);
});

test("A session ended elsewhere sends the browser to sign-in once, clears the cookie, and never loops", async () => {
  const admin = await sessionFor("ADMIN");
  const member = await sessionFor("USER");
  await db.user.update({ where: { id: member.userId }, data: { managerId: admin.userId } });
  assert.equal((await page(member, "/dashboard")).status, 200);

  assert.equal((await api(admin, `/api/users/${member.userId}/end-sessions`, { method: "POST" })).status, 200);
  // The cookie is still correctly signed, so the proxy lets the request through; the page then refuses it.
  const hop1 = await page(member, "/dashboard");
  assert.equal(hop1.status, 307);
  assert.match(hop1.headers.get("location") ?? "", /\/api\/auth\/expired$/);
  const hop2 = await page(member, "/api/auth/expired");
  assert.equal(hop2.status, 303);
  assert.match(hop2.headers.get("location") ?? "", /\/login$/);
  assert.match(hop2.headers.get("set-cookie") ?? "", /director_session=;|director_session=; /, "the cookie is cleared");
  // Same for a deactivated account.
  const again = await login((await db.user.findUniqueOrThrow({ where: { id: member.userId } })).email);
  const m2 = { cookie: again.cookie! };
  assert.equal((await page(m2, "/dashboard")).status, 200);
  await api(admin, `/api/users/${member.userId}`, { method: "PATCH", body: { active: false } });
  const gone = await page(m2, "/dashboard");
  assert.match(gone.headers.get("location") ?? "", /\/api\/auth\/expired$/);
});

// ------------------------------------------------------------------------------------ presence labels
test("Directory presence: never signed in, signed in before tracking, recently active, no logout, signed out, expired", async () => {
  const sup = await sessionFor("SUPER_ADMIN");
  const tag = uniq();
  const mk = async (label: string) => createUser("USER", `pr${tag}${label}`);
  const never = await mk("never");
  const untracked = await mk("untracked");
  const active = await mk("active");
  const unresolved = await mk("unresolved");
  const ended = await mk("ended");
  const expired = await mk("expired");
  const now = Date.now();
  await db.user.update({ where: { id: untracked.id }, data: { lastLoginAt: new Date(now - 86_400_000) } });
  const sess = (userId: string, startedAt: number, last: number, endedAt: number | null) => db.userSession.create({ data: { userId, startedAt: new Date(startedAt), lastActivityAt: new Date(last), endedAt: endedAt ? new Date(endedAt) : null, endReason: endedAt ? "logout" : null } });
  await sess(active.id, now - 600_000, now - 60_000, null);
  await sess(unresolved.id, now - 7_200_000, now - 5_400_000, null);
  await sess(ended.id, now - 7_200_000, now - 3_600_000, now - 3_600_000);
  await sess(expired.id, now - 9 * 86_400_000, now - 9 * 86_400_000 + 600_000, null);

  const rows = await csvRows(sup, `period=week&role=USER`);
  const stateOf = (u: { email: string }) => rows.find((r) => r["Email"] === u.email)?.["Session state now"];
  assert.equal(stateOf(never), "Never signed in");
  assert.equal(stateOf(untracked), "No session recorded", "has a last login but no session: not 'never'");
  assert.equal(stateOf(active), "Recently active");
  assert.equal(stateOf(unresolved), "No logout recorded");
  assert.equal(stateOf(ended), "Signed out");
  assert.equal(stateOf(expired), "Session expired");

  // The same labels on the directory page itself.
  const html = await (await page(sup, `/admin/staff?q=${encodeURIComponent(`pr${tag}`)}`)).text();
  for (const label of ["Never signed in", "No session recorded", "Recently active", "No logout recorded", "Signed out", "Session expired"]) assert.ok(html.includes(label), label);

  // The profile lists each session with the right duration wording and never invents a logout time.
  const profile = await (await page(sup, `/admin/staff/${unresolved.id}`)).text();
  assert.match(profile, /last seen/);
  assert.match(profile, /to last seen/);
  assert.match(profile, /No logout recorded/);
  const profile2 = await (await page(sup, `/admin/staff/${ended.id}`)).text();
  assert.match(profile2, /Signed out/);
  assert.doesNotMatch(profile2, /to last seen/);
});

// ------------------------------------------------------------------------------------ companies worked
test("Companies worked: bulk changes are attributed to each company, and the backfill migration repairs history", async () => {
  const sup = await sessionFor("SUPER_ADMIN");
  const staff = await sessionFor("USER");
  const cos = [await makeCompany({ name: `BULK ${uniq()} A` }), await makeCompany({ name: `BULK ${uniq()} B` }), await makeCompany({ name: `BULK ${uniq()} C` })];
  const res = await api(staff, "/api/companies/bulk-state", { body: { ids: cos.map((c) => c.id), patch: { saved: true } } });
  assert.equal(res.status, 200, res.text);
  const events = await db.activityLog.findMany({ where: { userId: staff.userId, action: "company_state_change" } });
  assert.equal(events.length, 3, "one event per company");
  assert.deepEqual(events.map((e) => e.companyId).sort(), cos.map((c) => c.id).sort());
  assert.ok(events.every((e) => e.sessionId));
  const row = (await csvRows(sup, `period=week&staff=${staff.userId}`))[0];
  assert.equal(row["Companies worked"], "3");
  assert.equal(row["Recorded actions"], "3");
  // Opening the same company again does not inflate the distinct-company count.
  await page(staff, `/companies/${cos[0].id}`);
  await page(staff, `/companies/${cos[0].id}`);
  assert.equal((await csvRows(sup, `period=week&staff=${staff.userId}`))[0]["Companies worked"], "3");

  // Searches alone are not company work.
  const searcher = await sessionFor("USER");
  await api(searcher, "/api/companies/search", { body: { filter: group("AND", rule("status", "equals", "active")), pageSize: 1 } });
  const s = (await csvRows(sup, `period=week&staff=${searcher.userId}`))[0];
  assert.equal(s["Searches"], "1");
  assert.equal(s["Recorded actions"], "1");
  assert.equal(s["Companies worked"], "0", "a search is recorded but no company was worked on");

  // Backfill: rows written before the link columns existed kept ids only inside meta.
  const user = await createUser("USER", "backfill");
  const co = await makeCompany({ name: `BACKFILL ${uniq()}` });
  const when = new Date();
  await db.activityLog.createMany({
    data: [
      { userId: user.id, action: "company_trash_toggle", meta: JSON.stringify({ companyId: co.id, companyName: co.name, trashed: true }), createdAt: when },
      { userId: user.id, action: "report_created", meta: JSON.stringify({ reportId: "rep-legacy-1", name: "Old" }), createdAt: when },
      { userId: user.id, action: "search", meta: JSON.stringify({ q: "x", total: 3 }), createdAt: when },
      { userId: user.id, action: "company_viewed", meta: "{not json", createdAt: when },
    ],
  });
  const sql = fs
    .readFileSync("prisma/migrations/20261010120000_activity_link_backfill/migration.sql", "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
  const run = async () => {
    for (const stmt of sql) await db.$executeRawUnsafe(stmt);
  };
  await run();
  const after1 = await db.activityLog.findMany({ where: { userId: user.id }, orderBy: { action: "asc" } });
  const by = Object.fromEntries(after1.map((e) => [e.action, e]));
  assert.equal(by["company_trash_toggle"].companyId, co.id);
  assert.equal(by["report_created"].reportId, "rep-legacy-1");
  assert.equal(by["search"].companyId, null);
  assert.equal(by["company_viewed"].companyId, null, "malformed meta is left alone");
  await run(); // idempotent
  assert.deepEqual((await db.activityLog.findMany({ where: { userId: user.id }, orderBy: { action: "asc" } })).map((e) => [e.companyId, e.reportId]), after1.map((e) => [e.companyId, e.reportId]));
  assert.equal((await csvRows(sup, `period=week&staff=${user.id}`))[0]["Companies worked"], "1");
});

// ------------------------------------------------------------------------------------ every permission, server-side
// For each permission: someone holding ONLY that permission (plus what it implies) is allowed, someone holding
// everything-else-minimal is refused. The probe is the real API call the feature uses.
test("Every one of the permissions is enforced on the server (allowed with it, refused without it)", async () => {
  const tag = uniq();
  const tagCo = await makeCompany({ name: `PERMALL ${tag}`, status: "active", dormant: true });
  const owner = await createUser("USER", "pownr");
  const otherReport = await db.report.create({ data: { ownerId: owner.id, name: `other ${tag}`, filterJson: JSON.stringify(group("AND", rule("name", "startsWith", `PERMALL ${tag}`))), dailyRefresh: false } });
  const tz = appTimezone();
  const today = dayKey(new Date(), tz);

  type Ctx = { s: Session; userId: string; adminId?: string };
  const filter = group("AND", rule("name", "startsWith", `PERMALL ${tag}`));
  const ownReport = async (userId: string) => (await db.report.create({ data: { ownerId: userId, name: `mine ${uniq()}`, filterJson: JSON.stringify(filter), dailyRefresh: false } })).id;
  const member = async (adminId: string, perms: string[] | null = null) => {
    const m = await sessionFor("USER", "pmem");
    await db.user.update({ where: { id: m.userId }, data: { managerId: adminId, permissions: perms === null ? null : JSON.stringify(perms) } });
    return m;
  };

  const probes: Record<string, { role?: "USER" | "ADMIN"; denyList?: string[]; actor?: string[]; refused?: number[]; run: (c: Ctx, list: string[]) => Promise<number> }> = {
    "companies.view": { denyList: [], run: async (c) => (await api(c.s, "/api/companies/search", { body: { filter, pageSize: 1 } })).status },
    "companies.advancedSearch": { run: async (c) => (await api(c.s, "/api/companies/search", { body: { filter: group("OR", rule("status", "equals", "active"), rule("dormant", "isTrue")), pageSize: 1 } })).status },
    "companies.directors": { run: async (c) => (await api(c.s, "/api/companies/search", { body: { filter: group("AND", rule("directorCount", "gte", 1)), pageSize: 1 } })).status },
    "crm.manage": { run: async (c) => (await api(c.s, `/api/companies/${tagCo.id}/state`, { body: { followed: true } })).status },
    "reports.create": { run: async (c) => (await api(c.s, "/api/reports", { body: { name: `r ${uniq()}`, filter, dailyRefresh: false } })).status },
    "reports.viewOwn": { run: async (c) => (await api(c.s, "/api/reports")).status },
    "reports.edit": { run: async (c) => (await api(c.s, `/api/reports/${await ownReport(c.userId)}`, { method: "PATCH", body: { name: "renamed" } })).status },
    "reports.exportCsv": { run: async (c) => (await api(c.s, "/api/companies/export", { body: { filter } })).status },
    "reports.exportDocs": { run: async (c) => (await page(c.s, `/api/reports/${await ownReport(c.userId)}/export?format=pdf`)).status },
    "reports.share": { run: async (c) => (await api(c.s, `/api/reports/${await ownReport(c.userId)}/share`, { body: { method: "link" } })).status },
    "reports.viewOthers": { refused: [404], denyList: ["reports.viewOwn"], run: async (c) => (await api(c.s, `/api/reports/${otherReport.id}`)).status },
    "crm.notes": { run: async (c) => (await api(c.s, `/api/companies/${tagCo.id}/notes`, { body: { body: "n" } })).status },
    "calendar.use": { run: async (c) => (await api(c.s, "/api/followups")).status },
    "timesheets.submit": { run: async (c) => (await api(c.s, "/api/timesheets", { body: { workDate: today, minutes: 30 } })).status },
    "work.assigned": {
      // The permission belongs to the person RECEIVING work: a supervisor (who holds only team.assign) assigning to someone
      // without it is refused (400).
      role: "ADMIN",
      actor: ["team.assign"],
      refused: [400],
      run: async (c, list) => {
        const m = await member(c.userId, list);
        return (await api(c.s, "/api/assignments", { body: { assigneeId: m.userId, companyId: tagCo.id } })).status;
      },
    },
    "staff.view": { role: "ADMIN", run: async (c) => (await api(c.s, "/api/users")).status },
    "staff.activity": { role: "ADMIN", run: async (c) => (await api(c.s, "/api/staff/report?period=week")).status },
    "staff.manage": { role: "ADMIN", run: async (c) => (await api(c.s, "/api/users", { body: { name: "N", email: `n.${uniq()}@test.example`, password: STRONG_PASSWORD } })).status },
    "team.assign": {
      role: "ADMIN",
      run: async (c) => {
        const m = await member(c.userId);
        return (await api(c.s, "/api/assignments", { body: { assigneeId: m.userId, companyId: tagCo.id } })).status;
      },
    },
    "timesheets.approve": {
      role: "ADMIN",
      run: async (c) => {
        const m = await member(c.userId);
        const sheet = await db.timesheet.create({ data: { userId: m.userId, workDate: new Date(`${addDays(today, -1)}T00:00:00.000Z`), submittedMinutes: 60 } });
        return (await api(c.s, `/api/timesheets/${sheet.id}`, { method: "PATCH", body: { action: "approve" } })).status;
      },
    },
  };

  // Every key in the catalogue has a probe: adding a permission without enforcing it fails this test.
  assert.deepEqual(Object.keys(probes).sort(), [...ALL_PERMISSION_KEYS].sort());

  const results: string[] = [];
  for (const [key, p] of Object.entries(probes)) {
    const role = p.role ?? "USER";
    const mk = async (perms: string[]) => {
      const s = await sessionFor(role, "pall");
      await db.user.update({ where: { id: s.userId }, data: { permissions: JSON.stringify(perms) } });
      return { s, userId: s.userId } as Ctx;
    };
    const denyList = p.denyList ?? ["companies.view"];
    const allowed = await p.run(await mk(p.actor ?? [key]), [key]);
    const denied = await p.run(await mk(p.actor ?? denyList), denyList);
    results.push(`${key}: with=${allowed} without=${denied}`);
    assert.equal(allowed, 200, `${key}: expected 200 when granted`);
    assert.ok((p.refused ?? [403]).includes(denied), `${key}: expected refusal ${(p.refused ?? [403]).join("/")} without it, got ${denied}`);
  }
  assert.equal(results.length, ALL_PERMISSION_KEYS.length);
});

// ------------------------------------------------------------------------------------ editing permissions leaves preferences alone
test("Changing a person's role or permissions never touches their saved column preference or other data", async () => {
  const sup = await sessionFor("SUPER_ADMIN");
  const user = await sessionFor("USER");
  const put = await api(user, "/api/columns/preference", { method: "PUT", body: { columns: ["name", "companyNumber", "status", "directorCount"] } });
  assert.equal(put.status, 200, put.text);
  const before = await db.userColumnPreference.findUniqueOrThrow({ where: { userId: user.userId } });
  const co = await makeCompany({ name: `KEEP ${uniq()}` });
  await api(user, `/api/companies/${co.id}/state`, { body: { saved: true } });
  const stateBefore = await db.userCompanyState.findFirstOrThrow({ where: { userId: user.userId } });

  assert.equal((await api(sup, `/api/users/${user.userId}`, { method: "PATCH", body: { permissions: ["companies.view", "crm.manage"] } })).status, 200);
  assert.equal((await api(sup, `/api/users/${user.userId}`, { method: "PATCH", body: { role: "ADMIN" } })).status, 200);
  assert.equal((await api(sup, `/api/users/${user.userId}`, { method: "PATCH", body: { role: "USER", active: false } })).status, 200);
  assert.equal((await api(sup, `/api/users/${user.userId}`, { method: "PATCH", body: { active: true, permissions: null } })).status, 200);

  const after = await db.userColumnPreference.findUniqueOrThrow({ where: { userId: user.userId } });
  assert.equal(after.columnsJson, before.columnsJson);
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(), "the preference row was not rewritten");
  const stateAfter = await db.userCompanyState.findFirstOrThrow({ where: { userId: user.userId } });
  assert.equal(stateAfter.saved, stateBefore.saved);
  // An empty PATCH changes nothing.
  assert.equal((await api(sup, `/api/users/${user.userId}`, { method: "PATCH", body: {} })).status, 200);
});
