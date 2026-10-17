import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { db, createUser } from "./helpers";
import { bulkIngestFromCsv, retryFailedRows, snapshotDateFromName, MAX_BATCH_SIZE } from "../../src/lib/companies-house/bulkIngest";
import { REQUIRED_COLUMNS } from "../../src/lib/companies-house/csv/mapping";

// Importer hardening: checkpoint = durable state, failed-row ledger, snapshot vs
// live-stream precedence, never-delete, unchanged rows not rewritten, dry run.
// Scratch database only (helpers imports the scratch-DB guard first).

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dl-ingest-hard-"));
const DAY = 86_400_000;
const yesterday = () => new Date(Date.now() - DAY);
const tomorrow = () => new Date(Date.now() + DAY);

after(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS it_poison_trg ON "Company"').catch(() => {});
  await db.$disconnect();
});

function csvText(rows: Record<string, string>[]): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [REQUIRED_COLUMNS.join(","), ...rows.map((r) => REQUIRED_COLUMNS.map((h) => esc(r[h] ?? "")).join(","))].join("\n") + "\n";
}
function writeCsv(name: string, rows: Record<string, string>[]): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, csvText(rows));
  return file;
}
function row(i: number, over: Record<string, string> = {}): Record<string, string> {
  return {
    CompanyName: `HARDEN TEST ${i} LTD`,
    CompanyNumber: `IT${String(i).padStart(6, "0")}`,
    "RegAddress.AddressLine1": `${i} Test Road`,
    "RegAddress.PostTown": "LEEDS",
    "RegAddress.County": "WEST YORKSHIRE",
    "RegAddress.PostCode": "ls1 4ab",
    CompanyCategory: "Private Limited Company",
    CompanyStatus: "Active",
    IncorporationDate: "11/09/2012",
    "Accounts.NextDueDate": "30/06/2027",
    "Accounts.LastMadeUpDate": "30/09/2025",
    "Accounts.AccountCategory": "TOTAL EXEMPTION FULL",
    "SICCode.SicText_1": "62012 - Business and domestic software development",
    ConfStmtNextDueDate: "15/12/2026",
    ConfStmtLastMadeUpDate: "15/12/2025",
    ...over,
  };
}
const num = (i: number) => `IT${String(i).padStart(6, "0")}`;
const rows = (from: number, n: number, over: (i: number) => Record<string, string> = () => ({})) => Array.from({ length: n }, (_, k) => row(from + k, over(from + k)));
const count = (prefix: string) => db.company.count({ where: { companyNumber: { startsWith: prefix } } });
const xmins = async (prefix: string) =>
  JSON.stringify(await db.$queryRawUnsafe(`SELECT "companyNumber", xmin::text AS x FROM "Company" WHERE "companyNumber" LIKE '${prefix}%' ORDER BY 1`));
const ledger = (runId: string) => db.$queryRawUnsafe<{ rowNumber: number; companyNumber: string | null; kind: string; retryState: string; reason: string; rawJson: string | null }[]>(
  `SELECT "rowNumber","companyNumber","kind","retryState","reason","rawJson" FROM "IngestRowFailure" WHERE "runId" = '${runId}' ORDER BY "rowNumber"`);

test("snapshot date is read from the Companies House file name", () => {
  assert.equal(snapshotDateFromName("BasicCompanyDataAsOneFile-2026-10-01.zip")?.toISOString().slice(0, 10), "2026-10-01");
  assert.equal(snapshotDateFromName("resume.csv"), null);
  assert.equal(snapshotDateFromName("x-2026-13-45.csv"), null);
});

test("batch size is validated (SQL bind-parameter limit)", async () => {
  const file = writeCsv("bs.csv", rows(300000, 2));
  await assert.rejects(bulkIngestFromCsv({ input: file, batchSize: MAX_BATCH_SIZE + 1 }), /batch size/);
  await assert.rejects(bulkIngestFromCsv({ input: file, batchSize: 0 }), /batch size/);
});

