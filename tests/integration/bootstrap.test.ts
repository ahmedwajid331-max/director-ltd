// Tests for `npm run admin:bootstrap`. Runs ONLY against the isolated scratch database provisioned by
// scripts/test-integration.ts (the import below refuses anything else).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import bcrypt from "bcryptjs";
import { db } from "./helpers"; // first import of helpers = scratch-database guard

const PASSWORD = "Zx9-Kite-Marble-Orbit-417!";
const SCRIPT = path.resolve("scripts/bootstrap-super-admin.ts");
const TSX = path.resolve("node_modules/tsx/dist/cli.mjs");

function run(lines: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, SCRIPT], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
    child.stdin.end(lines.join("\n") + "\n");
  });
}

const answers = (email: string, password = PASSWORD, confirm = password, go = "y", name = "Nick") => [email, name, password, confirm, go];

const counts = async () => ({
  users: await db.user.count(),
  companies: await db.company.count(),
  directors: await db.director.count(),
  reports: await db.report.count(),
  states: await db.userCompanyState.count(),
  notes: await db.note.count(),
  followUps: await db.followUp.count(),
  contacts: await db.crmContact.count(),
  calendar: await db.calendarEvent.count(),
  calendarConns: await db.calendarConnection.count(),
  activity: await db.activityLog.count(),
});

async function wipe() {
  await db.user.deleteMany(); // scratch database only (guarded)
  await db.company.deleteMany();
}

before(wipe);
after(async () => {
  await wipe();
  await db.$disconnect();
});

test("I. invalid email is rejected and nothing is created", async () => {
  for (const bad of ["", "not-an-email", "a@", "@b.com", "a b@c.com"]) {
    const r = await run(answers(bad));
    assert.equal(r.code, 1, bad);
    assert.match(r.out, /valid email/i);
    assert.ok(!r.out.includes(PASSWORD));
  }
  assert.equal(await db.user.count(), 0);
});

test("G. weak passwords are rejected (existing application policy) and nothing is created", async () => {
  for (const weak of ["12345678", "password", "Password123", "short1!", "aaaaaaaaaaaa"]) {
    const r = await run(answers("nick@example.com", weak));
    assert.equal(r.code, 1, weak);
    assert.match(r.out, /Password rejected/);
    if (weak !== "password") assert.ok(!r.out.includes(weak), "weak password not echoed"); // "password" itself is an ordinary word in the message text
  }
  assert.equal(await db.user.count(), 0);
});

test("H. a confirmation mismatch is rejected and nothing is created", async () => {
  const r = await run(answers("nick@example.com", PASSWORD, PASSWORD + "x"));
  assert.equal(r.code, 1);
  assert.match(r.out, /do not match/);
  assert.ok(!r.out.includes(PASSWORD));
  assert.equal(await db.user.count(), 0);
});

test("declining the y/N confirmation creates nothing", async () => {
  const r = await run(answers("nick@example.com", PASSWORD, PASSWORD, "n"));
  assert.equal(r.code, 2);
  assert.match(r.out, /Cancelled/);
  assert.equal(await db.user.count(), 0);
});

test("A/C/D/E/J. empty database: creates exactly one Super Admin and nothing else; password hashed, never printed", async () => {
  const before = await counts();
  assert.equal(before.users, 0);

  const r = await run(answers("  Nick.Owner@Example.COM  "));
  assert.equal(r.code, 0, r.out);

  // The target is shown before anything is created, and never with credentials.
  assert.match(r.out, /Target database: 127\.0\.0\.1:5434\/director_test/);
  assert.doesNotMatch(r.out, /director_test_local/);
  assert.ok(!r.out.includes(PASSWORD), "J: password never appears in output");

  const after = await counts();
  assert.deepEqual(after, { ...before, users: 1 }, "only one User row; zero companies, directors, reports, CRM, notes, follow-ups, calendar rows");
  assert.equal(after.companies, 0); // C
  assert.equal(after.reports + after.states + after.notes + after.followUps + after.contacts + after.calendar + after.calendarConns, 0); // D

  const user = await db.user.findFirstOrThrow();
  assert.equal(user.role, "SUPER_ADMIN");
  assert.equal(user.active, true);
  assert.equal(user.email, "nick.owner@example.com", "normalised like the login route (trim + lower-case)");
  assert.equal(user.name, "Nick");

  // E: stored as a bcrypt hash only.
  assert.notEqual(user.passwordHash, PASSWORD);
  assert.ok(!user.passwordHash.includes(PASSWORD));
  assert.match(user.passwordHash, /^\$2[aby]\$\d{2}\$/);
  assert.equal(await bcrypt.compare(PASSWORD, user.passwordHash), true);
});

