import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { BASE, createUser, db, group, makeCompany, rule, sessionFor, STRONG_PASSWORD } from "./helpers";
import { api } from "./helpers";
import { findChrome, launchPage, type BrowserPage } from "../support/browser";
import { appTimezone, dayKey } from "../../src/lib/staff/periods";

// Real-browser checks: the production build, the real login form, real clicks, three roles. Skipped when Chrome is not
// installed. Screenshots land in tests/.browser-output (git-ignored) for eyeballing layout.

after(async () => {
  await db.$disconnect();
});

const chrome = findChrome();
const OUT = path.resolve("tests/.browser-output");
const uniq = () => Math.random().toString(36).slice(2, 8);

async function clickText(p: BrowserPage, text: string, scope = "button, a") {
  await p.waitFor(`[...document.querySelectorAll(${JSON.stringify(scope)})].some(e => e.textContent.trim().startsWith(${JSON.stringify(text)}))`);
  await p.eval(`[...document.querySelectorAll(${JSON.stringify(scope)})].find(e => e.textContent.trim().startsWith(${JSON.stringify(text)})).click()`);
}
const bodyText = (p: BrowserPage) => p.eval<string>("document.body.innerText");
const navLabels = (p: BrowserPage) => p.eval<string[]>(`[...document.querySelectorAll('nav[aria-label="Primary"] a')].map(a => a.textContent.trim())`);
const overflows = (p: BrowserPage) => p.eval<boolean>("document.documentElement.scrollWidth > window.innerWidth + 1");

async function uiLogin(p: BrowserPage, email: string) {
  await p.goto(`${BASE}/login`);
  await p.type('input[type="email"]', email);
  await p.type('input[type="password"]', STRONG_PASSWORD);
  await clickText(p, "Sign in", "button");
  await p.waitFor(`location.pathname !== "/login"`);
  await p.waitFor(`document.readyState === "complete"`);
}
// The header's sign-out button submits a plain form. The production CSP (upgrade-insecure-requests + form-action 'self')
// makes Chrome refuse that submission when the production build is served over plain http://127.0.0.1 as it is here
// (it is fine over https and in dev), so the same POST is sent with fetch and the page is reloaded.
async function uiLogout(p: BrowserPage) {
  await p.eval(`fetch("/api/auth/logout", { method: "POST", redirect: "manual" }).then(() => true)`);
  await p.goto(`${BASE}/login`);
  await p.waitFor(`location.pathname === "/login"`, 15_000);
}