test("normal import reports committed / unchanged / protected / rejected / duplicate / failed separately", async () => {
  const res = await bulkIngestFromCsv({ input: writeCsv("normal.csv", rows(301000, 30)), batchSize: 10, snapshotDate: yesterday() });
  assert.equal(res.status, "success");
  assert.deepEqual(
    { ins: res.rowsInserted, upd: res.rowsUpdated, unch: res.rowsUnchanged, prot: res.rowsProtected, rej: res.rowsRejected, dup: res.rowsDuplicate, fail: res.rowsFailed },
    { ins: 30, upd: 0, unch: 0, prot: 0, rej: 0, dup: 0, fail: 0 }
  );
  const run = await db.ingestionRun.findUniqueOrThrow({ where: { id: res.runId } });
  assert.equal(run.checkpoint, "30");
  assert.equal(await count("IT301"), 30);
});

test("an unchanged existing company is NOT rewritten; a changed one is, and only it", async () => {
  const file = writeCsv("unchanged.csv", rows(302000, 20));
  await bulkIngestFromCsv({ input: file, snapshotDate: yesterday() });
  const before = await xmins("IT302");
  const again = await bulkIngestFromCsv({ input: file, snapshotDate: yesterday() });
  assert.equal(again.rowsUnchanged, 20);
  assert.equal(again.rowsUpdated + again.rowsInserted, 0);
  assert.equal(await xmins("IT302"), before, "no row version changed (no write happened)");

  const changed = writeCsv("changed.csv", rows(302000, 20, (i): Record<string, string> => (i === 302005 ? { CompanyName: "RENAMED BY REGISTER LTD", "RegAddress.PostCode": "m1 1aa" } : {})));
  const res = await bulkIngestFromCsv({ input: changed, snapshotDate: yesterday() });
  assert.equal(res.rowsUpdated, 1);
  assert.equal(res.rowsUnchanged, 19);
  const c = await db.company.findUniqueOrThrow({ where: { companyNumber: num(302005) } });
  assert.equal(c.name, "RENAMED BY REGISTER LTD");
  assert.equal(c.registeredPostcode, "M1 1AA");
  const after = JSON.parse(await xmins("IT302")) as { companyNumber: string; x: string }[];
  const was = JSON.parse(before) as { companyNumber: string; x: string }[];
  const touched = after.filter((a, k) => a.x !== was[k].x).map((a) => a.companyNumber);
  assert.deepEqual(touched, [num(302005)]);
});

test("--limit: the checkpoint covers exactly the rows consumed (no off-by-one skip)", async () => {
  const file = writeCsv("limit.csv", rows(303000, 100));
  const res = await bulkIngestFromCsv({ input: file, batchSize: 40, limit: 70 });
  assert.equal(res.rowsRead, 70);
  assert.equal(await count("IT303"), 70);
  const run = await db.ingestionRun.findUniqueOrThrow({ where: { id: res.runId } });
  assert.equal(run.checkpoint, "70");
});

test("crash mid-parse: the checkpoint never moves ahead of committed rows; nothing is lost on rerun", async () => {
  const good = rows(304000, 700); // > one parser chunk, so earlier rows reach the importer before the parser fails
  const file = path.join(tmp, "midcrash.csv");
  // 130 good rows, then a structurally broken line (stray quote inside a field) that makes the parser throw
  fs.writeFileSync(file, csvText(good) + `${num(304999)},ab"c,x\n`);
  await assert.rejects(bulkIngestFromCsv({ input: file, batchSize: 100 }));
  const run = await db.ingestionRun.findFirstOrThrow({ where: { kind: "bulk_csv", inputName: "midcrash.csv" } });
  assert.equal(run.status, "failed");
  const committed = await count("IT304");
  assert.ok(committed < 700 && committed % 100 === 0, `only whole committed batches are in the database (${committed})`);
  assert.equal(Number(run.checkpoint), committed, "checkpoint === durable rows (buffered, uncommitted rows are NOT covered, so they are re-read on resume)");
  assert.equal(run.rowsRead, committed, "counters are exactly as durable as the checkpoint");
});