test("the bootstrapped Super Admin can actually sign in", async () => {
  const res = await fetch(`${process.env.TEST_BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "NICK.OWNER@example.com", password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie") ?? "", /director_session=/);
});

test("B/F. a second run refuses, and the existing Super Admin is not modified, downgraded or deactivated", async () => {
  const original = await db.user.findFirstOrThrow({ where: { role: "SUPER_ADMIN" } });
  const before = await counts();

  for (const email of ["another.admin@example.com", "nick.owner@example.com"]) {
    const r = await run(answers(email, "Another-Str0ng-Passphrase-99!"));
    assert.equal(r.code, 1, email);
    assert.match(r.out, /A Super Admin already exists/);
    assert.ok(!r.out.includes("Another-Str0ng-Passphrase-99!") && !r.out.includes(PASSWORD));
  }

  const now = await db.user.findUniqueOrThrow({ where: { id: original.id } });
  assert.deepEqual(now, original, "existing Super Admin row is byte-for-byte unchanged (hash, role, active, name, email)");
  assert.deepEqual(await counts(), before);
  assert.equal(await db.user.count({ where: { role: "SUPER_ADMIN" } }), 1);
});

test("F2. even a DEACTIVATED Super Admin blocks bootstrap and stays untouched", async () => {
  const sa = await db.user.findFirstOrThrow({ where: { role: "SUPER_ADMIN" } });
  await db.user.update({ where: { id: sa.id }, data: { active: false } });
  const r = await run(answers("third@example.com"));
  assert.equal(r.code, 1);
  assert.match(r.out, /already exists/);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: sa.id } })).active, false, "not re-activated either");
  assert.equal(await db.user.count(), 1);
});

test("an existing non-Super-Admin user with that email is left untouched when no Super Admin exists", async () => {
  await wipe();
  const hash = await bcrypt.hash("Some-Existing-Passw0rd!", 4);
  const existing = await db.user.create({ data: { email: "taken@example.com", name: "Taken", passwordHash: hash, role: "USER" } });
  const r = await run(answers("taken@example.com"));
  assert.equal(r.code, 1);
  assert.match(r.out, /already exists/);
  assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: existing.id } }), existing);
  assert.equal(await db.user.count({ where: { role: "SUPER_ADMIN" } }), 0);
});

test("two simultaneous bootstraps create exactly one Super Admin", async () => {
  await wipe();
  const [a, b] = await Promise.all([run(answers("race.a@example.com")), run(answers("race.b@example.com"))]);
  assert.deepEqual([a.code, b.code].sort(), [0, 1]);
  assert.equal(await db.user.count({ where: { role: "SUPER_ADMIN" } }), 1);
  assert.equal(await db.user.count(), 1);
});

test("no public bootstrap endpoint exists", async () => {
  for (const p of ["/api/bootstrap", "/api/admin/bootstrap", "/bootstrap"]) {
    const res = await fetch(`${process.env.TEST_BASE_URL}${p}`, { method: "POST", redirect: "manual" });
    assert.ok([404, 307, 308].includes(res.status), `${p} -> ${res.status}`);
  }
});
