/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are loosely typed JSON */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { parse } from "csv-parse/sync";
import { api, BASE, createUser, db, group, login, makeCompany, rule, sessionFor, STRONG_PASSWORD, type Session } from "./helpers";
import { addDays, appTimezone, dayKey, resolvePeriod, startOfDay } from "../../src/lib/staff/periods";
import { getDailySeries } from "../../src/lib/staff/stats";
import { NEW_ACCOUNT_DEFAULT } from "../../src/lib/auth/permissions";

after(async () => {
  await db.$disconnect();
});

const uniq = () => Math.random().toString(36).slice(2, 8);
const page = (s: Session | null, path: string) => fetch(`${BASE}${path}`, { headers: s ? { cookie: `director_session=${s.cookie}` } : {}, redirect: "manual" });

// A signed-in user whose stored permission list is exactly `perms` (null = role default).
async function userWith(perms: string[] | null, role: "USER" | "ADMIN" = "USER", over: Record<string, unknown> = {}) {
  const s = await sessionFor(role);
  await db.user.update({ where: { id: s.userId }, data: { permissions: perms === null ? null : JSON.stringify(perms), ...over } });
  return s;
}

// ---------------------------------------------------------------- account creation and permission editing
test("Super Admin creates an account with chosen permissions; they persist, can be edited and reset, and are audited", async () => {
  const sup = await sessionFor("SUPER_ADMIN");
  const email = `perm.${uniq()}@test.example`;
  const created = await api(sup, "/api/users", { body: { name: "Perm Test", email, password: STRONG_PASSWORD, role: "USER", permissions: ["companies.view", "reports.exportCsv"], hourlyRateMinor: 2000, rateCurrency: "USD", managerId: sup.userId } });
  assert.equal(created.status, 200, created.text);
  const id = created.json.user.id as string;
  let row = await db.user.findUniqueOrThrow({ where: { id } });
  assert.deepEqual(JSON.parse(row.permissions!), ["companies.view", "reports.viewOwn", "reports.exportCsv"], "implied permission added, order from the catalogue");
  assert.equal(row.hourlyRateMinor, 2000);
  assert.equal(row.rateCurrency, "USD");
  assert.equal(row.managerId, sup.userId);

  // Edit: add one permission; everything else is untouched.
  const before = row.permissions;
  const r1 = await api(sup, `/api/users/${id}`, { method: "PATCH", body: { permissions: ["companies.view", "reports.viewOwn", "reports.exportCsv", "crm.notes"] } });
  assert.equal(r1.status, 200, r1.text);
  row = await db.user.findUniqueOrThrow({ where: { id } });
  assert.notEqual(row.permissions, before);
  assert.ok(JSON.parse(row.permissions!).includes("crm.notes"));
  assert.equal(row.hourlyRateMinor, 2000, "unrelated fields untouched");
  assert.equal(row.active, true);

  const audit = await db.activityLog.findFirst({ where: { userId: sup.userId, action: "permissions_changed" }, orderBy: { createdAt: "desc" } });
  assert.ok(audit);
  const meta = JSON.parse(audit.meta!);
  assert.equal(meta.targetId, id);
  assert.deepEqual(meta.grantedKeys, ["crm.notes"]);
  assert.equal(meta.revoked, 0);

  // Reset to role default.
  assert.equal((await api(sup, `/api/users/${id}`, { method: "PATCH", body: { permissions: null } })).status, 200);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id } })).permissions, null);

  // Validation and self-protection.
  assert.equal((await api(sup, `/api/users/${id}`, { method: "PATCH", body: { permissions: ["nope.nope"] } })).status, 400);
  assert.equal((await api(sup, `/api/users/${id}`, { method: "PATCH", body: { permissions: ["staff.manage"] } })).status, 400, "administration keys are for Admin accounts only");
  assert.equal((await api(sup, `/api/users/${sup.userId}`, { method: "PATCH", body: { permissions: [] } })).status, 400, "cannot edit own permissions");
  assert.equal((await api(sup, `/api/users/${id}`, { method: "PATCH", body: { rateCurrency: "XXX" } })).status, 400);

  // A new USER with no explicit list gets the least-privilege preset.
  const plain = await api(sup, "/api/users", { body: { name: "Plain", email: `plain.${uniq()}@test.example`, password: STRONG_PASSWORD } });
  assert.deepEqual(JSON.parse((await db.user.findUniqueOrThrow({ where: { id: plain.json.user.id } })).permissions!), NEW_ACCOUNT_DEFAULT);
});