test("kill -9 during a real import: checkpoint equals the durable rows, resume completes with no loss or duplicates", async () => {
  const N = 6000;
  const file = writeCsv("killed.csv", rows(305000, N).map((r, k) => ({ ...r, CompanyNumber: `IK${String(k).padStart(6, "0")}` })));
  const isWin = process.platform === "win32";
  const child = spawn(isWin ? "npx.cmd" : "npx", ["tsx", "scripts/ch-bulk-ingest.ts", "--input", file, "--batch", "25", "--snapshot-date", "2026-01-01"], {
    env: process.env,
    stdio: "ignore",
    shell: isWin,
  });
  const find = () => db.ingestionRun.findFirst({ where: { kind: "bulk_csv", inputName: "killed.csv" } });
  const deadline = Date.now() + 90_000;
  let seen = 0;
  while (Date.now() < deadline) {
    const r = await find();
    seen = Number(r?.checkpoint ?? 0);
    if (seen >= 200) break;
    await new Promise((res) => setTimeout(res, 20));
  }
  if (isWin && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
  await new Promise((res) => setTimeout(res, 1500)); // let the OS reap the process / connections close
  assert.ok(seen >= 200, `import never reached 200 rows (${seen})`);

  const run = await db.ingestionRun.findFirstOrThrow({ where: { kind: "bulk_csv", inputName: "killed.csv" } });
  assert.equal(run.status, "running", "a killed process cannot mark itself failed");
  const durable = await count("IK");
  assert.ok(durable < N, "killed before finishing");
  assert.equal(Number(run.checkpoint), durable, "checkpoint === rows durably in the database");
  assert.equal(run.rowsRead, durable);

  // time passes: the dead job's heartbeat goes stale, then it can be resumed
  await db.ingestionRun.update({ where: { id: run.id }, data: { heartbeatAt: new Date(Date.now() - 30 * 60_000) } });
  const resumed = await bulkIngestFromCsv({ input: file, batchSize: 25, resumeRunId: run.id, snapshotDate: new Date("2026-01-01T00:00:00Z") });
  assert.equal(resumed.status, "success");
  assert.equal(await count("IK"), N);
  assert.equal(resumed.rowsInserted, N, "counters are exact across the crash");
  const dupes = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM (SELECT "companyNumber" FROM "Company" WHERE "companyNumber" LIKE 'IK%' GROUP BY 1 HAVING count(*) > 1) d`;
  assert.equal(Number(dupes[0].n), 0);
});

test("failed rows land in the ledger with their raw data; the rest of the batch commits; retry resolves them", async () => {
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION it_poison() RETURNS trigger AS $$ BEGIN IF NEW."name" = 'POISON ROW LTD' THEN RAISE EXCEPTION 'poisoned row'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await db.$executeRawUnsafe('CREATE TRIGGER it_poison_trg BEFORE INSERT OR UPDATE ON "Company" FOR EACH ROW EXECUTE FUNCTION it_poison()');
  let res;
  try {
    const data = rows(306000, 60, (i): Record<string, string> => (i === 306010 || i === 306040 ? { CompanyName: "POISON ROW LTD" } : i === 306020 ? { IncorporationDate: "31/02/2020" } : {}));
    data.splice(31, 0, row(306030, { CompanyName: "SECOND OCCURRENCE LTD" })); // same number twice, adjacent (rows 31 and 32)
    res = await bulkIngestFromCsv({ input: writeCsv("poison.csv", data), batchSize: 100, snapshotDate: yesterday() });
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS it_poison_trg ON "Company"');
  }
  assert.equal(res.rowsFailed, 2, "two DB failures");
  assert.equal(res.rowsRejected, 1, "one validation rejection (bad date)");
  assert.equal(res.rowsDuplicate, 1, "one superseded duplicate");
  assert.equal(res.rowsInserted, 60 - 2 - 1, "everything else committed (the duplicate pair counts once)");
  assert.equal(await count("IT306"), 57);
  const run = await db.ingestionRun.findUniqueOrThrow({ where: { id: res.runId } });
  assert.equal(Number(run.checkpoint), 61, "checkpoint advanced past the failed rows ONLY because they are ledgered");

  const rowsL = await ledger(res.runId);
  assert.equal(rowsL.length, 4);
  const byKind = (k: string) => rowsL.filter((r) => r.kind === k);
  assert.equal(byKind("db_failure").length, 2);
  assert.ok(byKind("db_failure").every((r) => r.retryState === "retriable" && r.rawJson && r.reason.includes("poisoned")));
  assert.deepEqual(byKind("db_failure").map((r) => r.companyNumber), [num(306010), num(306040)]);
  assert.equal(byKind("rejected")[0].retryState, "permanent");
  assert.equal(byKind("rejected")[0].rowNumber, 21);
  assert.equal(byKind("duplicate_in_file")[0].retryState, "permanent");
  assert.equal(await db.company.count({ where: { companyNumber: { in: [num(306010), num(306040)] } } }), 0, "failed rows are absent, not silently half-written");

  // trigger gone: retry from the ledger
  const retry = await retryFailedRows(res.runId);
  assert.deepEqual({ a: retry.attempted, r: retry.resolved, s: retry.stillFailing }, { a: 2, r: 2, s: 0 });
  assert.equal(await count("IT306"), 59);
  assert.ok((await ledger(res.runId)).filter((r) => r.kind === "db_failure").every((r) => r.retryState === "resolved"));
  const after = await db.ingestionRun.findUniqueOrThrow({ where: { id: res.runId } });
  assert.equal(after.rowsFailed, 0);
  assert.equal(after.rowsInserted, 59);
  const again = await retryFailedRows(res.runId);
  assert.equal(again.attempted, 0, "retry is idempotent");
});

test("snapshot older than stream/REST data never overwrites it; a newer snapshot does", async () => {
  await bulkIngestFromCsv({ input: writeCsv("live1.csv", rows(307000, 3)), snapshotDate: yesterday() });
  await db.company.update({ where: { companyNumber: num(307000) }, data: { source: "stream", chLastFetchedAt: new Date(), name: "LIVE STREAM NAME LTD" } });
  const stale = writeCsv("live2.csv", rows(307000, 3, (i) => ({ CompanyName: `OLD SNAPSHOT ${i}` })));
  const r1 = await bulkIngestFromCsv({ input: stale, snapshotDate: yesterday() });
  assert.equal(r1.rowsProtected, 1);
  assert.equal(r1.rowsUpdated, 2);
  assert.equal((await db.company.findUniqueOrThrow({ where: { companyNumber: num(307000) } })).name, "LIVE STREAM NAME LTD");
  assert.equal((await db.company.findUniqueOrThrow({ where: { companyNumber: num(307000) } })).source, "stream");

  // unknown snapshot date: worst case, live rows stay protected
  const r2 = await bulkIngestFromCsv({ input: stale, snapshotDate: null });
  assert.equal(r2.rowsProtected, 1);

  // a genuinely newer snapshot wins
  const r3 = await bulkIngestFromCsv({ input: stale, snapshotDate: tomorrow() });
  assert.equal(r3.rowsProtected, 0);
  assert.equal((await db.company.findUniqueOrThrow({ where: { companyNumber: num(307000) } })).name, "OLD SNAPSHOT 307000");
});

test("an older bulk snapshot cannot overwrite newer Advanced Search / REST / stream data (names, SIC, address, postcode); older rows and bulk rows are still refreshed", async () => {
  const seed = writeCsv("adv-seed.csv", rows(320000, 4));
  await bulkIngestFromCsv({ input: seed, snapshotDate: yesterday() });
  const threeDaysAgo = new Date(Date.now() - 3 * DAY);
  // 320000: new-registration (Advanced Search) row fetched NOW, i.e. after the snapshot date -> newer than the file
  await db.company.update({ where: { companyNumber: num(320000) }, data: { source: "advanced_search", chLastFetchedAt: new Date(), name: "NEW API NAME LTD", sicCodes: "62012,70229", registeredCity: "London", registeredPostcode: "E6 2JA" } });
  // 320001: Advanced Search row fetched BEFORE the snapshot date -> the snapshot is newer, so it may overwrite
  await db.company.update({ where: { companyNumber: num(320001) }, data: { source: "advanced_search", chLastFetchedAt: threeDaysAgo, name: "OLD SEARCH NAME LTD" } });
  // 320002: REST-enriched row fetched now -> newer than the file
  await db.company.update({ where: { companyNumber: num(320002) }, data: { source: "rest_enrichment", chLastFetchedAt: new Date(), name: "REST NAME LTD" } });
  // 320003 stays a plain bulk_import row: never "live", always refreshed

  const stale = writeCsv("adv-stale.csv", rows(320000, 4, (i) => ({
    CompanyName: `OLD SNAPSHOT ${i}`, "RegAddress.PostTown": "LEEDS", "RegAddress.PostCode": "ls1 9zz", "SICCode.SicText_1": "69109 - Solicitors",
  })));
  const before = await xmins("IT3200");

  // a dry run predicts exactly this and writes nothing
  const dry = await bulkIngestFromCsv({ input: stale, snapshotDate: yesterday(), dryRun: true });
  assert.equal(dry.rowsProtected, 2);
  assert.equal(dry.rowsUpdated, 2);
  assert.equal(await xmins("IT3200"), before, "dry run wrote nothing");

  const r1 = await bulkIngestFromCsv({ input: stale, snapshotDate: yesterday() });
  assert.equal(r1.rowsProtected, 2);
  assert.equal(r1.rowsUpdated, 2);
  const newer = await db.company.findUniqueOrThrow({ where: { companyNumber: num(320000) } });
  assert.equal(newer.name, "NEW API NAME LTD");
  assert.equal(newer.sicCodes, "62012,70229");
  assert.equal(newer.registeredCity, "London");
  assert.equal(newer.registeredPostcode, "E6 2JA");
  assert.equal(newer.source, "advanced_search");
  assert.equal((await db.company.findUniqueOrThrow({ where: { companyNumber: num(320002) } })).name, "REST NAME LTD");
  const older = await db.company.findUniqueOrThrow({ where: { companyNumber: num(320001) } });
  assert.equal(older.name, "OLD SNAPSHOT 320001");
  assert.equal(older.source, "bulk_import");
  assert.equal((await db.company.findUniqueOrThrow({ where: { companyNumber: num(320003) } })).name, "OLD SNAPSHOT 320003");

  // re-running the same old file changes nothing further (idempotent)
  const r2 = await bulkIngestFromCsv({ input: stale, snapshotDate: yesterday() });
  assert.equal(r2.rowsProtected, 2);
  assert.equal(r2.rowsUpdated, 0);

  // a snapshot dated AFTER the fetch is newer and does replace the row
  const r3 = await bulkIngestFromCsv({ input: stale, snapshotDate: tomorrow() });
  assert.equal(r3.rowsProtected, 0);
  assert.equal((await db.company.findUniqueOrThrow({ where: { companyNumber: num(320000) } })).name, "OLD SNAPSHOT 320000");
});

test("with an unknown snapshot date every Advanced Search / REST / stream row is protected (worst case)", async () => {
  await bulkIngestFromCsv({ input: writeCsv("adv2-seed.csv", rows(321000, 3)), snapshotDate: yesterday() });
  await db.company.update({ where: { companyNumber: num(321000) }, data: { source: "advanced_search", chLastFetchedAt: new Date(Date.now() - 30 * DAY), name: "API NAME A" } });
  await db.company.update({ where: { companyNumber: num(321001) }, data: { source: "stream", chLastFetchedAt: new Date(Date.now() - 30 * DAY), name: "API NAME B" } });
  const stale = writeCsv("adv2-stale.csv", rows(321000, 3, (i) => ({ CompanyName: `OLD ${i}` })));
  const r = await bulkIngestFromCsv({ input: stale, snapshotDate: null });
  assert.equal(r.rowsProtected, 2);
  assert.equal((await db.company.findUniqueOrThrow({ where: { companyNumber: num(321000) } })).name, "API NAME A");
  assert.equal((await db.company.findUniqueOrThrow({ where: { companyNumber: num(321001) } })).name, "API NAME B");
});

test("a stale snapshot cannot roll back a newer DS01/DS02 event; an older event does not block a newer snapshot", async () => {
  const strike = { CompanyStatus: "Active - Proposal to Strike off" };
  await bulkIngestFromCsv({ input: writeCsv("ds-a.csv", rows(308000, 3)), snapshotDate: yesterday() });
  const [a, b, c] = await Promise.all([308000, 308001, 308002].map((i) => db.company.findUniqueOrThrow({ where: { companyNumber: num(i) } })));
  const ev = (companyId: string, companyNumber: string, type: string, ageMs: number, tx: string) =>
    db.filingEvent.create({ data: { companyId, companyNumber, transactionId: tx, type, applyStatus: "applied", appliedAt: new Date(Date.now() - ageMs), processedAt: new Date(Date.now() - ageMs) } });

  // a: DS02 (withdrawal) applied AFTER the snapshot -> hasDS01 must stay false although the old file still says "proposal to strike off"
  await db.company.update({ where: { id: a.id }, data: { hasDS01: false, ds01FiledAt: null } });
  await ev(a.id, a.companyNumber, "DS02", 1000, "it-ds02-a");
  // b: DS01 applied AFTER the snapshot -> hasDS01 stays true although the old file shows a normal active company
  await db.company.update({ where: { id: b.id }, data: { hasDS01: true, ds01FiledAt: new Date() } });
  await ev(b.id, b.companyNumber, "DS01", 1000, "it-ds01-b");
  // c: DS02 applied 10 days ago, BEFORE the snapshot -> the snapshot (newer) wins
  await db.company.update({ where: { id: c.id }, data: { hasDS01: false, ds01FiledAt: null } });
  await ev(c.id, c.companyNumber, "DS02", 10 * DAY, "it-ds02-c");

  const res = await bulkIngestFromCsv({ input: writeCsv("ds-b.csv", [row(308000, strike), row(308001), row(308002, strike)]), snapshotDate: yesterday() });
  assert.equal(res.rowsFailed, 0);
  const [a2, b2, c2] = await Promise.all([a.id, b.id, c.id].map((id) => db.company.findUniqueOrThrow({ where: { id } })));
  assert.equal(a2.hasDS01, false, "stale snapshot did not undo the DS02 withdrawal");
  assert.equal(b2.hasDS01, true, "stale snapshot did not erase the DS01");
  assert.ok(b2.ds01FiledAt);
  assert.equal(c2.hasDS01, true, "an event older than the snapshot does not block it");

  // stability: re-running the same file changes nothing (no perpetual rewrites)
  const before = await xmins("IT308");
  const again = await bulkIngestFromCsv({ input: writeCsv("ds-b.csv", [row(308000, strike), row(308001), row(308002, strike)]), snapshotDate: yesterday() });
  assert.equal(again.rowsUpdated, 0);
  assert.equal(await xmins("IT308"), before);
});

test("companies absent from a snapshot are NEVER deleted, and CRM state survives import updates", async () => {
  await bulkIngestFromCsv({ input: writeCsv("abs1.csv", rows(309000, 3)), snapshotDate: yesterday() });
  const [a, b] = await Promise.all([309000, 309001].map((i) => db.company.findUniqueOrThrow({ where: { companyNumber: num(i) } })));
  const user = await createUser("USER", "ingest");
  const stateA = await db.userCompanyState.create({ data: { userId: user.id, companyId: a.id, followed: true, saved: true, redFlagged: true, trashed: false } });
  const stateB = await db.userCompanyState.create({ data: { userId: user.id, companyId: b.id, followed: true, trashed: true } });
  await db.note.create({ data: { userCompanyStateId: stateA.id, body: "keep me", authorName: "t" } });
  await db.followUp.create({ data: { userCompanyStateId: stateB.id, userId: user.id, dueDate: new Date("2027-01-01") } });
  await db.crmContact.create({ data: { userId: user.id, companyId: b.id, name: "Manual Contact" } });
  const crm = async () =>
    JSON.stringify([
      await db.userCompanyState.findMany({ where: { userId: user.id }, orderBy: { id: "asc" } }),
      await db.note.findMany({ where: { userCompanyStateId: { in: [stateA.id, stateB.id] } }, orderBy: { id: "asc" } }),
      await db.followUp.findMany({ where: { userId: user.id }, orderBy: { id: "asc" } }),
      await db.crmContact.findMany({ where: { userId: user.id }, orderBy: { id: "asc" } }),
    ]);
  const before = await crm();
  const total = await db.company.count();

  // new file: only A (changed), B and C are absent
  const res = await bulkIngestFromCsv({ input: writeCsv("abs2.csv", [row(309000, { CompanyName: "A RENAMED LTD" })]), snapshotDate: yesterday() });
  assert.equal(res.rowsUpdated, 1);
  assert.equal(await db.company.count(), total, "nothing deleted");
  assert.equal(await count("IT309"), 3, "absent companies still exist");
  assert.equal(await crm(), before, "CRM state byte-for-byte unchanged");
  assert.equal((await db.company.findUniqueOrThrow({ where: { companyNumber: num(309001) } })).name, "HARDEN TEST 309001 LTD", "absent company not even touched");
});

test("dry run writes nothing and predicts exactly what the real run then does", async () => {
  await bulkIngestFromCsv({ input: writeCsv("dry0.csv", rows(310000, 6)), snapshotDate: yesterday() });
  await db.company.update({ where: { companyNumber: num(310005) }, data: { source: "stream", chLastFetchedAt: new Date(), name: "LIVE LTD" } });
  const input = [
    ...rows(310000, 4), // 4 existing, identical -> unchanged
    row(310004, { CompanyName: "CHANGED NAME LTD" }), // changed
    row(310005, { CompanyName: "STALE NAME LTD" }), // protected (live data newer)
    ...rows(310100, 3), // 3 new
    row(310200, { IncorporationDate: "99/99/2020" }), // malformed -> rejected
    row(310100), // duplicate of a new row
  ];
  const file = writeCsv("dry1.csv", input);

  const runsBefore = await db.ingestionRun.count();
  const stateBefore = await xmins("IT310");
  const totalBefore = await db.company.count();
  const ledgerBefore = Number((await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM "IngestRowFailure"`)[0].n);

  const dry = await bulkIngestFromCsv({ input: file, dryRun: true, batchSize: 50, snapshotDate: yesterday() });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.runId, "dry-run");
  assert.deepEqual(
    { ins: dry.rowsInserted, upd: dry.rowsUpdated, unch: dry.rowsUnchanged, prot: dry.rowsProtected, rej: dry.rowsRejected, dup: dry.rowsDuplicate, read: dry.rowsRead },
    { ins: 3, upd: 1, unch: 4, prot: 1, rej: 1, dup: 1, read: input.length }
  );
  assert.equal(await db.ingestionRun.count(), runsBefore, "no run row");
  assert.equal(await db.company.count(), totalBefore);
  assert.equal(await xmins("IT310"), stateBefore, "no Company row touched");
  assert.equal(Number((await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM "IngestRowFailure"`)[0].n), ledgerBefore, "no ledger rows");

  // (a duplicate is only detectable inside one batch in a real run; the dry run sees the whole file)
  const real = await bulkIngestFromCsv({ input: file, batchSize: 50, snapshotDate: yesterday() });
  assert.deepEqual(
    { ins: real.rowsInserted, upd: real.rowsUpdated, unch: real.rowsUnchanged, prot: real.rowsProtected, rej: real.rowsRejected, dup: real.rowsDuplicate },
    { ins: dry.rowsInserted, upd: dry.rowsUpdated, unch: dry.rowsUnchanged, prot: dry.rowsProtected, rej: dry.rowsRejected, dup: dry.rowsDuplicate },
    "dry run prediction === real run result"
  );
  await assert.rejects(bulkIngestFromCsv({ input: file, dryRun: true, resumeRunId: real.runId }), /cannot be combined/);
});
