import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { api, BASE, createUser, db, makeCompany, sessionFor, STRONG_PASSWORD } from "./helpers";
import { findChrome, launchPage, type BrowserPage } from "../support/browser";

// Real-browser audit pass: console errors on every screen for three roles, the ended-session redirect (which used to be
// able to loop), and the presence labels. Skipped when Chrome is not installed.

after(async () => {
  await db.$disconnect();
});

const chrome = findChrome();
const OUT = path.resolve("tests/.browser-output");
const uniq = () => Math.random().toString(36).slice(2, 8);
const bodyText = (p: BrowserPage) => p.eval<string>("document.body.innerText");

async function uiLogin(p: BrowserPage, email: string) {
  await p.goto(`${BASE}/login`);
  await p.type('input[type="email"]', email);
  await p.type('input[type="password"]', STRONG_PASSWORD);
  await p.eval(`[...document.querySelectorAll("button")].find(b => b.textContent.trim().startsWith("Sign in")).click()`);
  await p.waitFor(`location.pathname !== "/login"`);
  await p.waitFor(`document.readyState === "complete"`);
}
// See staff-browser.test.ts: the production CSP refuses the sign-out form over plain http, so the same POST goes via fetch.
async function uiLogout(p: BrowserPage) {
  await p.eval(`fetch("/api/auth/logout", { method: "POST", redirect: "manual" }).then(() => true)`);
  await p.goto(`${BASE}/login`);
}

async function sweep(p: BrowserPage, label: string, paths: string[], problems: string[]) {
  for (const route of paths) {
    const before = p.logs.length;
    await p.goto(`${BASE}${route}`);
    await new Promise((r) => setTimeout(r, 500));
    const where = await p.eval<string>("location.pathname");
    const text = await bodyText(p);
    const errors = p.logs.slice(before).filter((l) => !/favicon/i.test(l));
    if (/Internal Server Error|Application error|PrismaClient|Unhandled Runtime Error|This page couldn.t load/i.test(text)) problems.push(`${label} ${route}: error text on page`);
    if (errors.length) problems.push(`${label} ${route} (at ${where}): ${errors.join(" || ").slice(0, 300)}`);
  }
}

test("Browser audit: no console errors on any screen, ended sessions sign out cleanly, presence labels", { skip: chrome ? false : "Chrome is not installed", timeout: 300_000 }, async () => {
  const tag = uniq();
  const sup = await createUser("SUPER_ADMIN", `asup${tag}`);
  const admin = await createUser("ADMIN", `aadm${tag}`);
  const member = await createUser("USER", `amem${tag}`);
  const untracked = await createUser("USER", `aunt${tag}`);
  await createUser("USER", `anev${tag}`); // never signed in
  await db.user.update({ where: { id: member.id }, data: { managerId: admin.id } });
  await db.user.update({ where: { id: untracked.id }, data: { lastLoginAt: new Date(Date.now() - 3 * 86_400_000) } });
  const co = await makeCompany({ name: `AUDIT ${tag} LTD` });
  const adminSession = await sessionFor("ADMIN");
  await db.user.update({ where: { id: adminSession.userId }, data: { managerId: null } });

  const page = await launchPage(9740 + Math.floor(Math.random() * 200));
  const problems: string[] = [];
  try {
    await page.setViewport(1440, 900);

    // ---- Super Admin: every screen, plus the presence labels the directory must show
    await uiLogin(page, sup.email);
    const superPages = ["/dashboard", "/companies", "/companies/advanced", `/companies/${co.id}`, "/reports", "/reports/new", "/watches", "/saved", "/red-flags", "/trash", "/calendar", "/work", "/work/timesheets", "/users", "/settings", "/admin", "/admin/columns", "/admin/staff", `/admin/staff/${member.id}`, "/admin/activity", "/admin/activity?period=month", "/admin/activity?period=year", "/admin/activity?period=custom&from=2026-07-01&to=2026-07-31", "/admin/timesheets"];
    await sweep(page, "super", superPages, problems);

    await page.goto(`${BASE}/admin/staff?q=${tag}`);
    const dir = await bodyText(page);
    assert.match(dir, /No session recorded/, "signed in before tracking, no session row");
    assert.match(dir, /Never signed in/);
    assert.match(dir, /Recently active/, "the Super Admin's own live session");
    // The untracked row's badge explains itself.
    assert.ok(await page.eval<boolean>(`[...document.querySelectorAll("span[title]")].some(e => e.getAttribute("title").includes("before session tracking"))`));
    await page.screenshot(path.join(OUT, "10-presence-labels.png"));
    await uiLogout(page);

    // ---- Supervisor
    await uiLogin(page, admin.email);
    await sweep(page, "admin", ["/dashboard", "/companies", "/reports", "/work", "/users", "/settings", "/admin/staff", `/admin/staff/${member.id}`, "/admin/activity", "/admin/timesheets"], problems);
    await uiLogout(page);

    // ---- Staff member: and an administrator ends their session while the browser is open
    await uiLogin(page, member.email);
    await sweep(page, "member", ["/dashboard", "/companies", `/companies/${co.id}`, "/reports", "/reports/new", "/calendar", "/work", "/work/timesheets", "/settings"], problems);
    assert.equal(await page.eval<string>("location.pathname"), "/settings");
    const ended = await api(adminSession, `/api/users/${member.id}/end-sessions`, { method: "POST" });
    assert.equal(ended.status, 404, "an unrelated Admin cannot see, let alone end, someone else's session");
    await db.user.update({ where: { id: member.id }, data: { managerId: adminSession.userId } });
    assert.equal((await api(adminSession, `/api/users/${member.id}/end-sessions`, { method: "POST" })).status, 200);
    // The browser still holds a correctly signed cookie. It must land on the sign-in page, not loop.
    await page.goto(`${BASE}/dashboard`);
    await page.waitFor(`location.pathname === "/login"`, 15_000);
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(await page.eval<string>("location.pathname"), "/login", "stays on sign-in (no redirect loop)");
    await page.goto(`${BASE}/companies`);
    await page.waitFor(`location.pathname === "/login"`, 15_000);
    assert.match(await bodyText(page), /Sign in/i);
    await page.screenshot(path.join(OUT, "11-after-session-ended.png"));
    // And a fresh sign-in works straight away.
    await uiLogin(page, member.email);
    assert.ok((await page.eval<string>("location.pathname")).startsWith("/dashboard"));
    assert.equal(await db.userSession.count({ where: { userId: member.id, endReason: "admin_ended" } }), 1);
    assert.equal(await db.userSession.count({ where: { userId: member.id, endedAt: null } }), 1);
  } finally {
    await page.close();
  }
  assert.deepEqual(problems, [], `runtime problems found:\n${problems.join("\n")}`);
});
