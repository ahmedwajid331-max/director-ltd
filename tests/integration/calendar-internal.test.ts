import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { BASE, api, createUser, db, login, makeCompany, sessionFor, STRONG_PASSWORD, type Session } from "./helpers";
import { appTimezone, dayKey } from "../../src/lib/staff/periods";
import { findChrome, launchPage } from "../support/browser";

// The INTERNAL calendar: follow-ups and assigned work, their dates and statuses, who may see and change them, and that it
// all works with no Google / Microsoft / OAuth configuration at all (the :3211 server has none).
// Scratch database only.

after(async () => {
  await db.$disconnect();
});

const todayKey = dayKey(new Date(), appTimezone());
const dayOffset = (n: number) => new Date(Date.parse(`${todayKey}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const calendarOf = async (s: Session) => {
  const r = await api(s, "/api/followups");
  assert.equal(r.status, 200, r.text);
  return r.json as {
    followUps: { id: string; dueDate: string; note: string | null; done: boolean; companyId: string; companyName: string }[];
    assignments: { id: string; dueDate: string; note: string | null; done: boolean; companyId: string; companyName: string; assignedBy: string }[];
  };
};
const addFollowUp = (s: Session, companyId: string, dueDate: string, note?: string) => api(s, `/api/companies/${companyId}/followups`, { body: { dueDate, note } });

async function userWithPermissions(permissions: string[]): Promise<Session> {
  const user = await createUser("USER", "calperm");
  await db.user.update({ where: { id: user.id }, data: { permissions: JSON.stringify(permissions) } });
  const r = await login(user.email, STRONG_PASSWORD);
  return { cookie: r.cookie!, userId: user.id, email: user.email };
}

test("follow-ups: create, list with the right date and status data, complete, reopen, delete only when completed - all without Google", async () => {
  const me = await sessionFor("USER", "calfu");
  const other = await sessionFor("USER", "calfu2");
  const company = await makeCompany({ name: "CAL FOLLOWUP TEST LTD" });

  const created = await addFollowUp(me, company.id, dayOffset(3), "ring the director");
  assert.equal(created.status, 200, created.text);
  const id = created.json.followUp.id as string;

  const mine = await calendarOf(me);
  const f = mine.followUps.find((x) => x.id === id)!;
  assert.ok(f, "appears in the calendar");
  assert.equal(f.dueDate.slice(0, 10), dayOffset(3), "the date is exactly the one chosen");
  assert.equal(f.note, "ring the director");
  assert.equal(f.companyName, "CAL FOLLOWUP TEST LTD");
  assert.equal(f.done, false);
  assert.deepEqual(mine.assignments, [], "no assigned work for this user");

  // Not Google-dependent: the follow-up lives in the app's own calendar, no external connection was needed or created.
  assert.equal(await db.calendarConnection.count({ where: { userId: me.userId, provider: "GOOGLE" } }), 0);
  assert.equal((await db.calendarEvent.findUnique({ where: { followUpId: id } }))?.provider, "INTERNAL");

  // another user sees none of it and cannot touch it
  assert.equal((await calendarOf(other)).followUps.some((x) => x.id === id), false);
  assert.equal((await api(other, `/api/followups/${id}`, { method: "PATCH", body: { done: true } })).status, 404);
  assert.equal((await api(other, `/api/followups/${id}`, { method: "DELETE" })).status, 404);
  assert.equal((await api(null, "/api/followups")).status, 401);

  // an open follow-up cannot be deleted; complete it, reopen it, complete it again
  assert.equal((await api(me, `/api/followups/${id}`, { method: "DELETE" })).status, 409);
  assert.equal((await api(me, `/api/followups/${id}`, { method: "PATCH", body: { done: true } })).status, 200);
  assert.equal((await calendarOf(me)).followUps.find((x) => x.id === id)!.done, true);
  assert.equal((await api(me, `/api/followups/${id}`, { method: "PATCH", body: { done: false } })).status, 200);
  assert.equal((await calendarOf(me)).followUps.find((x) => x.id === id)!.done, false);
  await api(me, `/api/followups/${id}`, { method: "PATCH", body: { done: true } });

  // the activity trail records create / complete / reopen
  const actions = (await db.activityLog.findMany({ where: { userId: me.userId, companyId: company.id } })).map((a) => a.action);
  for (const a of ["followup_created", "followup_done", "followup_reopened"]) assert.ok(actions.includes(a), a);

  // completed -> deletable; the follow-up is gone, the company and its other data are not
  assert.equal((await api(me, `/api/followups/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await calendarOf(me)).followUps.some((x) => x.id === id), false);
  assert.ok(await db.company.findUnique({ where: { id: company.id } }));
  assert.equal((await api(me, `/api/followups/${id}`, { method: "DELETE" })).status, 404, "already deleted");

  // "Clear completed" removes only this user's completed follow-ups and never open ones
  const a = (await addFollowUp(me, company.id, dayOffset(1))).json.followUp.id as string;
  const b = (await addFollowUp(me, company.id, dayOffset(2))).json.followUp.id as string;
  const o = (await addFollowUp(other, company.id, dayOffset(2))).json.followUp.id as string;
  await api(me, `/api/followups/${a}`, { method: "PATCH", body: { done: true } });
  await api(other, `/api/followups/${o}`, { method: "PATCH", body: { done: true } });
  const cleared = await api(me, "/api/followups", { method: "DELETE" });
  assert.equal(cleared.status, 200);
  assert.deepEqual((await calendarOf(me)).followUps.map((x) => x.id), [b], "only the open one is left");
  assert.equal((await calendarOf(other)).followUps.some((x) => x.id === o), true, "another user's completed follow-up untouched");
});