test("Admin (supervisor) can create accounts only with the standard preset, inside their own team", async () => {
  const admin = await sessionFor("ADMIN");
  const r = await api(admin, "/api/users", { body: { name: "Team Hire", email: `hire.${uniq()}@test.example`, password: STRONG_PASSWORD } });
  assert.equal(r.status, 200, r.text);
  const row = await db.user.findUniqueOrThrow({ where: { id: r.json.user.id } });
  assert.deepEqual(JSON.parse(row.permissions!), NEW_ACCOUNT_DEFAULT);
  assert.equal(row.managerId, admin.userId);
  assert.equal(row.hourlyRateMinor, null);
  // Elevated choices are Super Admin only.
  const base = { name: "X", email: `x.${uniq()}@test.example`, password: STRONG_PASSWORD };
  assert.equal((await api(admin, "/api/users", { body: { ...base, role: "ADMIN" } })).status, 403);
  assert.equal((await api(admin, "/api/users", { body: { ...base, permissions: ["companies.view"] } })).status, 403);
  assert.equal((await api(admin, "/api/users", { body: { ...base, hourlyRateMinor: 100 } })).status, 403);
  // A plain user cannot create accounts at all.
  const user = await sessionFor("USER");
  assert.equal((await api(user, "/api/users", { body: base })).status, 403);
});

// ---------------------------------------------------------------- permissions are enforced on the server
test("Permissions are enforced by the API, not only hidden in the UI", async () => {
  const company = await makeCompany({ name: `PERM ${uniq()}`, status: "active", dormant: true });
  const basic = await userWith(["companies.view"]);
  const status = (r: { status: number }) => r.status;

  // Search: basic filters pass; OR / nested logic needs Advanced Search; director filters need director access.
  const s1 = await api(basic, "/api/companies/search", { body: { filter: group("AND", rule("status", "equals", "active")), pageSize: 5 } });
  assert.equal(s1.status, 200, s1.text);
  const or = await api(basic, "/api/companies/search", { body: { filter: group("OR", rule("status", "equals", "active"), rule("dormant", "isTrue")), pageSize: 5 } });
  assert.equal(or.status, 403);
  assert.equal(or.json.permission, "companies.advancedSearch");
  assert.equal(status(await api(basic, "/api/companies/search", { body: { filter: group("AND", rule("directorCount", "gte", 2)), pageSize: 5 } })), 403);
  // One field's multi-select (what the criteria panel builds) is basic.
  assert.equal(status(await api(basic, "/api/companies/search", { body: { filter: group("AND", group("OR", rule("status", "equals", "active"), rule("status", "equals", "dissolved"))), pageSize: 5 } })), 200);

  // Everything else is refused for this user.
  assert.equal(status(await api(basic, "/api/companies/export", { body: { filter: group("AND", rule("status", "equals", "active")) } })), 403);
  assert.equal(status(await api(basic, "/api/reports", { body: { name: "r", filter: group("AND", rule("status", "equals", "active")), dailyRefresh: false } })), 403);
  assert.equal(status(await api(basic, "/api/reports")), 403, "no reports.viewOwn");
  assert.equal(status(await api(basic, `/api/companies/${company.id}/notes`, { body: { body: "hello" } })), 403);
  assert.equal(status(await api(basic, `/api/companies/${company.id}/contact-log`, { body: { channel: "call", outcome: "reached" } })), 403);
  assert.equal(status(await api(basic, `/api/companies/${company.id}/state`, { body: { followed: true } })), 403);
  assert.equal(status(await api(basic, "/api/followups")), 403, "no calendar.use");
  assert.equal(status(await api(basic, "/api/timesheets", { body: { workDate: dayKey(new Date(), appTimezone()), minutes: 30 } })), 403);
  assert.equal(status(await api(basic, "/api/assignments", { body: { assigneeId: basic.userId, companyNumber: company.companyNumber } })), 403);
  assert.equal(status(await api(null, "/api/companies/search", { body: {} })), 401);

  // Pages follow the same rules: no permission -> redirected away.
  for (const path of ["/reports", "/reports/new", "/calendar", "/watches", "/trash", "/companies/advanced", "/work", "/admin/staff", "/admin/activity", "/admin/timesheets"]) {
    const res = await page(basic, path);
    assert.equal(res.status, 307, `${path} should redirect`);
    assert.match(res.headers.get("location") ?? "", /\/(dashboard|work\/timesheets)$/);
  }
  assert.equal((await page(basic, `/companies/${company.id}`)).status, 200);

  // Granting exactly one more permission opens exactly that.
  await db.user.update({ where: { id: basic.userId }, data: { permissions: JSON.stringify(["companies.view", "crm.notes"]) } });
  assert.equal(status(await api(basic, `/api/companies/${company.id}/notes`, { body: { body: "hello" } })), 200);
  assert.equal(status(await api(basic, `/api/companies/${company.id}/state`, { body: { followed: true } })), 403, "still no crm.manage");

  // Director information: filters refused, result columns redacted.
  await db.company.update({ where: { id: company.id }, data: { directorCount: 3, singleDirector: false, officersCoverage: "full", officersFetchedAt: new Date() } });
  const noDir = await userWith(["companies.view"]);
  const rows = await api(noDir, "/api/companies/search", { body: { filter: group("AND", rule("name", "equals", company.name)), pageSize: 5 } });
  assert.equal(rows.status, 200, rows.text);
  assert.equal(rows.json.rows[0].directorCount, null);
  assert.equal(rows.json.rows[0].officersCoverage, "none");
  const withDir = await userWith(["companies.view", "companies.directors"]);
  const rows2 = await api(withDir, "/api/companies/search", { body: { filter: group("AND", rule("name", "equals", company.name)), pageSize: 5 } });
  assert.equal(rows2.json.rows[0].directorCount, 3);
});

