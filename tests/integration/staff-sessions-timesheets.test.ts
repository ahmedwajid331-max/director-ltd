import { test } from "node:test";
import assert from "node:assert/strict";
import { api, BASE, createUser, db, login, sessionFor, type Session } from "./helpers";
import { addDays, appTimezone, dayKey } from "../../src/lib/staff/periods";

const page = (s: Session | null, path: string) => fetch(`${BASE}${path}`, { headers: s ? { cookie: `director_session=${s.cookie}` } : {}, redirect: "manual" });
const signOut = (cookie: string) => fetch(`${BASE}/api/auth/logout`, { method: "POST", headers: { cookie: `director_session=${cookie}` }, redirect: "manual" });

// ---------------------------------------------------------------- session lifecycle (root cause of the 4h19m session)
test("Sessions: each sign-in is a new session; sign-out closes the right one once and never counts as 'last seen'", async () => {
  const user = await createUser("USER", "life");
  const a = await login(user.email); // a normal window
  const b = await login(user.email); // an Incognito window at the same time
  assert.ok(a.cookie && b.cookie);
  const rows = await db.userSession.findMany({ where: { userId: user.id }, orderBy: { startedAt: "asc" } });
  assert.equal(rows.length, 2, "two sign-ins, two sessions");
  assert.notEqual(rows[0].id, rows[1].id);
  assert.ok(Math.abs(rows[1].startedAt.getTime() - Date.now()) < 60_000, "a new login starts now, not at an earlier session's start");

  // Age session A so a later touch would be visible, then sign it out.
  const old = new Date(Date.now() - 3 * 3_600_000);
  await db.userSession.update({ where: { id: rows[0].id }, data: { startedAt: old, lastActivityAt: old } });
  const first = await db.userSession.findMany({ where: { userId: user.id } });
  const aRow = first.find((r) => r.startedAt.getTime() === old.getTime())!;
  const bRow = first.find((r) => r.id !== aRow.id)!;
  // Which cookie belongs to which row does not matter for the test: sign out the cookie whose session is the aged one.
  const cookies = [a.cookie!, b.cookie!];
  const aCookie = cookies[rows[0].id === aRow.id ? 0 : 1];
  const bCookie = cookies[rows[0].id === aRow.id ? 1 : 0];

  assert.equal((await signOut(aCookie)).status, 303);
  const closed = await db.userSession.findUniqueOrThrow({ where: { id: aRow.id } });
  assert.ok(closed.endedAt && closed.endReason === "logout");
  assert.equal(closed.lastActivityAt.getTime(), old.getTime(), "the sign-out request is not recorded as the last time the person was seen");
  assert.equal((await db.userSession.findUniqueOrThrow({ where: { id: bRow.id } })).endedAt, null, "the other window's session is untouched");

  // Repeating the sign-out (stale cookie, or three at once) changes nothing and records nothing new.
  await signOut(aCookie);
  await Promise.all([1, 2, 3].map(() => signOut(bCookie)));
  assert.equal(await db.activityLog.count({ where: { userId: user.id, action: "logout" } }), 2, "exactly one logout event per session, even for concurrent requests");
  assert.equal((await db.userSession.findUniqueOrThrow({ where: { id: closed.id } })).endedAt!.getTime(), closed.endedAt!.getTime(), "end time is not rewritten");

  // Signing in again starts a fresh session with a fresh start time.
  const c = await login(user.email);
  assert.ok(c.cookie);
  const latest = await db.userSession.findFirstOrThrow({ where: { userId: user.id }, orderBy: { startedAt: "desc" } });
  assert.equal(latest.endedAt, null);
  assert.ok(Math.abs(latest.startedAt.getTime() - Date.now()) < 60_000);
});

test("Sessions: an administrator ending sessions is audited; an abandoned session is not given a made-up end", async () => {
  const sup = await sessionFor("SUPER_ADMIN");
  const user = await createUser("USER", "abandon");
  const r = await login(user.email);
  assert.ok(r.cookie);
  const quiet = new Date(Date.now() - 4 * 3_600_000);
  const s = await db.userSession.findFirstOrThrow({ where: { userId: user.id } });
  await db.userSession.update({ where: { id: s.id }, data: { startedAt: quiet, lastActivityAt: quiet } });
  const ended = await api(sup, `/api/users/${user.id}/end-sessions`, { body: {} });
  assert.equal(ended.json.ended, 1);
  const after = await db.userSession.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(after.endReason, "admin_ended");
  assert.equal(after.lastActivityAt.getTime(), quiet.getTime(), "last seen is preserved as evidence");
  assert.ok(await db.activityLog.findFirst({ where: { userId: sup.userId, action: "session_ended_by_admin" } }));
  const stale = await api({ cookie: r.cookie!, userId: user.id, email: user.email }, "/api/timesheets", { body: { workDate: dayKey(new Date(), appTimezone()), minutes: 60 } });
  assert.equal(stale.status, 401, "the revoked cookie stops working");
});

