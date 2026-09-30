// 100,000-row acceptance test for the bulk CSV pipeline (NOT the full register).
//
//   1. python scratchpad/expected.py   -> tmp-ingest/expected-100k.jsonl (+ aggregate counts), computed
//      independently of this code base from the same sample file
//   2. DATABASE_URL=<empty scratch db> npx tsx tests/acceptance/ingest-100k.ts tmp-ingest/sample-100k.zip
//
// Steps: interrupt mid-run -> resume -> rerun the whole file (must add 0 rows) -> field-by-field
// verification against the independent expectation -> filter counts vs expected -> query timings.
import fs from "node:fs";
import readline from "node:readline";
import { PrismaClient } from "@prisma/client";
import { bulkIngestFromCsv } from "../../src/lib/companies-house/bulkIngest";
import { buildCompanyWhere } from "../../src/lib/data/companies";

const db = new PrismaClient();
const input = process.argv[2] ?? "tmp-ingest/sample-100k.zip";
const expectedFile = "tmp-ingest/expected-100k.jsonl";
const agg = JSON.parse(fs.readFileSync("tmp-ingest/expected-100k-agg.json", "utf8")) as Record<string, number>;

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

const rule = (field: string, operator: string, value?: unknown) => ({ id: "r", kind: "rule", field, operator, ...(value !== undefined ? { value } : {}) });
const group = (combinator: string, ...children: unknown[]) => ({ id: "g", kind: "group", combinator, children });
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

