import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { assertScratchDatabase, evaluateDatabaseUrl } from "../support/scratch-db-guard";

const APP = "postgresql://postgres:secret@127.0.0.1:5432/director_ltd?schema=public";
const ok = (url: string | undefined) => evaluateDatabaseUrl(url, APP).ok;

test("A. the application database (director_ltd on 5432) is rejected", () => {
  assert.equal(ok(APP), false);
  assert.equal(ok("postgresql://u:p@localhost:5432/director_ltd"), false);
  assert.equal(ok("postgresql://u:p@127.0.0.1:5432/director_ltd?schema=public&sslmode=disable"), false);
  assert.match(evaluateDatabaseUrl(APP, APP).reason ?? "", /application\/system database/);
  assert.throws(() => assertScratchDatabase(APP, APP), /Refusing to run against the application database\. This test requires an isolated scratch\/test DATABASE_URL\./);
});

test("an unset DATABASE_URL is rejected (Prisma would fall back to .env)", () => {
  assert.equal(ok(undefined), false);
  assert.equal(ok(""), false);
  assert.match(evaluateDatabaseUrl(undefined, APP).reason ?? "", /not set explicitly/);
});

test("other unsafe targets are rejected", () => {
  assert.equal(ok("postgresql://u:p@127.0.0.1:5432/postgres"), false);
  assert.equal(ok("postgresql://u:p@127.0.0.1:5433/director"), false); // old embedded dev DB: no scratch marker
  assert.equal(ok("postgresql://u:p@127.0.0.1:5432/production"), false);
  assert.equal(ok("postgresql://u:p@127.0.0.1:5432/director_100k"), false); // not explicitly marked
  assert.equal(ok("postgresql://u:p@127.0.0.1:5432/contest"), false); // "test" only as a substring, not a token
  assert.equal(ok("postgresql://u:p@db.prod.example.com:5432/director_test"), false); // remote host
  assert.equal(ok("postgresql://u:p@rds.amazonaws.com/director_scratch"), false);
  assert.equal(ok("mysql://u:p@127.0.0.1/director_test"), false);
  assert.equal(ok("not a url"), false);
});

test("a database that IS the .env application database is rejected even if it is named like a test database", () => {
  const app = "postgresql://postgres:secret@127.0.0.1:5432/director_ltd_test";
  assert.equal(evaluateDatabaseUrl(app, app).ok, false);
  assert.match(evaluateDatabaseUrl(app, app).reason ?? "", /same database as DATABASE_URL in \.env/);
});

test("B. explicitly named scratch/test databases on a local host are allowed", () => {
  assert.equal(ok("postgresql://director:director_test_local@127.0.0.1:5434/director_test?schema=public"), true); // the official runner's URL
  assert.equal(ok("postgresql://u:p@127.0.0.1:5432/director_scratch_100k"), true); // even on 5432, if explicitly marked
  assert.equal(ok("postgresql://u:p@localhost:5432/scratch"), true);
  assert.equal(ok("postgresql://u:p@[::1]:5432/my-test-db"), true);
});

test("the guard's error/target text never contains the password", () => {
  const res = evaluateDatabaseUrl("postgresql://postgres:TopSecret123@127.0.0.1:5432/director_ltd", APP);
  assert.ok(!JSON.stringify(res).includes("TopSecret123"));
  try {
    assertScratchDatabase("postgresql://postgres:TopSecret123@127.0.0.1:5432/director_ltd", APP);
  } catch (e) {
    assert.ok(!String(e).includes("TopSecret123"));
  }
});

// ---- the guarded entry points really refuse, before any database is touched --------------------
function runGuardedImport(file: string, databaseUrl: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (databaseUrl === undefined) delete env.DATABASE_URL;
  else env.DATABASE_URL = databaseUrl;
  // Import only the guard module of the target file's own first line: run the
  // real file but with an unreachable URL, so even a guard failure could not write.
  return spawnSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), file], { env, encoding: "utf8", timeout: 60_000 });
}

test("acceptance/live scripts and integration files refuse an application-database URL (no DB access needed)", () => {
  // Port 1 is closed: if a guard were missing the script would fail to connect, never write.
  const appLike = "postgresql://postgres:x@127.0.0.1:1/director_ltd";
  for (const file of ["tests/acceptance/ingest-100k.ts", "tests/live/officers-live.ts", "tests/live/ds01-live-verify.ts", "tests/integration/security.test.ts"]) {
    const r = runGuardedImport(file, appLike);
    assert.notEqual(r.status, 0, file);
    assert.match(r.stderr + r.stdout, /Refusing to run against the application database\. This test requires an isolated scratch\/test DATABASE_URL\./, file);
  }
});