// ---------------------------------------------------------------- timesheet corrections, duplicates, payroll
test("Timesheets: duplicate submit, return for correction, amend keeps rate and audit trail, only approved hours are priced", async () => {
  const today = dayKey(new Date(), appTimezone());
  const admin = await sessionFor("ADMIN");
  const member = await sessionFor("USER");
  await db.user.update({ where: { id: member.userId }, data: { managerId: admin.userId, hourlyRateMinor: 2000, rateCurrency: "GBP" } });
  const patch = (s: Session, id: string, body: unknown) => api(s, `/api/timesheets/${id}`, { method: "PATCH", body });

  const first = await api(member, "/api/timesheets", { body: { workDate: today, minutes: 600 } });
  assert.equal(first.status, 200, first.text);
  const id = first.json.timesheet.id as string;
  assert.equal((await api(member, "/api/timesheets", { body: { workDate: today, minutes: 600 } })).status, 409, "identical resubmission is refused");
  const racing = await Promise.all([1, 2, 3].map(() => api(member, "/api/timesheets", { body: { workDate: addDays(today, -2), minutes: 90 } })));
  assert.equal(racing.filter((r) => r.status === 200).length, 1, "concurrent identical submissions create one sheet");
  assert.equal(await db.timesheet.count({ where: { userId: member.userId, workDate: new Date(`${addDays(today, -2)}T00:00:00.000Z`) } }), 1);

  // Return for correction: reason required, staff can fix and resubmit, nothing payable meanwhile.
  assert.equal((await patch(admin, id, { action: "return" })).status, 400);
  assert.equal((await patch(admin, id, { action: "return", reviewNote: "Include the lunch break" })).status, 200);
  assert.equal((await db.timesheet.findUniqueOrThrow({ where: { id } })).status, "returned");
  assert.equal((await patch(admin, id, { action: "amend", approvedMinutes: 100, reviewNote: "x" })).status, 409, "only approved sheets can be amended");
  const again = await api(member, "/api/timesheets", { body: { workDate: today, minutes: 540 } });
  assert.equal(again.status, 200);
  assert.equal(again.json.timesheet.status, "submitted");
  const resubmitEvent = await db.activityLog.findFirst({ where: { userId: member.userId, action: "timesheet_submitted", meta: { contains: "previousStatus" } } });
  assert.ok(resubmitEvent?.meta?.includes("returned"), "the audit trail remembers what it was before");

  // Approve 8h, then amend to 7h: same captured rate, reason mandatory, before/after audited.
  assert.equal((await patch(admin, id, { action: "approve", approvedMinutes: 480 })).status, 200);
  await db.user.update({ where: { id: member.userId }, data: { hourlyRateMinor: 3000 } });
  assert.equal((await patch(admin, id, { action: "amend", approvedMinutes: 420 })).status, 400, "amend needs a reason");
  assert.equal((await patch(member, id, { action: "amend", approvedMinutes: 420, reviewNote: "self" })).status, 403);
  assert.equal((await patch(admin, id, { action: "amend", approvedMinutes: 541, reviewNote: "too much" })).status, 400, "cannot exceed the claim");
  assert.equal((await patch(admin, id, { action: "amend", approvedMinutes: 420, reviewNote: "Long break" })).status, 200);
  const sheet = await db.timesheet.findUniqueOrThrow({ where: { id } });
  assert.equal(sheet.approvedMinutes, 420);
  assert.equal(sheet.rateMinorAtApproval, 2000, "amending does not re-price at the new rate");
  const amended = await db.activityLog.findFirst({ where: { userId: admin.userId, action: "timesheet_amended" } });
  assert.ok(amended?.meta?.includes('"fromMinutes":480') && amended.meta.includes('"toMinutes":420'));

  // A pending day never reaches pay: 7h x GBP 20 = GBP 140 on the estimate page, the 5h pending sheet is not priced.
  assert.equal((await api(member, "/api/timesheets", { body: { workDate: addDays(today, -3), minutes: 300 } })).status, 200);
  const html = await (await page(admin, `/admin/timesheets?period=custom&from=${addDays(today, -7)}&to=${today}`)).text();
  assert.match(html, /£140\.00/);
  assert.doesNotMatch(html, /£240\.00|£100\.00/, "pending hours are not priced");
});
