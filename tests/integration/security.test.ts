import { test, after } from "node:test";
import assert from "node:assert/strict";
import { BASE, STRONG_PASSWORD, api, createUser, db, group, login, makeCompany, rule, sessionFor } from "./helpers";

after(async () => {
  await db.$disconnect();
});

// ---- Super Admin protection -----------------------------------------------------
test("an Admin can NOT deactivate or demote a Super Admin (server-side)", async () => {
  const admin = await sessionFor("ADMIN");
  const sa = await createUser("SUPER_ADMIN");
  const r1 = await api(admin, `/api/users/${sa.id}`, { method: "PATCH", body: { active: false } });
  assert.equal(r1.status, 403);
  const r2 = await api(admin, `/api/users/${sa.id}`, { method: "PATCH", body: { role: "USER" } });
  assert.equal(r2.status, 403);
  const r3 = await api(admin, `/api/users/${sa.id}`, { method: "PATCH", body: { role: "ADMIN" } });
  assert.equal(r3.status, 403);
  const after = await db.user.findUniqueOrThrow({ where: { id: sa.id } });
  assert.equal(after.role, "SUPER_ADMIN");
  assert.equal(after.active, true);
});

test("an Admin can not modify another Admin or change any role, but can deactivate a plain User", async () => {
  const admin = await sessionFor("ADMIN");
  const otherAdmin = await createUser("ADMIN");
  const user = await createUser("USER");
  assert.equal((await api(admin, `/api/users/${otherAdmin.id}`, { method: "PATCH", body: { active: false } })).status, 403);
  assert.equal((await api(admin, `/api/users/${user.id}`, { method: "PATCH", body: { role: "ADMIN" } })).status, 403);
  assert.equal((await api(admin, `/api/users/${user.id}`, { method: "PATCH", body: { active: false } })).status, 200);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: user.id } })).active, false);
});

test("a Super Admin can manage users and other Super Admins, but not demote or deactivate themselves", async () => {
  const sa = await sessionFor("SUPER_ADMIN");
  const user = await createUser("USER");
  assert.equal((await api(sa, `/api/users/${user.id}`, { method: "PATCH", body: { role: "ADMIN" } })).status, 200);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: user.id } })).role, "ADMIN");
  const peer = await createUser("SUPER_ADMIN");
  assert.equal((await api(sa, `/api/users/${peer.id}`, { method: "PATCH", body: { active: false } })).status, 200);
  assert.equal((await api(sa, `/api/users/${sa.userId}`, { method: "PATCH", body: { active: false } })).status, 400);
  assert.equal((await api(sa, `/api/users/${sa.userId}`, { method: "PATCH", body: { role: "ADMIN" } })).status, 400);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: sa.userId } })).role, "SUPER_ADMIN");
});

test("unknown fields in a user update are rejected", async () => {
  const sa = await sessionFor("SUPER_ADMIN");
  const user = await createUser("USER");
  const r = await api(sa, `/api/users/${user.id}`, { method: "PATCH", body: { active: true, passwordHash: "x" } });
  assert.equal(r.status, 400);
});

// ---- Session revocation ------------------------------------------------------------
test("deactivating a user kills their existing session immediately", async () => {
  const user = await sessionFor("USER");
  assert.equal((await api(user, "/api/reports")).status, 200);
  await db.user.update({ where: { id: user.userId }, data: { active: false } });
  assert.equal((await api(user, "/api/reports")).status, 401);
  assert.equal((await api(user, "/api/companies/search", { body: {} })).status, 401);
  const page = await fetch(`${BASE}/dashboard`, { headers: { cookie: `director_session=${user.cookie}` }, redirect: "manual" });
  assert.equal(page.status, 307); // bounced to /login
});

test("a role change takes effect on the very next request (demotion and promotion)", async () => {
  const admin = await sessionFor("ADMIN");
  assert.equal((await api(admin, "/api/users")).status, 200);
  await db.user.update({ where: { id: admin.userId }, data: { role: "USER" } });
  assert.equal((await api(admin, "/api/users")).status, 403); // same cookie, now a USER
  const page = await fetch(`${BASE}/users`, { headers: { cookie: `director_session=${admin.cookie}` }, redirect: "manual" });
  assert.equal(page.status, 307);
  await db.user.update({ where: { id: admin.userId }, data: { role: "ADMIN" } });
  assert.equal((await api(admin, "/api/users")).status, 200);
});

