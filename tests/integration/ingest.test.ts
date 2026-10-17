import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, group, rule } from "./helpers";
import { bulkIngestFromCsv } from "../../src/lib/companies-house/bulkIngest";
import { REQUIRED_COLUMNS } from "../../src/lib/companies-house/csv/mapping";
import { reconcileStaleRuns, STALE_AFTER_MS, effectiveStatus } from "../../src/lib/jobs/runs";
import { buildCompanyWhere } from "../../src/lib/data/companies";

const FIXTURE_ZIP = path.resolve(__dirname, "../fixtures/real-sample-59-rows.zip");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dl-ingest-"));

after(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  await db.$disconnect();
});

// Synthetic CSV in the real column layout (same header as the real file).
function writeCsv(name: string, rows: Record<string, string>[], header = REQUIRED_COLUMNS): string {
  const file = path.join(tmp, name);
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [header.join(",")];
  for (const r of rows) lines.push(header.map((h) => esc(r[h] ?? "")).join(","));
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function row(i: number, over: Record<string, string> = {}): Record<string, string> {
  const n = `IT${String(i).padStart(6, "0")}`;
  return {
    CompanyName: `INGEST TEST ${i} LTD`,
    CompanyNumber: n,
    "RegAddress.AddressLine1": `${i} Test Road`,
    "RegAddress.PostTown": "LEEDS",
    "RegAddress.County": "WEST YORKSHIRE",
    "RegAddress.PostCode": "ls1 4ab",
    CompanyCategory: "Private Limited Company",
    CompanyStatus: "Active",
    IncorporationDate: `${String(1 + (i % 28)).padStart(2, "0")}/${String(1 + (i % 12)).padStart(2, "0")}/20${String(10 + (i % 15))}`,
    "Accounts.NextDueDate": "30/06/2027",
    "Accounts.LastMadeUpDate": "30/09/2025",
    "Accounts.AccountCategory": i % 5 === 0 ? "DORMANT" : "TOTAL EXEMPTION FULL",
    "SICCode.SicText_1": "62012 - Business and domestic software development",
    ConfStmtNextDueDate: "15/12/2026",
    ConfStmtLastMadeUpDate: "15/12/2025",
    ...over,
  };
}

const countItRows = () => db.company.count({ where: { companyNumber: { startsWith: "IT" } } });

// ---- real ZIP -> database -----------------------------------------------------------------
test("a real Companies House ZIP sample ingests correctly end to end", async () => {
  const t0 = new Date(Date.now() - 1000);
  const res = await bulkIngestFromCsv({ input: FIXTURE_ZIP, batchSize: 20 });
  assert.equal(res.status, "success", JSON.stringify(res));
  assert.equal(res.rowsRead, 59);
  assert.equal(res.rowsFailed, 0);
  assert.equal(res.rowsSkipped, 0);
  assert.equal(res.rowsInserted, 59);
  assert.equal(res.rowsUpdated, 0);

  const rows = await db.company.findMany({ where: { source: "bulk_import", chLastFetchedAt: { gte: t0 }, companyNumber: { not: { startsWith: "IT" } } } });
  assert.equal(rows.length, 59);
  const withPostcode = rows.filter((r) => r.registeredPostcode !== "").length;
  assert.ok(withPostcode >= 50, `postcodes populated: ${withPostcode}/59`); // a few real rows legitimately have none
  assert.ok(rows.every((r) => r.registeredPostcode === r.registeredPostcode.toUpperCase()));
  assert.ok(rows.every((r) => r.incorporationDate.getUTCFullYear() > 1800 && r.incorporationDate.getUTCFullYear() <= new Date().getUTCFullYear()));
  assert.ok(rows.every((r) => r.incorporationDate.getTime() !== 0), "no 1970 dates");

  const known = await db.company.findUniqueOrThrow({ where: { companyNumber: "08209948" } });
  assert.equal(known.name, "! LTD");
  assert.equal(known.registeredAddress1, "9 PRINCES SQUARE");
  assert.equal(known.registeredPostcode, "HG1 1ND");
  assert.equal(known.registeredCity, "HARROGATE");
  assert.equal(known.incorporationDate.toISOString().slice(0, 10), "2012-09-11"); // DD/MM/YYYY -> 11 Sept 2012
  assert.equal(known.type, "ltd");
  assert.equal(known.accountType, "dormant");
  assert.equal(known.dormant, true);
  assert.equal(known.sicCodes, "99999");
  assert.equal(known.accountsNextDue?.toISOString().slice(0, 10), "2027-06-30");
  assert.equal(known.accountsLastMadeUp?.toISOString().slice(0, 10), "2025-09-30");
  assert.ok(known.confirmationNextDue, "ConfStmtNextDueDate imported");

  const run = await db.ingestionRun.findUniqueOrThrow({ where: { id: res.runId } });
  assert.equal(run.kind, "bulk_csv");
  assert.equal(run.status, "success");
  assert.equal(run.rowsProcessed, 59);
  assert.ok(run.finishedAt);
});

test("re-running the same input creates zero duplicates (idempotent)", async () => {
  const before = await db.company.count();
  const res = await bulkIngestFromCsv({ input: FIXTURE_ZIP, batchSize: 25 });
  assert.equal(res.status, "success");
  assert.equal(res.rowsInserted, 0);
  assert.equal(res.rowsUpdated, 0); // identical data is no longer rewritten...
  assert.equal(res.rowsUnchanged, 59); // ...it is counted as unchanged
  assert.equal(await db.company.count(), before);
  const dupes = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM (SELECT "companyNumber" FROM "Company" GROUP BY 1 HAVING count(*) > 1) d`;
  assert.equal(Number(dupes[0].n), 0);
});

// ---- failure handling ---------------------------------------------------------------------------------
test("a file where most rows are bad is FAILED, not success", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => row(1000 + i, i < 85 ? { IncorporationDate: "31/02/2020" } : {}));
  const res = await bulkIngestFromCsv({ input: writeCsv("mostly-bad.csv", rows), batchSize: 30 });
  assert.equal(res.status, "failed");
  assert.equal(res.rowsSkipped, 85);
  assert.equal(res.rowsInserted, 15);
  assert.ok(res.errorRate > 0.8);
  const run = await db.ingestionRun.findUniqueOrThrow({ where: { id: res.runId } });
  assert.equal(run.status, "failed");
  assert.match(run.errorMessage ?? "", /85 failed|skipped/);
  const samples = JSON.parse(run.errorSamples ?? "[]");
  assert.ok(samples.length > 0 && samples[0].error.includes("incorporation date"), "meaningful error samples are kept");
});

test("a small error rate is PARTIAL, and a clean file is SUCCESS", async () => {
  const partial = await bulkIngestFromCsv({ input: writeCsv("few-bad.csv", Array.from({ length: 200 }, (_, i) => row(2000 + i, i < 6 ? { CompanyName: "" } : {}))) });
  assert.equal(partial.status, "partial"); // 3%
  assert.equal(partial.rowsSkipped, 6);
  const clean = await bulkIngestFromCsv({ input: writeCsv("clean.csv", Array.from({ length: 50 }, (_, i) => row(3000 + i))) });
  assert.equal(clean.status, "success");
});

test("unknown categories are recorded in the run and the rows are still imported", async () => {
  const res = await bulkIngestFromCsv({ input: writeCsv("unknown-cat.csv", [row(4000, { CompanyCategory: "Flying Spaghetti Company" }), row(4001)]) });
  assert.equal(res.status, "success");
  const run = await db.ingestionRun.findUniqueOrThrow({ where: { id: res.runId } });
  const stats = JSON.parse(run.statsJson ?? "{}");
  assert.equal(stats.mapping.unknownCategories["Flying Spaghetti Company"], 1);
  assert.equal((await db.company.findUniqueOrThrow({ where: { companyNumber: "IT004000" } })).type, "flying-spaghetti-company");
});

test("a file with the wrong (underscore) header fails fast with a clear message and writes nothing", async () => {
  const wrong = REQUIRED_COLUMNS.map((c) => c.replace(".", "_"));
  const file = writeCsv("wrong-header.csv", [], wrong);
  const before = await countItRows();
  await assert.rejects(bulkIngestFromCsv({ input: file }), /missing expected column/);
  const run = await db.ingestionRun.findFirstOrThrow({ where: { kind: "bulk_csv" }, orderBy: { startedAt: "desc" } });
  assert.equal(run.status, "failed");
  assert.match(run.errorMessage ?? "", /RegAddress\.PostCode/);
  assert.equal(await countItRows(), before);
});

test("duplicate company numbers inside one file are counted as skipped, not crashed on", async () => {
  const res = await bulkIngestFromCsv({ input: writeCsv("dupes.csv", [row(5000), row(5001), row(5000, { CompanyName: "DUPLICATE OF 5000" })]), batchSize: 10 });
  assert.equal(res.rowsSkipped, 1);
  assert.equal(res.rowsInserted, 2);
  assert.equal((await db.company.findUniqueOrThrow({ where: { companyNumber: "IT005000" } })).name, "DUPLICATE OF 5000"); // last wins
});

// ---- resume --------------------------------------------------------------------------------------------------
test("an interrupted ingest resumes from its checkpoint and ends with the full data set", async () => {
  const TOTAL = 3000;
  const rows = Array.from({ length: TOTAL }, (_, i) => row(10000 + i));
  const file = writeCsv("resume.csv", rows);
  const loaded = () => db.company.count({ where: { companyNumber: { startsWith: "IT01" } } });

  const ctl = new AbortController();
  // Abort as soon as a couple of batches are durable.
  const timer = setInterval(async () => {
    if ((await loaded()) >= 100) ctl.abort();
  }, 2);
  const interrupted = await bulkIngestFromCsv({ input: file, batchSize: 25, signal: ctl.signal });
  clearInterval(timer);
  assert.equal(interrupted.status, "failed", "interrupted run must not claim success");
  const partial = await loaded();
  assert.ok(partial >= 100 && partial < TOTAL, `partially loaded: ${partial}`);
  const run = await db.ingestionRun.findUniqueOrThrow({ where: { id: interrupted.runId } });
  assert.match(run.errorMessage ?? "", /Interrupted/);
  assert.ok(Number(run.checkpoint) >= 100, `checkpoint recorded: ${run.checkpoint}`);
  assert.equal(run.inputName, "resume.csv");

  // Refuses to resume against a different file.
  const other = writeCsv("resume-other.csv", rows.slice(0, 50));
  await assert.rejects(bulkIngestFromCsv({ input: other, resumeRunId: interrupted.runId }), /differs from the original run/);
  // Refuses to "resume" a run that already finished.
  const finished = await db.ingestionRun.findFirstOrThrow({ where: { kind: "bulk_csv", status: "success" } });
  await assert.rejects(bulkIngestFromCsv({ input: file, resumeRunId: finished.id }), /cannot be resumed/);

  // Resume from the checkpoint.
  const resumed = await bulkIngestFromCsv({ input: file, batchSize: 25, resumeRunId: interrupted.runId });
  assert.equal(resumed.runId, interrupted.runId);
  assert.equal(resumed.status, "success");
  assert.equal(await loaded(), TOTAL);
  assert.equal(resumed.rowsInserted + resumed.rowsUpdated, TOTAL);
  const done = await db.ingestionRun.findUniqueOrThrow({ where: { id: interrupted.runId } });
  assert.equal(done.status, "success");
  assert.equal(done.errorMessage, null);
  assert.equal(done.rowsRead, TOTAL);
});

// ---- stale runs ----------------------------------------------------------------------------------------------
test("a dead RUNNING job is detected and reconciled to failed", async () => {
  const old = new Date(Date.now() - STALE_AFTER_MS - 60_000);
  const dead = await db.ingestionRun.create({ data: { kind: "stream", status: "running", startedAt: old, heartbeatAt: old } });
  const alive = await db.ingestionRun.create({ data: { kind: "stream", status: "running" } });
  assert.equal(effectiveStatus(dead), "stalled"); // visible even before reconciliation
  assert.equal(effectiveStatus(alive), "running");
  const closed = await reconcileStaleRuns();
  assert.ok(closed >= 1);
  const after = await db.ingestionRun.findUniqueOrThrow({ where: { id: dead.id } });
  assert.equal(after.status, "failed");
  assert.ok(after.finishedAt);
  assert.match(after.errorMessage ?? "", /no heartbeat/);
  assert.equal((await db.ingestionRun.findUniqueOrThrow({ where: { id: alive.id } })).status, "running");
  await db.ingestionRun.delete({ where: { id: alive.id } });
});

// ---- filters on imported data ---------------------------------------------------------------------------------
test("filters operate correctly on imported data", async () => {
  await bulkIngestFromCsv({ input: writeCsv("filterable.csv", Array.from({ length: 40 }, (_, i) => row(7000 + i, i % 4 === 0 ? { CompanyStatus: "Active - Proposal to Strike off" } : {}))) });
  const count = (filter: unknown) => db.company.count({ where: buildCompanyWhere({ filter: group("AND", rule("companyNumber", "startsWith", "it007"), filter) }) });
  assert.equal(await count(rule("hasDS01", "isTrue")), 10);
  assert.equal(await count(rule("dormant", "isTrue")), 8); // every 5th row
  assert.equal(await count(rule("registeredPostcode", "startsWith", "LS1")), 40);
  assert.equal(await count(rule("registeredPostcode", "startsWith", "ls1 4")), 40);
  assert.equal(await count(rule("sicCodes", "contains", "62012")), 40);
  assert.equal(await count(rule("type", "equals", "ltd")), 40);
  assert.equal(await count(rule("status", "equals", "active")), 40);
});