test("Report access, exports and sharing follow reports.* permissions and ownership", async () => {
  const tag = `RP${uniq()}`;
  await makeCompany({ name: `${tag} A` });
  const owner = await userWith(["companies.view", "reports.create", "reports.edit", "reports.exportCsv", "reports.exportDocs", "reports.share"]);
  const created = await api(owner, "/api/reports", { body: { name: `rep ${tag}`, filter: group("AND", rule("name", "startsWith", tag)), dailyRefresh: false } });
  assert.equal(created.status, 200, created.text);
  const id = created.json.report.id as string;

  // Share: recorded for someone who may share; refused otherwise.
  assert.equal((await api(owner, `/api/reports/${id}/share`, { body: { method: "whatsapp" } })).status, 200);
  const ev = await db.activityLog.findFirst({ where: { userId: owner.userId, action: "report_shared", reportId: id } });
  assert.equal(JSON.parse(ev!.meta!).method, "whatsapp");
  assert.equal((await api(owner, `/api/reports/${id}/share`, { body: { method: "pigeon" } })).status, 400);

  const noShare = await userWith(["companies.view", "reports.viewOwn"]);
  assert.equal((await api(noShare, `/api/reports/${id}/share`, { body: { method: "link" } })).status, 403);

  // Another plain user cannot read, export or share it; someone with viewOthers can.
  const other = await userWith(["companies.view", "reports.viewOwn", "reports.exportCsv", "reports.exportDocs", "reports.share"]);
  assert.equal((await api(other, `/api/reports/${id}`)).status, 404);
  assert.equal((await page(other, `/api/reports/${id}/export?format=pdf`)).status, 404);
  assert.equal((await api(other, `/api/reports/${id}/share`, { body: { method: "link" } })).status, 404);
  const viewer = await userWith(["companies.view", "reports.viewOthers", "reports.exportDocs"]);
  assert.equal((await api(viewer, `/api/reports/${id}`)).status, 200);
  assert.equal((await page(viewer, `/api/reports/${id}/export?format=docx`)).status, 200);
  const noDocs = await userWith(["companies.view", "reports.viewOthers"]);
  assert.equal((await page(noDocs, `/api/reports/${id}/export?format=pdf`)).status, 403);

  // Viewing someone else's report is itself recorded (once per 30 minutes).
  await api(viewer, `/api/reports/${id}`);
  assert.equal(await db.activityLog.count({ where: { userId: viewer.userId, action: "report_viewed", reportId: id } }), 1);

  // Owner can edit/delete only with reports.edit.
  const readOnlyOwner = await userWith(["companies.view", "reports.create"]);
  const mine = await api(readOnlyOwner, "/api/reports", { body: { name: "mine", filter: group("AND", rule("name", "startsWith", tag)), dailyRefresh: false } });
  assert.equal((await api(readOnlyOwner, `/api/reports/${mine.json.report.id}`, { method: "PATCH", body: { name: "renamed" } })).status, 403);
  assert.equal((await api(owner, `/api/reports/${id}`, { method: "PATCH", body: { name: `renamed ${tag}` } })).status, 200);
  assert.equal((await api(owner, `/api/reports/${id}`, { method: "DELETE" })).status, 200);
  assert.ok(await db.activityLog.findFirst({ where: { userId: owner.userId, action: "report_deleted", reportId: id } }));
});

// ---------------------------------------------------------------- sessions
test("Sign-in, activity, sign-out and failed sign-ins are recorded; a copied cookie dies at logout", async () => {
  const user = await createUser("USER", "sess");
  const l = await login(user.email);
  assert.ok(l.cookie);
  const s: Session = { cookie: l.cookie!, userId: user.id, email: user.email };
  const row = await db.userSession.findFirstOrThrow({ where: { userId: user.id } });
  assert.equal(row.endedAt, null);
  const loginEvent = await db.activityLog.findFirstOrThrow({ where: { userId: user.id, action: "login" } });
  assert.equal(loginEvent.sessionId, row.id, "the sign-in event belongs to its session");
  assert.ok((await db.user.findUniqueOrThrow({ where: { id: user.id } })).lastLoginAt);

  // lastActivityAt moves forward on authenticated requests (throttled to once a minute).
  await db.userSession.update({ where: { id: row.id }, data: { lastActivityAt: new Date(Date.now() - 10 * 60_000) } });
  assert.equal((await api(s, "/api/reports")).status, 200);
  const touched = await db.userSession.findUniqueOrThrow({ where: { id: row.id } });
  assert.ok(Date.now() - touched.lastActivityAt.getTime() < 60_000, "last activity refreshed");
  const stamp = touched.lastActivityAt.getTime();
  await api(s, "/api/reports");
  assert.equal((await db.userSession.findUniqueOrThrow({ where: { id: row.id } })).lastActivityAt.getTime(), stamp, "throttled: no write on the very next request");

  // Actions are tied to the session.
  const co = await makeCompany({ name: `SESS ${uniq()}` });
  assert.equal((await api(s, `/api/companies/${co.id}/notes`, { body: { body: "n" } })).status, 200);
  const note = await db.activityLog.findFirstOrThrow({ where: { userId: user.id, action: "note_added" } });
  assert.equal(note.sessionId, row.id);
  assert.equal(note.companyId, co.id);

  // Explicit logout writes the end time and the reason, and the cookie stops working.
  const out = await api(s, "/api/auth/logout", { method: "POST" });
  assert.equal(out.status, 303);
  const ended = await db.userSession.findUniqueOrThrow({ where: { id: row.id } });
  assert.ok(ended.endedAt);
  assert.equal(ended.endReason, "logout");
  assert.ok(await db.activityLog.findFirst({ where: { userId: user.id, action: "logout", sessionId: row.id } }));
  assert.equal((await api(s, "/api/reports")).status, 401, "the old cookie is rejected after logout");

  // Failed sign-in: recorded against the real account (de-duplicated), nothing sensitive stored.
  const bad = await login(user.email, "definitely-wrong-password");
  assert.equal(bad.status, 401);
  await login(user.email, "definitely-wrong-password");
  const fails = await db.activityLog.findMany({ where: { userId: user.id, action: "login_failed" } });
  assert.equal(fails.length, 1, "a burst of identical failures within seconds is one event");
  assert.deepEqual(JSON.parse(fails[0].meta!), { reason: "bad_password" });
  // Unknown addresses are not logged anywhere.
  const before = await db.activityLog.count({ where: { action: "login_failed" } });
  await login(`nobody.${uniq()}@test.example`, "whatever-password-1");
  assert.equal(await db.activityLog.count({ where: { action: "login_failed" } }), before);
});

