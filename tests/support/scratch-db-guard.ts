import fs from "node:fs";
import path from "node:path";

// Safety guard for tests/scripts that WRITE data (acceptance, live and
// integration tests). They may only run against an explicitly isolated
// scratch/test database, never the application database.
//
// A DATABASE_URL is accepted only if ALL of these hold:
//   1. it is set explicitly in the environment (if it is unset, Prisma would
//      silently fall back to the application database named in .env);
//   2. the host is local (127.0.0.1, localhost, ::1);
//   3. the database name contains the token "test" or "scratch"
//      (separated by _ or -), e.g. director_test, director_scratch_100k;
//   4. the database name is not a known application/system database
//      (director_ltd, director, postgres, template0, template1);
//   5. it is not the same host:port/database as the DATABASE_URL in .env
//      (even if someone named the application database "..._test").

export const SCRATCH_TOKENS = ["test", "scratch"];
const PROTECTED_DATABASES = new Set(["director_ltd", "director", "postgres", "template0", "template1"]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface GuardResult {
  ok: boolean;
  target: string; // host:port/database - never includes credentials
  reason?: string;
}

function parse(url: string): { host: string; port: string; database: string } | null {
  try {
    const u = new URL(url);
    if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
    return { host: u.hostname.toLowerCase(), port: u.port || "5432", database: decodeURIComponent(u.pathname.replace(/^\//, "")).toLowerCase() };
  } catch {
    return null;
  }
}

export function readEnvFileDatabaseUrl(cwd: string = process.cwd()): string | null {
  try {
    const text = fs.readFileSync(path.join(cwd, ".env"), "utf8");
    const m = /^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m.exec(text);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function evaluateDatabaseUrl(url: string | undefined, appDatabaseUrl: string | null = readEnvFileDatabaseUrl()): GuardResult {
  if (!url) {
    return { ok: false, target: "(DATABASE_URL not set)", reason: "DATABASE_URL is not set explicitly, so Prisma would fall back to the application database in .env." };
  }
  const t = parse(url);
  if (!t) return { ok: false, target: "(unparseable)", reason: "DATABASE_URL is not a valid PostgreSQL URL." };
  const target = `${t.host}:${t.port}/${t.database}`;

  if (PROTECTED_DATABASES.has(t.database)) {
    return { ok: false, target, reason: `"${t.database}" is an application/system database.` };
  }
  if (!LOCAL_HOSTS.has(t.host)) {
    return { ok: false, target, reason: `host "${t.host}" is not local; scratch databases must be on 127.0.0.1/localhost.` };
  }
  const tokens = t.database.split(/[_-]/);
  if (!SCRATCH_TOKENS.some((s) => tokens.includes(s))) {
    return { ok: false, target, reason: `the database name must contain "test" or "scratch" (e.g. director_test, director_scratch_100k).` };
  }
  const app = appDatabaseUrl ? parse(appDatabaseUrl) : null;
  if (app && app.host === t.host && app.port === t.port && app.database === t.database) {
    return { ok: false, target, reason: "it is the same database as DATABASE_URL in .env (the application database)." };
  }
  return { ok: true, target };
}

export function assertScratchDatabase(url: string | undefined = process.env.DATABASE_URL, appDatabaseUrl?: string | null): string {
  const res = evaluateDatabaseUrl(url, appDatabaseUrl === undefined ? readEnvFileDatabaseUrl() : appDatabaseUrl);
  if (!res.ok) {
    throw new Error(
      `Refusing to run against the application database. This test requires an isolated scratch/test DATABASE_URL.\n` +
        `  Target: ${res.target}\n  Reason: ${res.reason}\n` +
        `  Use "npm run test:integration" (it provisions its own scratch database), or set DATABASE_URL to a local database whose name contains "test" or "scratch".`
    );
  }
  return res.target;
}