test("a deleted user's cookie is rejected", async () => {
  const user = await sessionFor("USER");
  await db.user.delete({ where: { id: user.userId } });
  assert.equal((await api(user, "/api/reports")).status, 401);
});

test("a forged / tampered session cookie is rejected", async () => {
  const user = await sessionFor("USER");
  const parts = user.cookie.split(".");
  const tampered = { ...user, cookie: `${parts[0]}.${parts[1]}.${parts[2].slice(0, -3)}AAA` };
  assert.equal((await api(tampered, "/api/reports")).status, 401);
  assert.equal((await api({ ...user, cookie: "not-a-jwt" }, "/api/reports")).status, 401);
});

test("all protected APIs require a session", async () => {
  for (const [method, path] of [["GET", "/api/reports"], ["POST", "/api/companies/search"], ["POST", "/api/companies/export"], ["GET", "/api/users"], ["GET", "/api/followups"]] as const) {
    const r = await api(null, path, { method, body: method === "POST" ? {} : undefined });
    assert.ok([401, 403].includes(r.status), `${method} ${path} -> ${r.status}`);
  }
});

// ---- Login: rate limiting + generic errors ---------------------------------------------
test("login is throttled per account after repeated failures, with a generic message", async () => {
  const user = await createUser("USER", "rl");
  const ip = "203.0.113.77";
  const attempt = (email: string, password: string) =>
    fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ email, password }) });
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) statuses.push((await attempt(user.email, "wrong-password-x")).status);
  assert.deepEqual(statuses, Array(8).fill(401));
  const blocked = await attempt(user.email, "wrong-password-x");
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  // Even the CORRECT password is refused while locked out.
  assert.equal((await attempt(user.email, STRONG_PASSWORD)).status, 429);
  // A different account from the same IP is not locked by the per-account counter.
  const other = await createUser("USER", "rl2");
  assert.equal((await attempt(other.email, STRONG_PASSWORD)).status, 200);
  // The same account from a different IP is not locked out either.
  const elsewhere = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.78" }, body: JSON.stringify({ email: user.email, password: STRONG_PASSWORD }) });
  assert.equal(elsewhere.status, 200);
});

test("unknown email and wrong password give the identical response", async () => {
  const user = await createUser("USER", "enum");
  const wrongPw = await login(user.email, "definitely-wrong-1");
  const unknown = await login("nobody-here@test.example", "definitely-wrong-1");
  assert.equal(wrongPw.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrongPw.body, unknown.body);
  await db.user.update({ where: { id: user.id }, data: { active: false } });
  const deactivated = await login(user.email, STRONG_PASSWORD);
  assert.equal(deactivated.status, 401);
  assert.deepEqual(deactivated.body, unknown.body); // does not reveal "account disabled"
});