test("Deactivating an account ends its sessions at once and an administrator can end sessions explicitly", async () => {
  const admin = await sessionFor("ADMIN");
  const member = await sessionFor("USER");
  await db.user.update({ where: { id: member.userId }, data: { managerId: admin.userId } });
  assert.equal((await api(member, "/api/reports")).status, 200);

  const end = await api(admin, `/api/users/${member.userId}/end-sessions`, { method: "POST" });
  assert.equal(end.status, 200, end.text);
  assert.ok(end.json.ended >= 1);
  const s1 = await db.userSession.findFirstOrThrow({ where: { userId: member.userId } });
  assert.equal(s1.endReason, "admin_ended");
  assert.equal((await api(member, "/api/reports")).status, 401);

  const again = await login((await db.user.findUniqueOrThrow({ where: { id: member.userId } })).email);
  const m2: Session = { cookie: again.cookie!, userId: member.userId, email: "" };
  assert.equal((await api(m2, "/api/reports")).status, 200);
  assert.equal((await api(admin, `/api/users/${member.userId}`, { method: "PATCH", body: { active: false } })).status, 200);
  assert.equal((await api(m2, "/api/reports")).status, 401, "deactivated users are signed out immediately");
  const sessions = await db.userSession.findMany({ where: { userId: member.userId, endReason: "deactivated" } });
  assert.equal(sessions.length, 1);
});

// ---------------------------------------------------------------- activity recording without duplicates
test("Searches and company views are recorded once per window, not once per request", async () => {
  const s = await sessionFor("USER");
  const co = await makeCompany({ name: `ACT ${uniq()}` });
  const f1 = group("AND", rule("name", "startsWith", "ACT"));
  const f2 = group("AND", rule("name", "startsWith", "ACT"), rule("status", "equals", "active"));
  for (let i = 0; i < 3; i++) await api(s, "/api/companies/search", { body: { filter: f1, pageSize: 1 } });
  await api(s, "/api/companies/search", { body: { filter: f2, pageSize: 1 } });
  assert.equal(await db.activityLog.count({ where: { userId: s.userId, action: "search" } }), 2, "same search repeated = one event; a different search is a second");

  await page(s, `/companies/${co.id}`);
  await page(s, `/companies/${co.id}`);
  const views = await db.activityLog.findMany({ where: { userId: s.userId, action: "company_viewed" } });
  assert.equal(views.length, 1);
  assert.equal(views[0].companyId, co.id);
  // Opening a company is NOT contact.
  assert.equal(await db.contactLog.count({ where: { userId: s.userId } }), 0);
});

// ---------------------------------------------------------------- contact log, assignments, scope
test("Contact outcomes are the only thing that counts as contacted", async () => {
  const s = await sessionFor("USER");
  const co = await makeCompany({ name: `CONT ${uniq()}` });
  assert.equal((await api(s, `/api/companies/${co.id}/contact-log`, { body: { channel: "fax", outcome: "reached" } })).status, 400);
  assert.equal((await api(s, `/api/companies/${co.id}/contact-log`, { body: { channel: "call", outcome: "no_answer" } })).status, 200);
  assert.equal((await api(s, `/api/companies/${co.id}/contact-log`, { body: { channel: "email", outcome: "reached", note: "Replied" } })).status, 200);
  assert.equal((await api(s, `/api/companies/nope/contact-log`, { body: { channel: "call", outcome: "reached" } })).status, 404);
  assert.equal(await db.contactLog.count({ where: { userId: s.userId } }), 2);
  const ev = await db.activityLog.findMany({ where: { userId: s.userId, action: "contact_logged" } });
  assert.equal(ev.length, 2);
  assert.ok(ev.every((e) => e.companyId === co.id));
});

