// Disposable local PostgreSQL for development and tests (no Docker needed).
//   npm run db:dev                 -> start/keep running a dev server on :5433 (Ctrl+C to stop)
//   DEV_PG_DIR=... DEV_PG_PORT=... -> isolate a scratch cluster (used by the test suites)
// Data lives in ./.pgdata (gitignored). This is NOT the production database.
import EmbeddedPostgres from "embedded-postgres";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.env.DEV_PG_DIR ?? ".pgdata");
const port = Number(process.env.DEV_PG_PORT ?? 5433);
const user = process.env.DEV_PG_USER ?? "director";
const password = process.env.DEV_PG_PASSWORD ?? "director_dev_local";
const databases = (process.env.DEV_PG_DATABASES ?? "director").split(",");

async function main() {
  const fresh = !fs.existsSync(path.join(dir, "PG_VERSION"));
  const pg = new EmbeddedPostgres({ databaseDir: dir, user, password, port, persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"] });
  if (fresh) await pg.initialise();
  await pg.start();
  for (const name of databases) {
    try {
      await pg.createDatabase(name);
    } catch {
      /* already exists */
    }
  }
  console.log(`PostgreSQL ready on 127.0.0.1:${port} (dir ${dir}) databases: ${databases.join(", ")}`);
  const stop = async () => {
    console.log("Stopping PostgreSQL...");
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  setInterval(() => {}, 1 << 30); // keep the process alive
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