test("access: the calendar needs the calendar permission; invalid dates are refused", async () => {
  const noCal = await userWithPermissions(["companies.view", "crm.notes"]);
  assert.equal((await api(noCal, "/api/followups")).status, 403);
  const me = await sessionFor("USER", "calval");
  const company = await makeCompany();
  for (const bad of ["2026-02-30", "tomorrow", "2026-13-01", ""]) assert.equal((await addFollowUp(me, company.id, bad)).status, 400, bad);
});

test("assigned work appears on the assignee's calendar only, with its due date and status, and completing it updates both views", async () => {
  const boss = await sessionFor("SUPER_ADMIN", "calboss");
  const worker = await sessionFor("USER", "calwork");
  const bystander = await sessionFor("USER", "calby");
  const c1 = await makeCompany({ name: "ASSIGNED ONE LTD" });
  const c2 = await makeCompany({ name: "ASSIGNED TWO LTD" });
  const c3 = await makeCompany({ name: "ASSIGNED NO DATE LTD" });
  const c4 = await makeCompany({ name: "ASSIGNED CANCELLED LTD" });
  const c5 = await makeCompany({ name: "ASSIGNED LONG AGO LTD" });
  const assign = async (companyId: string, dueDate?: string, note?: string) => {
    const r = await api(boss, "/api/assignments", { body: { companyId, assigneeId: worker.userId, dueDate, note } });
    assert.equal(r.status, 200, r.text);
    return r.json.assignment.id as string;
  };
  const overdueId = await assign(c1.id, dayOffset(-2), "call back");
  const soonId = await assign(c2.id, dayOffset(4));
  await assign(c3.id); // no due date: cannot be placed on a calendar
  const cancelledId = await assign(c4.id, dayOffset(5));
  const oldId = await assign(c5.id, dayOffset(-300));
  assert.equal((await api(boss, `/api/assignments/${cancelledId}`, { method: "PATCH", body: { action: "cancel" } })).status, 200);
  assert.equal((await api(worker, `/api/assignments/${oldId}`, { method: "PATCH", body: { action: "complete" } })).status, 200);
  await db.assignment.update({ where: { id: oldId }, data: { completedAt: new Date(Date.now() - 200 * 86_400_000) } }); // completed long ago

  const cal = await calendarOf(worker);
  assert.deepEqual(cal.assignments.map((a) => a.companyName).sort(), ["ASSIGNED ONE LTD", "ASSIGNED TWO LTD"], "open + dated only: not undated, cancelled, or completed long ago");
  const one = cal.assignments.find((a) => a.id === overdueId)!;
  assert.equal(one.dueDate.slice(0, 10), dayOffset(-2));
  assert.equal(one.done, false);
  assert.equal(one.note, "call back");
  assert.match(one.assignedBy, /calboss/);

  // nobody else sees it - not a bystander, not even the person who assigned it
  assert.deepEqual((await calendarOf(bystander)).assignments, []);
  assert.deepEqual((await calendarOf(boss)).assignments, []);

  // the assignee completes it (existing endpoint): it shows as done on the calendar and leaves My work's open list
  assert.equal((await api(bystander, `/api/assignments/${soonId}`, { method: "PATCH", body: { action: "complete" } })).status, 404, "a bystander cannot complete it");
  assert.equal((await api(worker, `/api/assignments/${soonId}`, { method: "PATCH", body: { action: "complete" } })).status, 200);
  assert.equal((await calendarOf(worker)).assignments.find((a) => a.id === soonId)!.done, true);
  assert.equal((await api(worker, `/api/assignments/${soonId}`, { method: "PATCH", body: { action: "complete" } })).status, 409, "already closed");
  assert.equal((await api(worker, `/api/assignments/${overdueId}`, { method: "PATCH", body: { action: "cancel" } })).status, 403, "the assignee cannot cancel open work");
  assert.equal((await db.assignment.findUniqueOrThrow({ where: { id: overdueId } })).status, "open", "so it is still open");
  assert.equal((await db.assignment.findUniqueOrThrow({ where: { id: soonId } })).status, "done");

  // someone who may no longer receive assigned work does not get it on the calendar
  const restricted = await userWithPermissions(["companies.view", "calendar.use"]);
  await db.assignment.create({ data: { companyId: c1.id, assigneeId: restricted.userId, assignedById: boss.userId, dueDate: new Date(`${dayOffset(2)}T00:00:00Z`) } });
  assert.deepEqual((await calendarOf(restricted)).assignments, []);
});