test("Work assignment is limited to the supervisor's team, audited, and completable only by the right people", async () => {
  const admin = await sessionFor("ADMIN");
  const admin2 = await sessionFor("ADMIN");
  const member = await sessionFor("USER");
  const outsider = await sessionFor("USER");
  await db.user.update({ where: { id: member.userId }, data: { managerId: admin.userId } });
  const co = await makeCompany({ name: `ASSIGN ${uniq()}` });

  const a = await api(admin, "/api/assignments", { body: { assigneeId: member.userId, companyNumber: co.companyNumber, dueDate: "2026-12-01", note: "Call them" } });
  assert.equal(a.status, 200, a.text);
  const aid = a.json.assignment.id as string;
  assert.equal((await api(admin, "/api/assignments", { body: { assigneeId: member.userId, companyId: co.id } })).status, 409, "no duplicate open assignment");
  assert.equal((await api(admin, "/api/assignments", { body: { assigneeId: outsider.userId, companyId: co.id } })).status, 404, "not in this supervisor's team");
  assert.equal((await api(admin2, "/api/assignments", { body: { assigneeId: member.userId, companyId: co.id } })).status, 404, "another supervisor cannot assign to this person");
  assert.equal((await api(member, "/api/assignments", { body: { assigneeId: member.userId, companyId: co.id } })).status, 403, "no team.assign");
  assert.equal((await api(admin, "/api/assignments", { body: { assigneeId: member.userId, companyNumber: "ZZ99999999" } })).status, 404);
  const created = await db.activityLog.findFirstOrThrow({ where: { userId: admin.userId, action: "assignment_created" }, orderBy: { createdAt: "desc" } });
  assert.equal(created.companyId, co.id);

  // The assignee sees it on their company page and cannot be overridden by an outsider.
  assert.equal((await api(outsider, `/api/assignments/${aid}`, { method: "PATCH", body: { action: "complete" } })).status, 404);
  assert.equal((await api(admin2, `/api/assignments/${aid}`, { method: "PATCH", body: { action: "cancel" } })).status, 404);
  assert.equal((await api(member, `/api/assignments/${aid}`, { method: "PATCH", body: { action: "cancel" } })).status, 403, "assignee cannot cancel, only supervisors");
  const html = await (await page(member, `/companies/${co.id}`)).text();
  assert.match(html, /Assigned to you by/);

  // Reassign inside the team, then the new assignee completes it.
  const member2 = await sessionFor("USER");
  await db.user.update({ where: { id: member2.userId }, data: { managerId: admin.userId } });
  assert.equal((await api(admin, `/api/assignments/${aid}`, { method: "PATCH", body: { action: "reassign", assigneeId: member2.userId } })).status, 200);
  assert.equal((await api(admin, `/api/assignments/${aid}`, { method: "PATCH", body: { action: "reassign", assigneeId: outsider.userId } })).status, 404);
  assert.equal((await api(member, `/api/assignments/${aid}`, { method: "PATCH", body: { action: "complete" } })).status, 404, "no longer theirs");
  assert.equal((await api(member2, `/api/assignments/${aid}`, { method: "PATCH", body: { action: "complete" } })).status, 200);
  assert.equal((await api(member2, `/api/assignments/${aid}`, { method: "PATCH", body: { action: "complete" } })).status, 409);
  const done = await db.assignment.findUniqueOrThrow({ where: { id: aid } });
  assert.equal(done.status, "done");
  assert.ok(done.completedAt);
  const actions = (await db.activityLog.findMany({ where: { companyId: co.id, action: { startsWith: "assignment_" } } })).map((x) => x.action).sort();
  assert.deepEqual(actions, ["assignment_completed", "assignment_created", "assignment_reassigned"]);
});