// ---- Password policy ---------------------------------------------------------------------
test("user creation enforces the password policy", async () => {
  const admin = await sessionFor("ADMIN");
  for (const pw of ["12345678", "password", "Password123", "short1!A"]) {
    const r = await api(admin, "/api/users", { body: { name: "W", email: `w.${Date.now()}.${pw.length}@test.example`, password: pw, role: "USER" } });
    assert.equal(r.status, 400, pw);
  }
  const ok = await api(admin, "/api/users", { body: { name: "Ok", email: `ok.${Date.now()}@test.example`, password: STRONG_PASSWORD, role: "USER" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.role, "USER");
  const escalate = await api(admin, "/api/users", { body: { name: "Esc", email: `esc.${Date.now()}@test.example`, password: STRONG_PASSWORD, role: "SUPER_ADMIN" } });
  assert.equal(escalate.status, 403);
});

// ---- Headers -------------------------------------------------------------------------------
test("security headers are present and X-Powered-By is gone", async () => {
  const res = await fetch(`${BASE}/login`);
  const h = res.headers;
  assert.match(h.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.match(h.get("content-security-policy") ?? "", /object-src 'none'/);
  assert.match(h.get("strict-transport-security") ?? "", /max-age=\d+/);
  assert.equal(h.get("x-frame-options"), "DENY");
  assert.equal(h.get("x-content-type-options"), "nosniff");
  assert.ok(h.get("referrer-policy"));
  assert.ok(h.get("permissions-policy"));
  assert.equal(h.get("x-powered-by"), null);
  const api401 = await fetch(`${BASE}/api/reports`);
  assert.equal(api401.headers.get("x-content-type-options"), "nosniff");
});

test("the login page no longer shows demo credentials", async () => {
  const html = await (await fetch(`${BASE}/login`)).text();
  assert.doesNotMatch(html, /DirectorAdmin123/);
  assert.doesNotMatch(html, /Demo credentials/i);
});

// ---- Export authorisation + CSV safety ---------------------------------------------------
test("a USER cannot export the whole register; a filtered export works; caps apply", async () => {
  const user = await sessionFor("USER");
  const admin = await sessionFor("ADMIN");
  const evil = await makeCompany({ name: "=HYPERLINK(\"http://evil.example\",\"click\")", registeredAddress1: "@cmd|calc", dormant: true, registeredPostcode: "EX1 1EX" });

  const all = await api(user, "/api/companies/export", { body: {} });
  assert.equal(all.status, 403);
  assert.equal((await api(user, "/api/companies/export", { body: { filter: group("AND") } })).status, 403); // empty rule set is still "everything"

  const filtered = await api(user, "/api/companies/export", { body: { filter: group("AND", rule("registeredPostcode", "startsWith", "EX1")) } });
  assert.equal(filtered.status, 200);
  assert.match(filtered.headers.get("content-type") ?? "", /text\/csv/);
  const lines = filtered.text.trim().split(/\r?\n/);
  assert.equal(lines[0].split(",")[0], "Company number");
  const evilLine = lines.find((l) => l.includes(evil.companyNumber));
  assert.ok(evilLine, "exported row present");
  assert.ok(evilLine!.includes("\"'=HYPERLINK") || evilLine!.includes(",'=HYPERLINK"), `formula neutralised: ${evilLine}`);
  assert.ok(!/(^|,)=HYPERLINK/.test(evilLine!), "no raw formula at cell start");
  assert.ok(evilLine!.includes("'@cmd|calc") && !/[,"]@cmd/.test(evilLine!), `address cell neutralised: ${evilLine}`);

  // Row cap (server started with EXPORT_MAX_ROWS_USER=50).
  const manyTag = `CAP${Date.now() % 100000}`;
  await db.company.createMany({
    data: Array.from({ length: 60 }, (_, i) => ({
      companyNumber: `${manyTag}${String(i).padStart(2, "0")}`.slice(0, 10), name: `CAPTEST ${manyTag} ${i}`, status: "active", type: "ltd",
      incorporationDate: new Date("2010-01-01T00:00:00Z"), registeredAddress1: "x", registeredCity: "y", registeredPostcode: "CAP 1AA", source: "bulk_import",
    })),
  });
  const capped = await api(user, "/api/companies/export", { body: { filter: group("AND", rule("registeredPostcode", "startsWith", "CAP 1")) } });
  assert.equal(capped.status, 413);
  assert.match(capped.json.error, /limit/i);
  // Admin cap is higher (500) so the same export succeeds for them, and is logged.
  const adminExport = await api(admin, "/api/companies/export", { body: { filter: group("AND", rule("registeredPostcode", "startsWith", "CAP 1")) } });
  assert.equal(adminExport.status, 200);
  assert.equal(adminExport.text.trim().split(/\r?\n/).length, 61);
  const logged = await db.activityLog.count({ where: { userId: admin.userId, action: "export_csv" } });
  assert.equal(logged, 1);
});

test("an invalid filter on export is a controlled 400", async () => {
  const user = await sessionFor("USER");
  const r = await api(user, "/api/companies/export", { body: { filter: group("AND", rule("passwordHash", "equals", "x")) } });
  assert.equal(r.status, 400);
});