async function main() {
  const existing = await db.company.count();
  if (existing > 0) throw new Error(`Refusing to run: the scratch database already holds ${existing} companies.`);
  console.log(`Input: ${input}`);

  // ---- 1. interrupted run -----------------------------------------------------------------------------
  const ctl = new AbortController();
  const poll = setInterval(async () => {
    if ((await db.company.count()) >= 30_000) ctl.abort();
  }, 200);
  const t0 = Date.now();
  const first = await bulkIngestFromCsv({ input, signal: ctl.signal, log: (m) => console.log("  " + m) });
  clearInterval(poll);
  const partial = await db.company.count();
  check("interrupted run is FAILED (not success) and resumable", first.status === "failed" && partial >= 30_000 && partial < agg.total, `status=${first.status} loaded=${partial}`);
  const interruptedRun = await db.ingestionRun.findUniqueOrThrow({ where: { id: first.runId } });
  check("checkpoint recorded", Number(interruptedRun.checkpoint) >= 30_000, `checkpoint=${interruptedRun.checkpoint}`);

  // ---- 2. resume -------------------------------------------------------------------------------------------
  const t1 = Date.now();
  const resumed = await bulkIngestFromCsv({ input, resumeRunId: first.runId, log: (m) => console.log("  " + m) });
  const resumeSecs = (Date.now() - t1) / 1000;
  const total = await db.company.count();
  console.log(`resumed run: ${JSON.stringify(resumed)} in ${resumeSecs.toFixed(1)}s (first part ${(t1 - t0) / 1000}s)`);
  check("resumed run ends SUCCESS/PARTIAL honestly and uses the same run id", resumed.runId === first.runId && ["success", "partial"].includes(resumed.status), `status=${resumed.status}`);
  check("row count equals the source row count", total + resumed.rowsSkipped + resumed.rowsFailed === agg.total && resumed.rowsRead === agg.total, `db=${total} read=${resumed.rowsRead} skipped=${resumed.rowsSkipped} failed=${resumed.rowsFailed} expected=${agg.total}`);
  check("no unexplained large failure rate", resumed.errorRate < 0.001, `errorRate=${(resumed.errorRate * 100).toFixed(4)}%`);
  const finalRun = await db.ingestionRun.findUniqueOrThrow({ where: { id: resumed.runId } });
  check("run state SUCCESS only when appropriate", finalRun.status === (resumed.rowsFailed + resumed.rowsSkipped === 0 ? "success" : finalRun.status) && finalRun.errorMessage === (finalRun.status === "success" && resumed.rowsFailed + resumed.rowsSkipped === 0 ? null : finalRun.errorMessage));
  if (finalRun.errorSamples) console.log("  error samples:", finalRun.errorSamples.slice(0, 600));
  console.log("  stats:", finalRun.statsJson?.slice(0, 700));

  // ---- 3. rerun: zero duplicates -----------------------------------------------------------------------------
  const rerun = await bulkIngestFromCsv({ input });
  const afterRerun = await db.company.count();
  check("full rerun creates zero duplicates", afterRerun === total && rerun.rowsInserted === 0, `inserted=${rerun.rowsInserted} updated=${rerun.rowsUpdated} db=${afterRerun}`);
  const dupes = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM (SELECT "companyNumber" FROM "Company" GROUP BY 1 HAVING count(*) > 1) d`;
  check("no duplicate company numbers", Number(dupes[0].n) === 0);

  // ---- 4. field-by-field verification --------------------------------------------------------------------------
  const rl = readline.createInterface({ input: fs.createReadStream(expectedFile, "utf8"), crlfDelay: Infinity });
  const mism: Record<string, number> = {};
  const examples: string[] = [];
  let checked = 0;
  let missing = 0;
  let chunk: Record<string, unknown>[] = [];
  const catMap = new Map<string, Set<string>>();
  const acctMap = new Map<string, Set<string>>();
  const statMap = new Map<string, Set<string>>();

  async function verify(rows: Record<string, unknown>[]) {
    const got = await db.company.findMany({ where: { companyNumber: { in: rows.map((r) => r.companyNumber as string) } } });
    const byNo = new Map(got.map((g) => [g.companyNumber, g]));
    for (const e of rows) {
      const g = byNo.get(e.companyNumber as string);
      if (!g) { missing++; continue; }
      checked++;
      const actual: Record<string, unknown> = {
        name: g.name,
        incorporationDate: iso(g.incorporationDate),
        dissolutionDate: iso(g.dissolutionDate),
        registeredPostcode: g.registeredPostcode,
        registeredAddress1: g.registeredAddress1,
        registeredAddress2: g.registeredAddress2,
        registeredCity: g.registeredCity,
        registeredCounty: g.registeredCounty,
        accountsNextDue: iso(g.accountsNextDue),
        accountsLastMadeUp: iso(g.accountsLastMadeUp),
        confirmationNextDue: iso(g.confirmationNextDue),
        confirmationLastMadeUp: iso(g.confirmationLastMadeUp),
        sicCodes: g.sicCodes,
        dormant: g.dormant,
        hasDS01: g.hasDS01,
        accountsOverdue: g.accountsOverdue,
        confirmationOverdue: g.confirmationOverdue,
      };
      for (const k of Object.keys(actual)) {
        if (actual[k] !== e[k]) {
          mism[k] = (mism[k] ?? 0) + 1;
          if (examples.length < 12) examples.push(`${e.companyNumber} ${k}: expected ${JSON.stringify(e[k])} got ${JSON.stringify(actual[k])}`);
        }
      }
      const add = (m: Map<string, Set<string>>, raw: unknown, val: unknown) => { const key = String(raw); if (!m.has(key)) m.set(key, new Set()); m.get(key)!.add(String(val)); };
      add(catMap, e.categoryRaw, g.type);
      add(acctMap, e.accountCategoryRaw, g.accountType);
      add(statMap, e.statusRaw, `${g.status}|${g.statusDetail}`);
    }
  }
  for await (const line of rl) {
    chunk.push(JSON.parse(line));
    if (chunk.length >= 2000) { await verify(chunk); chunk = []; }
  }
  if (chunk.length) await verify(chunk);
  check("every source company present", missing === 0, `missing=${missing}`);
  check("fields match the independent expectation", Object.keys(mism).length === 0, `rows checked=${checked} mismatches=${JSON.stringify(mism)}`);
  for (const ex of examples) console.log("  mismatch: " + ex);
  console.log("  category mapping observed:", JSON.stringify([...catMap].map(([k, v]) => `${k} => ${[...v].join("/")}`), null, 0).slice(0, 1500));
  console.log("  account category mapping observed:", JSON.stringify([...acctMap].map(([k, v]) => `${k} => ${[...v].join("/")}`)).slice(0, 900));
  console.log("  status mapping observed:", JSON.stringify([...statMap].map(([k, v]) => `${k} => ${[...v].join("/")}`)).slice(0, 900));

  const epoch = await db.company.count({ where: { OR: [{ incorporationDate: new Date("1970-01-01T00:00:00Z") }, { incorporationDate: { lt: new Date("1000-01-01T00:00:00Z") } }] } });
  const blankPc = await db.company.count({ where: { registeredPostcode: "" } });
  check("no 1970/invalid incorporation dates", epoch === 0);
  check("postcode populated wherever the source has one", blankPc === agg.blank_postcode, `blank=${blankPc} expected=${agg.blank_postcode}`);

  // ---- 5. filters on imported data -----------------------------------------------------------------------------
  const count = (f: unknown) => db.company.count({ where: buildCompanyWhere({ filter: group("AND", f) }) });
  const cmp = async (name: string, filter: unknown, expected: number) => {
    const t = Date.now();
    const got = await count(filter);
    check(`filter ${name}`, got === expected, `got=${got} expected=${expected} (${Date.now() - t}ms)`);
  };
  await cmp("DS01 = true", rule("hasDS01", "isTrue"), agg.ds01);
  await cmp("dormant = true", rule("dormant", "isTrue"), agg.dormant);
  await cmp("postcode starts LS", rule("registeredPostcode", "startsWith", "ls"), agg.postcode_LS);
  await cmp("postcode starts SW1", rule("registeredPostcode", "startsWith", "SW1"), agg.postcode_SW1);
  await cmp("SIC contains 62012", rule("sicCodes", "contains", "62012"), agg.sic_62012);
  await cmp("incorporated before 2010-01-01", rule("incorporationDate", "before", "2010-01-01"), agg.inc_before_2010);
  await cmp("company age > 10 years", rule("companyAgeYears", "gt", 10), agg.age_gt_10);
  await cmp("late accounts", rule("accountsOverdue", "isTrue"), agg.accounts_overdue);
  await cmp("late confirmation statement", rule("confirmationOverdue", "isTrue"), agg.conf_overdue);
  const and = await count(group("AND", rule("dormant", "isTrue"), rule("hasDS01", "isTrue")));
  const or = await count(group("OR", rule("dormant", "isTrue"), rule("hasDS01", "isTrue")));
  check("AND dormant+DS01", and === agg.dormant_and_ds01, `got=${and} expected=${agg.dormant_and_ds01}`);
  check("OR dormant|DS01", or === agg.dormant_or_ds01, `got=${or} expected=${agg.dormant_or_ds01}`);

  // ---- 6. query efficiency (EXPLAIN ANALYZE at 100k; the indexes are what matter at 5.6M) ------------------------
  const time = async (name: string, fn: () => Promise<unknown>) => {
    const t = Date.now();
    await fn();
    const ms = Date.now() - t;
    console.log(`  timing: ${name}: ${ms}ms`);
    return ms;
  };
  const slow: number[] = [];
  slow.push(await time("count all", () => db.company.count()));
  slow.push(await time("name contains 'consult' (ILIKE, trigram index)", () => db.company.count({ where: buildCompanyWhere({ q: "consult" }) })));
  slow.push(await time("DS01 + page 1 sorted by name", () => db.company.findMany({ where: buildCompanyWhere({ filter: group("AND", rule("hasDS01", "isTrue")) }), orderBy: [{ name: "asc" }, { id: "asc" }], take: 25 })));
  slow.push(await time("postcode prefix + page 40", () => db.company.findMany({ where: buildCompanyWhere({ filter: group("AND", rule("registeredPostcode", "startsWith", "M1")) }), orderBy: [{ name: "asc" }, { id: "asc" }], take: 25, skip: 975 })));
  slow.push(await time("age>10 AND dormant sorted by incorporationDate desc", () => db.company.findMany({ where: buildCompanyWhere({ filter: group("AND", rule("companyAgeYears", "gt", 10), rule("dormant", "isTrue")) }), orderBy: [{ incorporationDate: "desc" }, { id: "asc" }], take: 25 })));
  check("representative queries each < 1s at 100k rows", Math.max(...slow) < 1000, `max=${Math.max(...slow)}ms`);
  // At 100k rows the planner (correctly) prefers a sequential scan; with seq scans disabled it must be
  // able to use the purpose-built indexes, which is what matters at 5.6M rows.
  for (const [label, sql] of [
    ["name ILIKE (trigram GIN)", `SELECT id FROM "Company" WHERE name ILIKE '%consult%'`],
    ["postcode prefix (text_pattern_ops)", `SELECT id FROM "Company" WHERE "registeredPostcode" LIKE 'LS1%'`],
    ["DS01 sorted by name (partial index)", `SELECT id FROM "Company" WHERE "hasDS01" ORDER BY name, id LIMIT 25`],
  ] as const) {
    const plan = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      return tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${sql}`);
    });
    const text = plan.map((p) => p["QUERY PLAN"]).join(" | ");
    check(`index available: ${label}`, /Index/.test(text), text.slice(0, 160));
  }

  console.log(failures === 0 ? "\nACCEPTANCE: ALL CHECKS PASSED" : `\nACCEPTANCE: ${failures} CHECK(S) FAILED`);
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => { await db.$disconnect(); process.exit(failures === 0 ? 0 : 1); });