// ---- the calendar page, in a real browser ------------------------------------------------------------------------------------
const chrome = findChrome();
test("Calendar page: follow-ups and assigned work together, correct status chips and counts, completing assigned work, delete only for follow-ups", { skip: chrome ? false : "Chrome is not installed", timeout: 240_000 }, async () => {
  const boss = await sessionFor("SUPER_ADMIN", "calbossui");
  const worker = await sessionFor("USER", "calworkui");
  const company = await makeCompany({ name: "UIFOLLOW CO LTD" });
  const aCompany = await makeCompany({ name: "UIASSIGNED CO LTD" });
  const bCompany = await makeCompany({ name: "UIASSIGNED LATE CO LTD" });
  await addFollowUp(worker, company.id, dayOffset(-1), "late follow-up"); // overdue
  const doneFu = (await addFollowUp(worker, company.id, dayOffset(0), "done follow-up")).json.followUp.id as string;
  await api(worker, `/api/followups/${doneFu}`, { method: "PATCH", body: { done: true } });
  await addFollowUp(worker, company.id, dayOffset(0), "due today"); // upcoming (today is not overdue)
  assert.equal((await api(boss, "/api/assignments", { body: { companyId: aCompany.id, assigneeId: worker.userId, dueDate: dayOffset(3) } })).status, 200);
  assert.equal((await api(boss, "/api/assignments", { body: { companyId: bCompany.id, assigneeId: worker.userId, dueDate: dayOffset(-3) } })).status, 200);

  const page = await launchPage(9336);
  const text = () => page.eval<string>(`document.body.innerText`);
  try {
    await page.setViewport(1440, 1000);
    const me = await db.user.findUniqueOrThrow({ where: { id: worker.userId } });
    await page.goto(`${BASE}/login`);
    await page.type('input[type="email"]', me.email);
    await page.type('input[type="password"]', STRONG_PASSWORD);
    await page.eval(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Sign in")).click()`);
    await page.waitFor(`location.pathname !== "/login"`);
    await page.goto(`${BASE}/calendar`);
    await page.waitFor(`document.body.innerText.includes("Calendar & follow-ups")`);

    // hero chips: overdue = 1 follow-up + 1 assigned; upcoming = "due today" + 1 assigned
    assert.match(await text(), /Overdue:\s*2/);
    assert.match(await text(), /Upcoming:\s*2/);

    await page.eval(`[...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-controls") === "calendar-workspace").click()`);
    await page.waitFor(`document.body.innerText.includes("UIASSIGNED CO LTD")`, 30_000);
    const section = (title: string) => `[...document.querySelectorAll("section")].find((s) => s.querySelector("h3") && s.querySelector("h3").textContent.trim().toUpperCase() === "${title.toUpperCase()}")`;
    const names = (title: string) => page.eval<string[]>(`[...(${section(title)}).querySelectorAll("li a")].map((a) => a.textContent.trim())`);
    assert.deepEqual((await names("Overdue")).sort(), ["UIASSIGNED LATE CO LTD", "UIFOLLOW CO LTD"], "overdue holds one follow-up and one assignment");
    assert.deepEqual((await names("Upcoming")).sort(), ["UIASSIGNED CO LTD", "UIFOLLOW CO LTD"]);
    assert.deepEqual(await names("Completed"), ["UIFOLLOW CO LTD"], "the completed follow-up");
    assert.equal(await page.eval<number>(`[...document.querySelectorAll("li span")].filter((s) => s.textContent.trim() === "Assigned").length`), 2, "assigned work is tagged");

    await page.eval(`window.scrollTo(0, 0)`);
    await page.screenshot(path.join(process.env.SCREENSHOT_DIR ?? path.join(os.tmpdir(), "dl-calendar-shots"), "calendar-with-assigned-work.png"));

    // completing assigned work from the calendar: moves to Completed, cannot be reopened or deleted there
    await page.eval(`(${section("Upcoming")}).querySelectorAll("li").forEach((li) => { if (li.innerText.includes("UIASSIGNED CO LTD")) li.querySelector('button[aria-label="Mark as done"]').click(); })`);
    await page.waitFor(`(${section("Completed")}) && [...(${section("Completed")}).querySelectorAll("li a")].some((a) => a.textContent.trim() === "UIASSIGNED CO LTD")`, 20_000);
    // The screen updates at once; the save follows. Wait for the server to agree (and stay agreed: a failed save would revert the row).
    let saved = "open";
    for (let i = 0; i < 40 && saved !== "done"; i++) {
      saved = (await db.assignment.findFirstOrThrow({ where: { companyId: aCompany.id, assigneeId: worker.userId } })).status;
      if (saved !== "done") await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(saved, "done", "saved on the server");
    assert.deepEqual((await names("Completed")).sort(), ["UIASSIGNED CO LTD", "UIFOLLOW CO LTD"], "and the row stayed in Completed");
    const completedRow = `[...(${section("Completed")}).querySelectorAll("li")].find((li) => li.innerText.includes("UIASSIGNED CO LTD"))`;
    assert.equal(await page.eval<boolean>(`(${completedRow}).querySelector('button[aria-label="Completed"]').disabled`), true, "no reopen for assigned work");
    assert.equal(await page.eval<number>(`(${completedRow}).querySelectorAll('button[aria-label^="Delete"]').length`), 0, "no delete for assigned work");
    assert.equal(await page.eval<number>(`[...(${section("Completed")}).querySelectorAll("li")].find((li) => li.innerText.includes("UIFOLLOW")).querySelectorAll('button[aria-label^="Delete"]').length`), 1, "completed follow-ups still can be deleted");

    // "Clear completed" counts and removes only follow-ups
    await page.eval(`[...(${section("Completed")}).querySelectorAll("button")].find((b) => b.textContent.trim() === "Clear completed").click()`);
    await page.waitFor(`document.body.innerText.includes("Delete all 1 completed follow-up?")`);
    assert.match(await text(), /Pending follow-ups and assigned work are not affected/);
    await page.eval(`[...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.trim() === "Delete").click()`);
    await page.waitFor(`!document.body.innerText.includes("Delete all 1 completed")`);
    assert.equal(await db.followUp.count({ where: { userId: worker.userId, done: true } }), 0);
    assert.equal(await db.assignment.count({ where: { assigneeId: worker.userId, status: "done" } }), 1, "the completed assignment is untouched");
    await page.waitFor(`[...(${section("Completed")}).querySelectorAll("li a")].map((a) => a.textContent.trim()).join() === "UIASSIGNED CO LTD"`);
  } finally {
    await page.close();
  }
});