test("Super Admin, supervisor and staff flows work in a real browser", { skip: chrome ? false : "Chrome is not installed", timeout: 240_000 }, async () => {
  const tag = uniq();
  const sup = await createUser("SUPER_ADMIN", `bsup${tag}`);
  const admin = await createUser("ADMIN", `badm${tag}`);
  const member = await createUser("USER", `bmem${tag}`);
  const basic = await createUser("USER", `bbas${tag}`);
  const stranger = await createUser("USER", `bstr${tag}`);
  await db.user.update({ where: { id: member.id }, data: { managerId: admin.id, hourlyRateMinor: 2000 } });
  await db.user.update({ where: { id: basic.id }, data: { permissions: JSON.stringify(["companies.view"]) } });
  const company = await makeCompany({ name: `BROWSER ${tag} LTD`, status: "active" });
  const today = dayKey(new Date(), appTimezone());

  // Some recorded history for the member (through the real API, so it is attributed to a real session).
  const ms = await sessionFor("USER", `bhist${tag}`);
  await db.user.update({ where: { id: ms.userId }, data: { managerId: admin.id, name: `History ${tag}` } });
  await api(ms, "/api/companies/search", { body: { filter: group("AND", rule("name", "startsWith", "BROWSER")), pageSize: 5 } });
  await api(ms, `/api/companies/${company.id}/notes`, { body: { body: "first note" } });
  await api(ms, `/api/companies/${company.id}/contact-log`, { body: { channel: "call", outcome: "reached" } });

  const page = await launchPage(9340 + Math.floor(Math.random() * 400));
  try {
    await page.setViewport(1440, 900);

    // ---- Login screen states what is recorded
    await page.goto(`${BASE}/login`);
    assert.match(await bodyText(page), /Activity is recorded/);
    assert.match(await bodyText(page), /does not record your password, keystrokes, screen/);
    await page.screenshot(path.join(OUT, "01-login.png"));

    // ---- Super Admin
    await uiLogin(page, sup.email);
    const supNav = await navLabels(page);
    assert.ok(supNav.includes("Super Admin") && supNav.includes("Users"));
    assert.ok(!supNav.includes("Team"), "Super Admin reaches staff pages through the Super Admin tabs");
    assert.ok(await db.userSession.findFirst({ where: { userId: sup.id, endedAt: null } }), "UI login created a session");

    // Existing Super Admin dashboard still intact, with the new tabs.
    await page.goto(`${BASE}/admin`);
    const adminText = await bodyText(page);
    assert.match(adminText, /System-wide oversight/);
    assert.match(adminText, /Activity across all users/);
    for (const tab of ["Overview", "Staff", "Activity & reports", "Timesheets", "Column & Default Settings"]) assert.ok(adminText.includes(tab), `tab ${tab}`);
    await page.goto(`${BASE}/admin/columns`);
    assert.match(await bodyText(page), /Column settings/);

    // Create an account with chosen permissions through the real form.
    await page.goto(`${BASE}/users`);
    await page.type('input:not([type]), input[type="text"]', ""); // focus noop (keeps ordering explicit below)
    const inputs = await page.eval<number>(`document.querySelectorAll('section input, form input, input').length`);
    assert.ok(inputs > 3);
    const newEmail = `ui.created.${tag}@test.example`;
    // Fields in order: name, email, temporary password.
    await page.eval(`(() => { const f = [...document.querySelectorAll('input')].filter(i => i.type === "text" || i.type === "email" || i.type === "password"); f[0].dataset.t = "name"; f[1].dataset.t = "email"; f[2].dataset.t = "pw"; })()`);
    await page.type('input[data-t="name"]', "UI Created");
    await page.type('input[data-t="email"]', newEmail);
    await page.type('input[data-t="pw"]', STRONG_PASSWORD);
    assert.equal(await page.eval<boolean>(`document.querySelector('input[data-permission="reports.exportCsv"]').checked`), false, "exports are off by default");
    assert.equal(await page.eval<boolean>(`document.querySelector('input[data-permission="companies.view"]').checked`), true);
    assert.equal(await page.eval<boolean>(`!!document.querySelector('input[data-permission="staff.manage"]')`), false, "administration keys are hidden for a plain user");
    await page.click('input[data-permission="reports.exportCsv"]');
    await page.screenshot(path.join(OUT, "02-create-user.png"), true);
    await clickText(page, "Create user", "button");
    await page.waitFor(`document.body.innerText.includes("${newEmail}")`);
    const created = await db.user.findUniqueOrThrow({ where: { email: newEmail } });
    const perms = JSON.parse(created.permissions!) as string[];
    assert.ok(perms.includes("reports.exportCsv") && perms.includes("reports.viewOwn"));
    assert.ok(!perms.includes("companies.directors") && !perms.includes("reports.viewOthers"));
    // Switching the form role to Admin reveals the administration permissions.
    await page.eval(`(() => { const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value === "ADMIN")); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, "ADMIN"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await page.waitFor(`document.querySelector('input[data-permission="staff.manage"]')`);

    // Staff directory (searched, as a person would on a large team: the directory is paged)
    await page.goto(`${BASE}/admin/staff?q=${tag}`);
    let text = await bodyText(page);
    assert.match(text, /staff accounts/i);
    assert.match(text, new RegExp(`History ${tag}`));
    assert.match(text, /Recently active|No logout recorded|Idle/);
    await page.screenshot(path.join(OUT, "03-staff-directory.png"), true);

    // Staff profile: sessions, timeline, permissions editor.
    await page.goto(`${BASE}/admin/staff/${ms.userId}`);
    text = await bodyText(page);
    assert.match(text, /Activity timeline/);
    assert.match(text, /Searched/);
    assert.match(text, /Added a note/);
    assert.match(text, /Logged a call \(reached\)/);
    assert.match(text, /contacts logged/i);
    assert.match(text, /not verified working time/i);
    await page.screenshot(path.join(OUT, "04-staff-profile.png"), true);
    // This account uses the legacy role default (everything a user had before permissions), so Share starts ticked.
    assert.equal(await page.eval<boolean>(`document.querySelector('input[data-permission="reports.share"]').checked`), true);
    await page.click('input[data-permission="reports.share"]');
    await clickText(page, "Save permissions", "button");
    await page.waitFor(`document.body.innerText.includes("Permissions saved.")`);
    const saved = JSON.parse((await db.user.findUniqueOrThrow({ where: { id: ms.userId } })).permissions!) as string[];
    assert.ok(!saved.includes("reports.share"), "the unticked permission was revoked");
    assert.ok(saved.includes("reports.exportCsv") && saved.includes("companies.view"), "everything else was kept");
    const audit = await db.activityLog.findFirstOrThrow({ where: { userId: sup.id, action: "permissions_changed" }, orderBy: { createdAt: "desc" } });
    assert.deepEqual(JSON.parse(audit.meta!).revokedKeys, ["reports.share"]);

    // Activity & reports: the period controls work and the comparison table lists the person.
    await page.goto(`${BASE}/admin/activity?period=day&anchor=${today}`);
    text = await bodyText(page);
    assert.match(text, /Staff comparison/);
    assert.match(text, new RegExp(`History ${tag}`));
    await page.screenshot(path.join(OUT, "05-activity.png"), true);
    await page.goto(`${BASE}/admin/activity?period=custom&from=2026-10-05&to=2026-10-01`);
    assert.match(await bodyText(page), /end date is before the start date/);

    await uiLogout(page);

    // ---- Restricted user: the interface only offers what the permissions allow.
    await uiLogin(page, basic.email);
    const basicNav = await navLabels(page);
    assert.ok(basicNav.includes("UK Companies"));
    for (const hidden of ["Report Builder", "Saved Reports", "Calendar", "My work", "Advanced Search", "Watches", "Users", "Super Admin", "Team"]) assert.ok(!basicNav.includes(hidden), `${hidden} is hidden`);
    assert.equal(await page.eval<boolean>(`!![...document.querySelectorAll("a")].find(a => a.textContent.includes("Create report"))`), false);
    await page.goto(`${BASE}/admin/staff`);
    assert.ok((await page.eval<string>("location.pathname")).startsWith("/dashboard"), "blocked URL sends them away");
    await page.goto(`${BASE}/settings`);
    assert.match(await bodyText(page), /What you can do/);
    assert.match(await bodyText(page), /Activity is recorded/);
    await uiLogout(page);

    // ---- Staff member: record a contact, finish assigned work, submit hours.
    await db.assignment.create({ data: { companyId: company.id, assigneeId: member.id, assignedById: admin.id, dueDate: new Date(`${today}T00:00:00.000Z`), note: "Please call" } });
    await uiLogin(page, member.email);
    const memberNav = await navLabels(page);
    assert.ok(memberNav.includes("My work") && memberNav.includes("Calendar"));
    await page.goto(`${BASE}/companies/${company.id}`);
    await page.waitFor(`document.body.innerText.includes("Assigned to you by")`);
    await page.waitFor(`document.body.innerText.includes("Contact log")`);
    await page.eval(`(() => { const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value === "no_answer")); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, "no_answer"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await clickText(page, "Record contact", "button");
    await page.waitFor(`document.body.innerText.includes("Phone call · No answer")`);
    assert.equal(await db.contactLog.count({ where: { userId: member.id, outcome: "no_answer" } }), 1);
    await page.screenshot(path.join(OUT, "07-company-contact-log.png"), true);

    await page.goto(`${BASE}/work`);
    assert.match(await bodyText(page), new RegExp(`BROWSER ${tag} LTD`));
    await clickText(page, "Mark complete", "button");
    await page.waitFor(`document.body.innerText.includes("Recently completed")`);
    assert.equal((await db.assignment.findFirstOrThrow({ where: { assigneeId: member.id } })).status, "done");

    await page.goto(`${BASE}/work/timesheets`);
    await page.eval(`(() => { const f = [...document.querySelectorAll('input')].filter(i => i.getAttribute("inputmode") === "numeric"); f[0].dataset.t = "h"; })()`);
    await page.type('input[data-t="h"]', "2");
    await clickText(page, "Submit", "button");
    await page.waitFor(`document.body.innerText.includes("Submitted for approval.")`);
    const sheet = await db.timesheet.findFirstOrThrow({ where: { userId: member.id } });
    assert.equal(sheet.submittedMinutes, 120);
    assert.equal(sheet.status, "submitted");
    assert.equal(sheet.approvedMinutes, null);
    await page.screenshot(path.join(OUT, "08-my-timesheets.png"), true);
    await page.goto(`${BASE}/admin/staff`);
    assert.ok((await page.eval<string>("location.pathname")).startsWith("/dashboard"), "staff cannot open the directory");
    await uiLogout(page);

    // ---- Supervisor: sees the team, approves the hours, cannot see outsiders.
    await uiLogin(page, admin.email);
    const adminNav = await navLabels(page);
    assert.ok(adminNav.includes("Team") && adminNav.includes("Users") && !adminNav.includes("Super Admin"));
    await page.goto(`${BASE}/admin/staff`);
    text = await bodyText(page);
    assert.match(text, new RegExp(member.name));
    assert.ok(!text.includes(stranger.name) || !text.includes(stranger.email), "outsiders are not listed");
    assert.ok(!text.includes(stranger.email));
    await page.goto(`${BASE}/admin/staff/${stranger.id}`);
    assert.match(await bodyText(page), /could not be found|404/i);

    await page.goto(`${BASE}/admin/timesheets`);
    await page.waitFor(`document.body.innerText.includes("Waiting for review (1)")`);
    assert.match(await bodyText(page), /recorded evidence that day/i);
    await page.screenshot(path.join(OUT, "09-timesheets-review.png"), true);
    await clickText(page, "Approve", "button");
    await page.waitFor(`document.body.innerText.includes("Waiting for review (0)")`);
    const approved = await db.timesheet.findUniqueOrThrow({ where: { id: sheet.id } });
    assert.equal(approved.status, "approved");
    assert.equal(approved.approvedMinutes, 120);
    assert.equal(approved.rateMinorAtApproval, 2000);
    await page.waitFor(`document.body.innerText.includes("£40.00")`);

    // Supervisor can assign work from the profile; the form validates and the server enforces scope.
    await page.goto(`${BASE}/admin/staff/${member.id}`);
    await page.eval(`(() => { const i = [...document.querySelectorAll('input')].find(x => x.placeholder === "e.g. 09711298"); i.dataset.t = "cn"; })()`);
    await page.type('input[data-t="cn"]', company.companyNumber);
    await clickText(page, "Assign", "button");
    await page.waitFor(`document.body.innerText.includes("Assigned.")`);
    assert.equal(await db.assignment.count({ where: { assigneeId: member.id, status: "open" } }), 1);

    // Narrow screens: nothing spills sideways (supervisor view of every new screen).
    await page.setViewport(390, 844, true);
    for (const p of ["/admin/staff", `/admin/staff/${member.id}`, "/admin/activity", "/users", "/admin/timesheets"]) {
      await page.goto(`${BASE}${p}`);
      assert.equal(await overflows(page), false, `${p} must not scroll horizontally at 390px`);
    }
    await page.screenshot(path.join(OUT, "06-mobile-activity.png"));
    await page.goto(`${BASE}/admin/staff/${member.id}`);
    await page.screenshot(path.join(OUT, "06b-mobile-profile.png"), true);
  } finally {
    await page.close();
  }
});