test("Supervisors see only their own team; direct URLs and APIs give the same answer as the UI", async () => {
  const sup = await sessionFor("SUPER_ADMIN");
  const admin = await sessionFor("ADMIN");
  const admin2 = await sessionFor("ADMIN");
  const member = await sessionFor("USER");
  const stranger = await sessionFor("USER");
  const memberRow = await db.user.update({ where: { id: member.userId }, data: { managerId: admin.userId } });
  const strangerRow = await db.user.findUniqueOrThrow({ where: { id: stranger.userId } });

  const list = await api(admin, "/api/users");
  assert.equal(list.status, 200);
  const emails = (list.json.users as any[]).map((u) => u.email);
  assert.ok(emails.includes(memberRow.email));
  assert.ok(!emails.includes(strangerRow.email), "out-of-scope accounts are not listed");

  assert.equal((await api(admin, `/api/users/${stranger.userId}`, { method: "PATCH", body: { active: false } })).status, 404);
  assert.equal((await api(admin, `/api/users/${stranger.userId}/end-sessions`, { method: "POST" })).status, 404);
  assert.equal((await api(admin, `/api/users/${member.userId}`, { method: "PATCH", body: { role: "ADMIN" } })).status, 403);
  assert.equal((await api(admin, `/api/users/${member.userId}`, { method: "PATCH", body: { permissions: ["companies.view"] } })).status, 403);
  assert.equal((await api(admin, `/api/users/${member.userId}`, { method: "PATCH", body: { hourlyRateMinor: 5000 } })).status, 403);

  const profile = (s: Session, id: string) => page(s, `/admin/staff/${id}`);
  const ok = await profile(admin, member.userId);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), new RegExp(memberRow.name));
  assert.equal((await profile(admin, stranger.userId)).status, 404);
  assert.equal((await profile(admin2, member.userId)).status, 404);
  assert.equal((await profile(sup, stranger.userId)).status, 200);
  assert.equal((await profile(member, member.userId)).status, 307, "ordinary staff cannot open staff profiles, not even their own");

  // The activity report API is scoped identically and refuses people without the permission.
  const csv = (s: Session) => page(s, "/api/staff/report?period=week");
  assert.equal((await csv(member)).status, 403);
  const adminCsv = parse(await (await csv(admin)).text(), { columns: true }) as any[];
  assert.ok(adminCsv.some((r) => r["Email"] === memberRow.email));
  assert.ok(!adminCsv.some((r) => r["Email"] === strangerRow.email));
  const supCsv = parse(await (await csv(sup)).text(), { columns: true }) as any[];
  assert.ok(supCsv.some((r) => r["Email"] === strangerRow.email));
  // A supervisor cannot widen the scope by naming someone else in the query.
  const forged = parse(await (await page(admin, `/api/staff/report?period=week&staff=${stranger.userId}`)).text(), { columns: true }) as any[];
  assert.equal(forged.length, 0);
  assert.equal((await page(admin, "/api/staff/report?period=custom&from=2026-10-05&to=2026-10-01")).status, 400);
  assert.equal((await page(admin, "/api/staff/report?period=day&anchor=2026-02-30")).status, 400);
});

// ---------------------------------------------------------------- reports by period
test("Period reports count recorded events by calendar day in the app timezone, with sessions clipped to the window", async () => {
  const sup = await sessionFor("SUPER_ADMIN");
  const staff = await createUser("USER", "period");
  const co = await makeCompany({ name: `PER ${uniq()}` });
  const at = (iso: string, action: string, extra: Record<string, unknown> = {}) => ({ userId: staff.id, action, createdAt: new Date(iso), ...extra });
  // Europe/London in summer is UTC+1: 22:30Z is 23:30 on 30 June; 23:30Z is 00:30 on 1 July.
  await db.activityLog.createMany({
    data: [
      at("2026-06-30T22:30:00Z", "search"),
      at("2026-06-30T22:40:00Z", "note_added", { companyId: co.id }),
      at("2026-06-30T23:30:00Z", "search"),
      at("2026-07-01T10:00:00Z", "login"), // not meaningful work
      at("2026-07-06T09:00:00Z", "report_created", { reportId: "r1" }),
      at("2026-07-06T09:05:00Z", "export_pdf"),
      at("2026-07-06T09:06:00Z", "login_failed"),
    ],
  });
  await db.contactLog.createMany({
    data: [
      { userId: staff.id, companyId: co.id, channel: "call", outcome: "no_answer", createdAt: new Date("2026-06-30T22:50:00Z") },
      { userId: staff.id, companyId: co.id, channel: "call", outcome: "reached", createdAt: new Date("2026-06-30T22:55:00Z") },
    ],
  });
  // One session spanning local midnight, one with no logout (unresolved), two overlapping browsers.
  await db.userSession.createMany({
    data: [
      { userId: staff.id, startedAt: new Date("2026-06-30T22:00:00Z"), lastActivityAt: new Date("2026-07-01T00:00:00Z"), endedAt: new Date("2026-07-01T00:00:00Z"), endReason: "logout" },
      { userId: staff.id, startedAt: new Date("2026-07-06T09:00:00Z"), lastActivityAt: new Date("2026-07-06T10:00:00Z"), endedAt: null },
      { userId: staff.id, startedAt: new Date("2026-07-06T09:30:00Z"), lastActivityAt: new Date("2026-07-06T10:30:00Z"), endedAt: null },
    ],
  });

  const row = async (qs: string) => {
    const res = await page(sup, `/api/staff/report?${qs}&staff=${staff.id}`);
    assert.equal(res.status, 200, qs);
    const rows = parse(await res.text(), { columns: true }) as any[];
    assert.equal(rows.length, 1);
    return rows[0];
  };

  const jun30 = await row("period=day&anchor=2026-06-30");
  assert.equal(jun30["Recorded actions"], "2", "23:30 BST on 30 June belongs to 30 June");
  assert.equal(jun30["Searches"], "1");
  assert.equal(jun30["Companies worked"], "1");
  assert.equal(jun30["Contacts logged"], "2");
  assert.equal(jun30["Contacts that reached a person"], "1");
  assert.equal(jun30["Recorded session time"], "1h 00m", "the overnight session is clipped to 23:00-24:00 local");

  const jul1 = await row("period=day&anchor=2026-07-01");
  assert.equal(jul1["Recorded actions"], "1", "00:30 BST on 1 July belongs to 1 July; the sign-in is not counted as work");
  assert.equal(jul1["Recorded session time"], "1h 00m", "00:00-01:00 local from the same overnight session");
  assert.equal(jul1["Sessions"], "1");

  const week = await row("period=week&anchor=2026-07-07"); // Mon 6 - Sun 12 July
  assert.equal(week["Recorded actions"], "2", "report + PDF export");
  assert.equal(week["Reports created"], "1");
  assert.equal(week["Exports"], "1");
  assert.equal(week["Failed sign-ins"], "1");
  assert.equal(week["Sessions"], "2");
  assert.equal(week["Recorded session time"], "1h 30m", "overlapping browsers are merged: 09:00-10:30 once, not 2h");

  const month = await row("period=month&anchor=2026-07-15");
  assert.equal(month["Recorded actions"], "3"); // 30 Jun is June locally? no: 30 Jun 23:30 UTC-boundary events fall in July locally
  const june = await row("period=month&anchor=2026-06-15");
  assert.equal(june["Recorded actions"], "2");
  const custom = await row("period=custom&from=2026-06-30&to=2026-07-06");
  assert.equal(custom["Recorded actions"], "5");
  const empty = await row("period=day&anchor=2020-01-01");
  assert.equal(empty["Recorded actions"], "0", "a quiet day is zero, not missing");
  assert.equal(empty["Recorded session time"], "< 1 min");
  assert.equal((await row("period=year&anchor=2026-03-03"))["Recorded actions"], "5");

  // The chart's series (zero-filled, one point per local day) agrees with the table.
  const r = resolvePeriod({ kind: "custom", from: "2026-06-29", to: "2026-07-07" });
  assert.ok(r.ok);
  if (r.ok) {
    const p = r.period;
    const series = await getDailySeries([staff.id], p.days, p.from, p.to, p.tz, (d) => startOfDay(d, p.tz));
    assert.deepEqual(series.map((x) => x.day), p.days);
    const by = Object.fromEntries(series.map((x) => [x.day, x]));
    assert.equal(by["2026-06-29"].meaningfulActions, 0);
    assert.equal(by["2026-06-30"].meaningfulActions, 2);
    assert.equal(by["2026-07-01"].meaningfulActions, 1);
    assert.equal(by["2026-07-06"].meaningfulActions, 2);
    assert.equal(by["2026-06-30"].sessionMs, 3_600_000);
    assert.equal(by["2026-07-01"].sessionMs, 3_600_000);
    assert.equal(by["2026-07-06"].sessionMs, 5_400_000);
    assert.equal(series.reduce((n, x) => n + x.meaningfulActions, 0), 5);
  }

  // The CSV download is itself audited.
  assert.ok(await db.activityLog.findFirst({ where: { userId: sup.userId, action: "staff_report_exported" } }));
});

