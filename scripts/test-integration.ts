// Integration test runner (isolated scratch PostgreSQL + production build of the app).
//   npm run build && npm run test:integration
// - starts a throwaway PostgreSQL cluster in ./.pgdata-test on port 5434 (no Docker)
// - applies the real migrations, then runs tests/integration/*.test.ts
// - starts two app servers from the production build:
//     :3211  seed data visible, export cap for USER = 50 rows
//     :3212  seed data hidden (production-like)
// Never touches the development database.
import EmbeddedPostgres from "embedded-postgres";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(".pgdata-test");
const port = 5434;
const dbUrl = `postgresql://director:director_test_local@127.0.0.1:${port}/director_test?schema=public`;
const isWin = process.platform === "win32";

async function waitForHttp(url: string, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not start: ${url}`);
}

function startServer(p: number, extraEnv: Record<string, string>): ChildProcess {
  const child = spawn(isWin ? "npx.cmd" : "npx", ["next", "start", "-p", String(p)], {
    env: { ...process.env, ...extraEnv, DATABASE_URL: dbUrl, PORT: String(p) },
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWin,
  });
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", (d) => process.stderr.write(`[server ${p}] ${d}`));
  return child;
}

async function main() {
  if (!fs.existsSync(".next/BUILD_ID")) throw new Error("Run `npm run build` first (the integration suite tests the production build).");
  fs.rmSync(dir, { recursive: true, force: true });

  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "director", password: "director_test_local", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"] });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("director_test");

  const servers: ChildProcess[] = [];
  let exitCode = 1;
  try {
    const mig = spawnSync(isWin ? "npx.cmd" : "npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "inherit", shell: isWin });
    if (mig.status !== 0) throw new Error("migrate deploy failed");

    const authSecret = randomBytes(48).toString("base64url");
    const common = { AUTH_SECRET: authSecret, TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("hex"), TRUST_PROXY: "1" };
    servers.push(startServer(3211, { ...common, SEED_DATA_VISIBLE: "true", EXPORT_MAX_ROWS_USER: "50", EXPORT_MAX_ROWS_ADMIN: "500" }));
    servers.push(startServer(3212, { ...common, SEED_DATA_VISIBLE: "false" }));
    await Promise.all([waitForHttp("http://127.0.0.1:3211/login"), waitForHttp("http://127.0.0.1:3212/login")]);

    const files = fs.readdirSync("tests/integration").filter((f) => f.endsWith(".test.ts")).map((f) => path.join("tests/integration", f));
    const only = process.argv[2];
    const run = spawnSync(isWin ? "npx.cmd" : "npx", ["tsx", "--test", "--test-concurrency=1", ...(only ? files.filter((f) => f.includes(only)) : files)], {
      env: { ...process.env, DATABASE_URL: dbUrl, TEST_BASE_URL: "http://127.0.0.1:3211", TEST_BASE_URL_PROD: "http://127.0.0.1:3212", ...common },
      stdio: "inherit",
      shell: isWin,
    });
    exitCode = run.status ?? 1;
  } finally {
    for (const s of servers) {
      if (isWin && s.pid) spawnSync("taskkill", ["/pid", String(s.pid), "/T", "/F"], { stdio: "ignore" });
      else s.kill();
    }
    await pg.stop().catch(() => {});
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
