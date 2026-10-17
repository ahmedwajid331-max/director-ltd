// Verifies REAL DS01 stream events already captured in the dev database end to end:
//   stream event -> company identified -> DB updated -> hasDS01 -> DS01 report filter finds it (through the real HTTP API).
//   1. npm run ch:stream -- --max-seconds 900     (captures live events)
//   2. npm run build && npx next start -p 3100    (in another terminal)
//   3. DEV_LOGIN_EMAIL=... DEV_LOGIN_PASSWORD=... npx tsx tests/live/ds01-live-verify.ts
import "../support/require-scratch-db"; // must stay first: only run against a scratch/test database
import { db } from "../../src/lib/db";

const BASE = process.env.VERIFY_BASE ?? "http://127.0.0.1:3100";

async function main() {
  const email = process.env.DEV_LOGIN_EMAIL;
  const password = process.env.DEV_LOGIN_PASSWORD;
  if (!email || !password) throw new Error("Set DEV_LOGIN_EMAIL and DEV_LOGIN_PASSWORD (a development user)");
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  const cookie = login.headers.get("set-cookie")?.match(/director_session=([^;]+)/)?.[1];
  if (!cookie) throw new Error(`login failed: ${login.status}`);
  const search = async (filter: unknown) => {
    const r = await fetch(`${BASE}/api/companies/search`, { method: "POST", headers: { "content-type": "application/json", cookie: `director_session=${cookie}` }, body: JSON.stringify({ filter, pageSize: 100 }) });
    return (await r.json()) as { total: number; rows: { companyNumber: string; hasDS01: boolean }[] };
  };
  const rule = (field: string, operator: string, value?: unknown) => ({ id: "r", kind: "rule", field, operator, ...(value !== undefined ? { value } : {}) });
  const group = (...children: unknown[]) => ({ id: "g", kind: "group", combinator: "AND", children });

  const events = await db.filingEvent.findMany({ where: { type: { in: ["DS01", "DS02"] } }, orderBy: { processedAt: "asc" } });
  console.log(`Captured DS01/DS02 stream events: ${events.length} (DS01: ${events.filter((e) => e.type === "DS01").length})`);

  let pass = 0;
  let fail = 0;
  // Latest event per company decides the expected state (DS01 => true, a later DS02 => false).
  const lastByCompany = new Map<string, (typeof events)[number]>();
  for (const e of events) lastByCompany.set(e.companyNumber, e);

  for (const e of events.filter((x) => x.type === "DS01")) {
    const c = await db.company.findUnique({ where: { companyNumber: e.companyNumber } });
    const latest = lastByCompany.get(e.companyNumber)!;
    const expectTrue = latest.type === "DS01" || c?.statusDetail === "active-proposal-to-strike-off";
    const inDb = !!c && e.applyStatus === "applied" && e.companyId === c.id && c.hasDS01 === expectTrue && (!expectTrue || c.ds01FiledAt !== null);
    const found = await search(group(rule("companyNumber", "equals", e.companyNumber), rule("hasDS01", "isTrue")));
    const inReport = expectTrue ? found.total === 1 : found.total === 0;
    const ok = inDb && inReport;
    if (ok) pass++;
    else fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  DS01 ${e.companyNumber} date=${e.date} tx=${e.transactionId.slice(0, 12)}…  applied=${e.applyStatus} db.hasDS01=${c?.hasDS01} ds01FiledAt=${c?.ds01FiledAt?.toISOString().slice(0, 10)} reportFinds=${found.total === 1}`);
  }
  for (const e of events.filter((x) => x.type === "DS02")) {
    const c = await db.company.findUnique({ where: { companyNumber: e.companyNumber } });
    console.log(`INFO  DS02 ${e.companyNumber}: applied=${e.applyStatus} hasDS01=${c?.hasDS01}`);
  }
  const dbCount = await db.company.count({ where: { hasDS01: true, source: { not: "seed" } } });
  const all = await search(group(rule("hasDS01", "isTrue"), rule("name", "contains", "")));
  console.log(`Real companies with hasDS01 in DB: ${dbCount}; DS01 report (API, seed visible in dev) total: ${all.total}`);
  console.log(fail === 0 && pass > 0 ? `LIVE DS01 CHECK: PASS (${pass} real DS01 events)` : `LIVE DS01 CHECK: FAIL (${fail} failing, ${pass} passing)`);
  await db.$disconnect();
  process.exit(fail === 0 && pass > 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