// ---------------------------------------------------------------- timesheets
test("Timesheets: claims, approval limits, separation of duties, rate captured, nothing automatic", async () => {
  const tz = appTimezone();
  const today = dayKey(new Date(), tz);
  const admin = await sessionFor("ADMIN");
  const admin2 = await sessionFor("ADMIN");
  const member = await sessionFor("USER");
  await db.user.update({ where: { id: member.userId }, data: { managerId: admin.userId, hourlyRateMinor: 2000, rateCurrency: "GBP" } });

  assert.equal((await api(member, "/api/timesheets", { body: { workDate: addDays(today, 1), minutes: 60 } })).status, 400, "no future days");
  assert.equal((await api(member, "/api/timesheets", { body: { workDate: addDays(today, -90), minutes: 60 } })).status, 400, "not too far back");
  assert.equal((await api(member, "/api/timesheets", { body: { workDate: today, minutes: 0 } })).status, 400);
  assert.equal((await api(member, "/api/timesheets", { body: { workDate: today, minutes: 1441 } })).status, 400);
  assert.equal((await api(member, "/api/timesheets", { body: { workDate: "2026-02-30", minutes: 60 } })).status, 400);

  const sub = await api(member, "/api/timesheets", { body: { workDate: today, minutes: 600, note: "Cold calls" } });
  assert.equal(sub.status, 200, sub.text);
  const id = sub.json.timesheet.id as string;
  assert.equal(sub.json.timesheet.status, "submitted");
  assert.equal(sub.json.timesheet.approvedMinutes, null, "never auto-approved");

  // Review rules.
  assert.equal((await api(member, `/api/timesheets/${id}`, { method: "PATCH", body: { action: "approve" } })).status, 403, "staff cannot approve");
  assert.equal((await api(admin2, `/api/timesheets/${id}`, { method: "PATCH", body: { action: "approve" } })).status, 404, "another supervisor cannot see it");
  assert.equal((await api(admin, `/api/timesheets/${id}`, { method: "PATCH", body: { action: "approve", approvedMinutes: 601 } })).status, 400, "cannot approve more than claimed");
  assert.equal((await api(admin, `/api/timesheets/${id}`, { method: "PATCH", body: { action: "reject" } })).status, 400, "a reason is required");
  const ok = await api(admin, `/api/timesheets/${id}`, { method: "PATCH", body: { action: "approve", approvedMinutes: 540 } });
  assert.equal(ok.status, 200, ok.text);
  const t = await db.timesheet.findUniqueOrThrow({ where: { id } });
  assert.equal(t.status, "approved");
  assert.equal(t.submittedMinutes, 600);
  assert.equal(t.approvedMinutes, 540);
  assert.equal(t.rateMinorAtApproval, 2000);
  assert.equal(t.rateCurrencyAtApproval, "GBP");
  assert.equal(t.reviewedById, admin.userId);
  // A later rate change does not rewrite history.
  await db.user.update({ where: { id: member.userId }, data: { hourlyRateMinor: 9999 } });
  assert.equal((await db.timesheet.findUniqueOrThrow({ where: { id } })).rateMinorAtApproval, 2000);
  assert.equal((await api(admin, `/api/timesheets/${id}`, { method: "PATCH", body: { action: "approve" } })).status, 409, "already reviewed");
  assert.equal((await api(member, "/api/timesheets", { body: { workDate: today, minutes: 30 } })).status, 409, "approved days are final");

  // Reject -> correct -> resubmit.
  const day2 = addDays(today, -1);
  const s2 = await api(member, "/api/timesheets", { body: { workDate: day2, minutes: 120 } });
  assert.equal((await api(admin, `/api/timesheets/${s2.json.timesheet.id}`, { method: "PATCH", body: { action: "reject", reviewNote: "Too long" } })).status, 200);
  const re = await api(member, "/api/timesheets", { body: { workDate: day2, minutes: 60 } });
  assert.equal(re.status, 200);
  assert.equal(re.json.timesheet.status, "submitted");
  assert.equal(re.json.timesheet.reviewNote, null);
  assert.equal(await db.timesheet.count({ where: { userId: member.userId, workDate: new Date(`${day2}T00:00:00.000Z`) } }), 1, "one sheet per day");

  // Nobody reviews their own timesheet, even a Super Admin.
  const own = await api(admin, "/api/timesheets", { body: { workDate: today, minutes: 60 } });
  assert.equal(own.status, 200);
  assert.equal((await api(admin, `/api/timesheets/${own.json.timesheet.id}`, { method: "PATCH", body: { action: "approve" } })).status, 403);
  const sup = await sessionFor("SUPER_ADMIN");
  await db.user.update({ where: { id: sup.userId }, data: { hourlyRateMinor: null } });
  const supOwn = await api(sup, "/api/timesheets", { body: { workDate: today, minutes: 60 } });
  assert.equal((await api(sup, `/api/timesheets/${supOwn.json.timesheet.id}`, { method: "PATCH", body: { action: "approve" } })).status, 403);

  // The review queue page shows claimed time and the (separate) recorded session figure.
  const html = await (await page(admin, "/admin/timesheets")).text();
  assert.match(html, /Recorded evidence that day/);
  assert.match(html, /Waiting for review/);
  assert.ok(await db.activityLog.findFirst({ where: { userId: admin.userId, action: "timesheet_approved" } }));
});

// ---------------------------------------------------------------- the screens render with real data
test("Staff directory, profile and activity pages render for a Super Admin with real data and valid filters", async () => {
  const sup = await sessionFor("SUPER_ADMIN");
  const staff = await sessionFor("USER");
  await api(staff, "/api/companies/search", { body: { filter: group("AND", rule("status", "equals", "active")), pageSize: 1 } });
  const row = await db.user.findUniqueOrThrow({ where: { id: staff.userId } });

  const dir = await (await page(sup, `/admin/staff?q=${encodeURIComponent(row.email)}`)).text();
  assert.match(dir, /Staff accounts/);
  assert.match(dir, new RegExp(row.email.replace(/\./g, "\\.")));
  const filtered = await (await page(sup, "/admin/staff?role=SUPER_ADMIN&status=active&signedIn=1&page=1")).text();
  assert.match(filtered, /Staff accounts/);
  assert.equal((await page(sup, "/admin/staff?page=99999&role=%3Cscript%3E")).status, 200, "junk filters are ignored, not errors");

  const profile = await (await page(sup, `/admin/staff/${staff.userId}?period=week&cat=companies`)).text();
  assert.match(profile, /Activity timeline/);
  assert.match(profile, /Searched/);
  assert.match(profile, /Recorded actions per day/);
  assert.match(profile, /not verified working time/);
  const bad = await (await page(sup, `/admin/staff/${staff.userId}?period=custom&from=2026-10-05&to=2026-10-01`)).text();
  assert.match(bad, /end date is before the start date/);
  assert.equal((await page(sup, "/admin/staff/does-not-exist")).status, 404);

  const act = await (await page(sup, "/admin/activity?period=month")).text();
  assert.match(act, /Staff comparison/);
  assert.match(act, /Download CSV/);
  assert.equal((await page(sup, "/admin/activity?period=banana&anchor=nonsense")).status, 200);

  // The existing Super Admin screens are untouched and still reachable.
  assert.equal((await page(sup, "/admin")).status, 200);
  assert.equal((await page(sup, "/admin/columns")).status, 200);
  assert.equal((await page(sup, "/users")).status, 200);
  const user = await sessionFor("USER");
  assert.equal((await page(user, "/admin")).status, 307);
  assert.equal((await page(user, "/users")).status, 307);
});
