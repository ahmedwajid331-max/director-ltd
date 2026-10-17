import { parse } from "csv-parse";
import { randomUUID } from "node:crypto";
import { Prisma, type IngestionRun } from "@prisma/client";
import { db } from "@/lib/db";
import { chRestGet, CompaniesHouseRateLimitError } from "./client";
import { syncCompanyProfile } from "./sync";
import { parseChDate } from "./csv/dates";
import { emptyMappingStats, mapCsvRecord, missingColumns, normalisePostcode, type CompanyCsvRow } from "./csv/mapping";
import { downloadToCache, openCsvFile, resolveLatestMonthlyUrl } from "./csv/source";
import { classifyRun, ErrorSampler, finishRun, isStale, startRun, touchRun } from "@/lib/jobs/runs";

// ===========================================================================
// 1. Monthly bulk CSV ingest (production path, ~5.6M rows)
// ===========================================================================

export interface CsvIngestOptions {
  input?: string; // local .zip/.csv path or an https URL; default = latest monthly file
  limit?: number; // stop after reading N data rows (dev/testing only)
  batchSize?: number; // 1..MAX_BATCH_SIZE (default 500)
  resumeRunId?: string;
  downloadDir?: string;
  signal?: AbortSignal;
  log?: (msg: string) => void;
  // As-of date of the snapshot. Default: the YYYY-MM-DD in the file name
  // (BasicCompanyDataAsOneFile-2026-10-01.zip). When it cannot be determined
  // the importer assumes the WORST case for live data: every row that was
  // last written by the stream / a live REST fetch / the Advanced Search sync
  // is treated as newer than the snapshot and left alone.
  snapshotDate?: Date | null;
  // Parse + validate the whole input and predict inserts/updates/unchanged/
  // protected/rejected against the current database using read-only queries.
  // Writes nothing at all (no Company rows, no ledger, no run row).
  dryRun?: boolean;
}

export interface CsvIngestResult {
  runId: string; // "dry-run" for a dry run (nothing is recorded)
  status: string;
  dryRun: boolean;
  snapshotDate: string | null;
  rowsRead: number;
  rowsInserted: number; // committed: new companies
  rowsUpdated: number; // committed: existing companies whose register data changed
  rowsUnchanged: number; // existing company already identical: NOT rewritten
  rowsProtected: number; // existing company holds newer live (stream/REST) data: NOT touched
  rowsRejected: number; // permanent: failed validation (see IngestRowFailure)
  rowsDuplicate: number; // permanent: superseded by a later duplicate in the same file
  rowsFailed: number; // retriable: database failure (see IngestRowFailure, retryState=retriable)
  rowsSkipped: number; // rejected + duplicate (kept for the run-status error rate)
  errorRate: number;
}

// Postgres allows 65,535 bind parameters per statement; a row binds ~25.
export const MAX_BATCH_SIZE = 2000;

export function snapshotDateFromName(name: string): Date | null {
  const m = name.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) || d.getUTCMonth() !== Number(m[2]) - 1 ? null : d;
}

const COMPANY_COLUMNS = [
  "id", "companyNumber", "name", "status", "statusDetail", "type", "incorporationDate", "dissolutionDate",
  "dormant", "accountType", "sicCodes", "registeredAddress1", "registeredAddress2", "registeredCity",
  "registeredPostcode", "registeredCounty", "accountsNextDue", "accountsLastMadeUp", "accountsOverdue",
  "confirmationNextDue", "confirmationLastMadeUp", "confirmationOverdue", "hasDS01", "source",
  "chLastFetchedAt", "createdAt", "updatedAt",
];

// Register-derived columns the snapshot is allowed to change. Deliberately
// absent: officer columns, ds01FiledAt, id, createdAt - and everything in the
// CRM tables, which this importer never touches.
const REGISTER_COLUMNS = [
  "name", "status", "statusDetail", "type", "incorporationDate", "dissolutionDate", "dormant", "accountType", "sicCodes",
  "registeredAddress1", "registeredAddress2", "registeredCity", "registeredPostcode", "registeredCounty",
  "accountsNextDue", "accountsLastMadeUp", "accountsOverdue", "confirmationNextDue", "confirmationLastMadeUp", "confirmationOverdue",
];

const isoDate = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

// `now` is an ISO-8601 UTC string cast to `timestamp`: the literal is read as
// UTC wall-clock time regardless of the database session time zone (passing a
// JS Date would be converted to the session zone and shift timestamps).
function rowTuple(r: CompanyCsvRow, now: string): Prisma.Sql {
  return Prisma.sql`(${randomUUID()}, ${r.companyNumber}, ${r.name}, ${r.status}, ${r.statusDetail}, ${r.type},
    ${isoDate(r.incorporationDate)}::date, ${isoDate(r.dissolutionDate)}::date, ${r.dormant}, ${r.accountType},
    ${r.sicCodes}, ${r.registeredAddress1}, ${r.registeredAddress2}, ${r.registeredCity}, ${r.registeredPostcode},
    ${r.registeredCounty}, ${isoDate(r.accountsNextDue)}::date, ${isoDate(r.accountsLastMadeUp)}::date, ${r.accountsOverdue},
    ${isoDate(r.confirmationNextDue)}::date, ${isoDate(r.confirmationLastMadeUp)}::date, ${r.confirmationOverdue},
    ${r.hasDS01}, 'bulk_import', CAST(${now} AS timestamp), CAST(${now} AS timestamp), CAST(${now} AS timestamp))`;
}

// ---- snapshot-vs-live precedence (pure SQL fragments shared by the real
// upsert and the read-only dry run, so a dry run predicts exactly what the
// import will do) ---------------------------------------------------------------
type Db = Pick<typeof db, "$queryRaw" | "$executeRaw">;
const asOfSql = (d: Date | null) => (d ? Prisma.sql`CAST(${isoDate(d)} AS timestamp)` : Prisma.sql`CAST(NULL AS timestamp)`);

// A company whose row was last written by the live stream / a live REST
// profile fetch / the Advanced Search sync (new registrations) NEWER than the
// snapshot holds fresher data than the file.
// Rows from earlier bulk loads are never "live" (their chLastFetchedAt is just
// the import time). An Advanced Search row fetched AFTER the snapshot date is
// protected as a whole row: the file is older, so it would put back superseded
// names, SIC codes, addresses and postcodes. The next monthly file (dated after
// the fetch) replaces it normally and adds the accounts dates the search lacks.
function liveNewerSql(cur: Prisma.Sql, asOf: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${cur}."source" IN ('stream', 'rest_enrichment', 'advanced_search')
    AND (${asOf} IS NULL OR ${cur}."chLastFetchedAt" IS NULL OR ${cur}."chLastFetchedAt" > ${asOf}))`;
}

// hasDS01 is owned by the stream once a DS01/DS02 event has been applied after
// the snapshot date: the older snapshot must not set it back - neither a
// withdrawn DS01 (DS02) nor the reverse. Otherwise: register flag OR a
// recorded DS01 event date (never erased by a monthly file).
function hasDs01Sql(cur: Prisma.Sql, inc: Prisma.Sql, asOf: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(CASE WHEN EXISTS (
      SELECT 1 FROM "FilingEvent" f
      WHERE f."companyNumber" = ${cur}."companyNumber" AND f."applyStatus" = 'applied' AND f."type" IN ('DS01', 'DS02')
        AND (${asOf} IS NULL OR COALESCE(f."appliedAt", f."processedAt") >= ${asOf})
    ) THEN ${cur}."hasDS01"
    ELSE (${inc}."hasDS01" OR ${cur}."ds01FiledAt" IS NOT NULL) END)`;
}

function changedSql(cur: Prisma.Sql, inc: Prisma.Sql, asOf: Prisma.Sql): Prisma.Sql {
  const cols = REGISTER_COLUMNS.map((c) => Prisma.sql`${cur}.${Prisma.raw(`"${c}"`)} IS DISTINCT FROM ${inc}.${Prisma.raw(`"${c}"`)}`);
  cols.push(Prisma.sql`${cur}."hasDS01" IS DISTINCT FROM ${hasDs01Sql(cur, inc, asOf)}`);
  return Prisma.sql`(${Prisma.join(cols, " OR ")})`;
}

const CUR = Prisma.raw('"Company"');
const EXC = Prisma.raw("EXCLUDED");

// One multi-row INSERT ... ON CONFLICT DO UPDATE per batch. Idempotent (the
// unique companyNumber is the identity). An existing row is rewritten ONLY if
// (a) it does not hold newer live data and (b) a register field really
// changed - unchanged rows are not touched at all (no write, no updatedAt,
// no WAL). It never touches officer-derived columns or ds01FiledAt, and never
// deletes anything. RETURNING covers only rows that were inserted/updated:
// the caller derives "unchanged" from the difference.
async function upsertBatch(client: Db, rows: CompanyCsvRow[], asOf: Date | null): Promise<{ inserted: number; updated: number }> {
  const now = new Date().toISOString();
  const asOfS = asOfSql(asOf);
  const out = await client.$queryRaw<{ inserted: boolean }[]>(Prisma.sql`
    INSERT INTO "Company" (${Prisma.join(COMPANY_COLUMNS.map((c) => Prisma.raw(`"${c}"`)))})
    VALUES ${Prisma.join(rows.map((r) => rowTuple(r, now)))}
    ON CONFLICT ("companyNumber") DO UPDATE SET
      ${Prisma.join(REGISTER_COLUMNS.map((c) => Prisma.sql`${Prisma.raw(`"${c}"`)} = EXCLUDED.${Prisma.raw(`"${c}"`)}`))},
      "hasDS01" = ${hasDs01Sql(CUR, EXC, asOfS)},
      "source" = EXCLUDED."source",
      "chLastFetchedAt" = EXCLUDED."chLastFetchedAt",
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE NOT ${liveNewerSql(CUR, asOfS)} AND ${changedSql(CUR, EXC, asOfS)}
    RETURNING (xmax = 0) AS inserted`);
  const inserted = out.filter((r) => r.inserted).length;
  return { inserted, updated: out.length - inserted };
}

// Existing companies in `numbers` that hold newer live data (left untouched).
async function liveNewerNumbers(client: Db, numbers: string[], asOf: Date | null): Promise<Set<string>> {
  if (numbers.length === 0) return new Set();
  const rows = await client.$queryRaw<{ companyNumber: string }[]>(Prisma.sql`
    SELECT "companyNumber" FROM "Company"
    WHERE "companyNumber" IN (${Prisma.join(numbers)}) AND ${liveNewerSql(CUR, asOfSql(asOf))}`);
  return new Set(rows.map((r) => r.companyNumber));
}

// Read-only prediction for one batch (dry run).
async function predictBatch(rows: CompanyCsvRow[], asOf: Date | null) {
  const now = new Date().toISOString();
  const asOfS = asOfSql(asOf);
  const I = Prisma.raw("i");
  const C = Prisma.raw("c");
  const res = await db.$queryRaw<{ is_new: boolean; live_newer: boolean; changed: boolean }[]>(Prisma.sql`
    WITH i (${Prisma.join(COMPANY_COLUMNS.map((c) => Prisma.raw(`"${c}"`)))}) AS (VALUES ${Prisma.join(rows.map((r) => rowTuple(r, now)))})
    SELECT (c."id" IS NULL) AS is_new,
           COALESCE(${liveNewerSql(C, asOfS)}, false) AS live_newer,
           COALESCE(${changedSql(C, I, asOfS)}, false) AS changed
    FROM i LEFT JOIN "Company" c ON c."companyNumber" = i."companyNumber"`);
  let inserted = 0, updated = 0, unchanged = 0, protectedRows = 0;
  for (const r of res) {
    if (r.is_new) inserted++;
    else if (r.live_newer) protectedRows++;
    else if (r.changed) updated++;
    else unchanged++;
  }
  return { inserted, updated, unchanged, protectedRows };
}

// ---- failed-row ledger (raw SQL: additive table, no Prisma model coupling) ---------------
interface LedgerEntry {
  rowNumber: number;
  companyNumber?: string | null;
  kind: "rejected" | "duplicate_in_file" | "db_failure";
  reason: string;
  retryState: "permanent" | "retriable";
  rawJson?: string | null;
}

async function writeLedger(client: Db, runId: string, entries: LedgerEntry[]) {
  if (entries.length === 0) return;
  // (runId,rowNumber) is unique: re-recording after a crash/resume is harmless.
  await client.$executeRaw(Prisma.sql`
    INSERT INTO "IngestRowFailure" ("id", "runId", "rowNumber", "companyNumber", "kind", "reason", "retryState", "rawJson")
    VALUES ${Prisma.join(entries.map((e) => Prisma.sql`(${randomUUID()}, ${runId}, ${e.rowNumber}, ${e.companyNumber ?? null}, ${e.kind}, ${e.reason.slice(0, 500)}, ${e.retryState}, ${e.rawJson ?? null})`))}
    ON CONFLICT ("runId", "rowNumber") DO NOTHING`);
}

const rawJsonOf = (record: Record<string, string>) => JSON.stringify(record).slice(0, 8000);
const errorText = (err: unknown) => (err instanceof Error ? err.message.split("\n").filter(Boolean).pop() ?? "row failed" : String(err));

interface Totals {
  read: number;
  inserted: number;
  updated: number;
  unchanged: number;
  protectedRows: number;
  rejected: number;
  duplicates: number;
  failed: number;
}

interface PersistedStats {
  mapping?: ReturnType<typeof emptyMappingStats>;
  duplicatesInFile?: number;
  batchFallbacks?: number;
  unchanged?: number;
  protectedRows?: number;
  rejected?: number;
  snapshotDate?: string | null;
}

export async function bulkIngestFromCsv(options: CsvIngestOptions = {}): Promise<CsvIngestResult> {
  const log = options.log ?? (() => {});
  const dry = options.dryRun === true;
  if (dry && options.resumeRunId) throw new Error("--dry-run cannot be combined with --resume (a dry run records nothing)");

  const batchSize = options.batchSize ?? 500;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`batch size must be a whole number between 1 and ${MAX_BATCH_SIZE} (got ${batchSize})`);
  }

  // Company names contain non-Latin characters (e.g. "Ŷ", "Ē"); a database
  // created with a legacy encoding (WIN1252 on a default Windows initdb)
  // silently rejects those rows. Fail fast instead.
  const [{ server_encoding }] = await db.$queryRaw<{ server_encoding: string }[]>`SHOW server_encoding`;
  if (server_encoding.toUpperCase() !== "UTF8") {
    throw new Error(`Database encoding is ${server_encoding}; the ingest requires UTF8. Recreate the database with ENCODING 'UTF8'.`);
  }

  // ---- resolve + open the input -------------------------------------------
  let input = options.input;
  if (!input) {
    input = await resolveLatestMonthlyUrl();
    log(`Latest monthly file: ${input}`);
  }
  const localPath = /^https?:\/\//i.test(input)
    ? await downloadToCache(input, options.downloadDir ?? process.env.INGEST_DOWNLOAD_DIR ?? "tmp-ingest", log)
    : input;
  const source = await openCsvFile(localPath);
  const snapshotDate = options.snapshotDate !== undefined ? options.snapshotDate : snapshotDateFromName(localPath.split(/[\\/]/).pop() ?? "");
  const snapshotLabel = snapshotDate ? isoDate(snapshotDate) : null;
  log(snapshotDate ? `Snapshot as-of ${snapshotLabel}: live data newer than this is protected` : "Snapshot date unknown: ALL live (stream/REST) rows are protected from overwrite");

  // ---- create or resume the run ---------------------------------------------
  let run: IngestionRun = { id: "dry-run" } as IngestionRun;
  let startRow = 0;
  if (dry) {
    /* nothing is recorded */
  } else if (options.resumeRunId) {
    const prior = await db.ingestionRun.findUniqueOrThrow({ where: { id: options.resumeRunId } });
    const resumable = prior.kind === "bulk_csv" && (prior.status === "failed" || isStale(prior));
    if (!resumable) {
      source.close();
      throw new Error(`Run ${prior.id} (${prior.kind}/${prior.status}) cannot be resumed - only a failed or stalled bulk_csv run can`);
    }
    if (prior.inputFingerprint !== source.fingerprint) {
      source.close();
      throw new Error(
        `Refusing to resume: the input file differs from the original run (was ${prior.inputFingerprint}, now ${source.fingerprint}).`
      );
    }
    // The checkpoint is written in the same transaction as the rows it covers,
    // so it is exactly "the last data row that is durable (or ledgered)".
    startRow = Number(prior.checkpoint ?? "0");
    run = await db.ingestionRun.update({
      where: { id: prior.id },
      data: { status: "running", finishedAt: null, errorMessage: null, heartbeatAt: new Date() },
    });
    log(`Resuming run ${run.id} after data row ${startRow}`);
  } else {
    run = await startRun("bulk_csv", { inputName: source.name, inputFingerprint: source.fingerprint, checkpoint: "0" });
  }

  const priorStats: PersistedStats = !dry && run.statsJson ? JSON.parse(run.statsJson) : {};
  const mappingStats = priorStats.mapping ?? emptyMappingStats();
  let batchFallbacks = priorStats.batchFallbacks ?? 0;
  const t: Totals = {
    read: run.rowsRead ?? 0,
    inserted: run.rowsInserted ?? 0,
    updated: run.rowsUpdated ?? 0,
    unchanged: priorStats.unchanged ?? 0,
    protectedRows: priorStats.protectedRows ?? 0,
    rejected: priorStats.rejected ?? 0,
    duplicates: priorStats.duplicatesInFile ?? 0,
    failed: run.rowsFailed ?? 0,
  };
  const initialRead = t.read;
  const samples = new ErrorSampler(25);
  if (!dry && run.errorSamples) for (const s of JSON.parse(run.errorSamples)) samples.add(s.row, s.error, s.companyNumber);

  // Memory is bounded: at most one batch of rows + ledger entries is buffered
  // (the parser is consumed with for-await, i.e. with back-pressure).
  let batch: { row: CompanyCsvRow; index: number; raw: Record<string, string> }[] = [];
  let ledger: LedgerEntry[] = [];
  let consumed = startRow; // last data row fully accounted for in `batch`/`ledger`/`t`
  const seen = dry ? new Set<string>() : null; // dry run only: whole-file duplicate detection

  const progressData = (next: Totals, checkpoint: number): Prisma.IngestionRunUpdateInput => ({
    rowsRead: next.read,
    rowsInserted: next.inserted,
    rowsUpdated: next.updated,
    rowsSkipped: next.rejected + next.duplicates,
    rowsFailed: next.failed,
    rowsProcessed: next.inserted + next.updated,
    checkpoint: String(checkpoint),
    errorSamples: samples.toJson(),
    statsJson: JSON.stringify({
      mapping: mappingStats, duplicatesInFile: next.duplicates, batchFallbacks,
      unchanged: next.unchanged, protectedRows: next.protectedRows, rejected: next.rejected, snapshotDate: snapshotLabel,
    } satisfies PersistedStats),
    heartbeatAt: new Date(),
  });

  // Commits everything buffered so far. The checkpoint only ever moves in the
  // SAME database transaction as the data, ledger entries and counters it
  // covers: it can never be ahead of durable state, and a crash either keeps
  // all of it or none of it.
  async function flush() {
    if (batch.length === 0 && ledger.length === 0) return;
    // A single statement cannot touch the same company twice: keep the last
    // occurrence of a duplicated number, ledger the superseded ones.
    const byNumber = new Map<string, { row: CompanyCsvRow; index: number; raw: Record<string, string> }>();
    for (const item of batch) {
      const earlier = byNumber.get(item.row.companyNumber);
      if (earlier) {
        t.duplicates++;
        samples.add(earlier.index, "duplicate company number within the file (earlier occurrence skipped)", item.row.companyNumber);
        ledger.push({ rowNumber: earlier.index, companyNumber: item.row.companyNumber, kind: "duplicate_in_file", reason: `superseded by a later occurrence at row ${item.index}`, retryState: "permanent" });
      }
      byNumber.set(item.row.companyNumber, item);
    }
    let unique = [...byNumber.values()];
    const protectedNow = await liveNewerNumbers(db, unique.map((u) => u.row.companyNumber), snapshotDate);
    if (protectedNow.size) unique = unique.filter((u) => !protectedNow.has(u.row.companyNumber));

    const checkpoint = consumed;
    try {
      const next = await db.$transaction(
        async (tx) => {
          const res = unique.length ? await upsertBatch(tx, unique.map((u) => u.row), snapshotDate) : { inserted: 0, updated: 0 };
          const n: Totals = {
            ...t,
            inserted: t.inserted + res.inserted,
            updated: t.updated + res.updated,
            unchanged: t.unchanged + (unique.length - res.inserted - res.updated),
            protectedRows: t.protectedRows + protectedNow.size,
          };
          await writeLedger(tx, run.id, ledger);
          await tx.ingestionRun.update({ where: { id: run.id }, data: progressData(n, checkpoint) });
          return n;
        },
        { timeout: 120_000, maxWait: 30_000 }
      );
      Object.assign(t, next);
    } catch (err) {
      // The whole batch rolled back (nothing partial is committed). Something
      // in it was rejected by the database: retry row by row so one bad row
      // costs one ledger entry, not 500. Each row is its own atomic statement.
      batchFallbacks++;
      log(`Batch ending at row ${checkpoint} fell back to per-row inserts (${err instanceof Error ? err.message.slice(0, 120) : err})`);
      const n: Totals = { ...t, protectedRows: t.protectedRows + protectedNow.size };
      for (const item of unique) {
        try {
          const res = await upsertBatch(db, [item.row], snapshotDate);
          n.inserted += res.inserted;
          n.updated += res.updated;
          n.unchanged += 1 - res.inserted - res.updated;
        } catch (rowErr) {
          n.failed++;
          samples.add(item.index, errorText(rowErr), item.row.companyNumber);
          ledger.push({ rowNumber: item.index, companyNumber: item.row.companyNumber, kind: "db_failure", reason: errorText(rowErr), retryState: "retriable", rawJson: rawJsonOf(item.raw) });
        }
      }
      // Crash between the per-row writes and this commit: the batch is simply
      // redone on resume (idempotent); only the counters of those rows are lost.
      await db.$transaction(async (tx) => {
        await writeLedger(tx, run.id, ledger);
        await tx.ingestionRun.update({ where: { id: run.id }, data: progressData(n, checkpoint) });
      });
      Object.assign(t, n);
    }
    batch = [];
    ledger = [];
  }

  // Dry run: classify the batch with read-only SQL, record nothing.
  async function dryFlush() {
    if (batch.length === 0) return;
    const p = await predictBatch(batch.map((b) => b.row), snapshotDate);
    t.inserted += p.inserted;
    t.updated += p.updated;
    t.unchanged += p.unchanged;
    t.protectedRows += p.protectedRows;
    batch = [];
    ledger = [];
  }
  const commit = dry ? dryFlush : flush;

  const finalResult = (status: string, errorRate: number): CsvIngestResult => ({
    runId: run.id,
    status,
    dryRun: dry,
    snapshotDate: snapshotLabel,
    rowsRead: t.read,
    rowsInserted: t.inserted,
    rowsUpdated: t.updated,
    rowsUnchanged: t.unchanged,
    rowsProtected: t.protectedRows,
    rowsRejected: t.rejected,
    rowsDuplicate: t.duplicates,
    rowsFailed: t.failed,
    rowsSkipped: t.rejected + t.duplicates,
    errorRate,
  });

  let interrupted = false;
  try {
    let headersChecked = false;
    const parser = source.stream.pipe(
      parse({
        columns: (header: string[]) => {
          const trimmed = header.map((h) => h.trim());
          const missing = missingColumns(trimmed);
          if (missing.length > 0) {
            throw new Error(`CSV is missing expected column(s): ${missing.join(", ")}. The file format may have changed.`);
          }
          headersChecked = true;
          return trimmed;
        },
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true,
      })
    );

    let rowIndex = 0;
    for await (const record of parser as AsyncIterable<Record<string, string>>) {
      if (options.signal?.aborted) {
        interrupted = true;
        break;
      }
      rowIndex++;
      if (rowIndex <= startRow) continue; // resume: already durable
      if (options.limit !== undefined && t.read - initialRead >= options.limit) break; // row NOT consumed: the checkpoint must not cover it
      t.read++;
      consumed = rowIndex;

      const mapped = mapCsvRecord(record, mappingStats);
      if (!mapped.ok) {
        t.rejected++;
        samples.add(rowIndex, mapped.reason, mapped.companyNumber);
        ledger.push({ rowNumber: rowIndex, companyNumber: mapped.companyNumber ?? null, kind: "rejected", reason: mapped.reason, retryState: "permanent" });
      } else if (seen) {
        if (seen.has(mapped.row.companyNumber)) {
          t.duplicates++;
          samples.add(rowIndex, "duplicate company number within the file", mapped.row.companyNumber);
        } else {
          seen.add(mapped.row.companyNumber);
          batch.push({ row: mapped.row, index: rowIndex, raw: record });
        }
      } else {
        batch.push({ row: mapped.row, index: rowIndex, raw: record });
      }

      if (batch.length + ledger.length >= batchSize) await commit();
      if (t.read % 50_000 === 0) log(`  ${t.read.toLocaleString()} rows read (${t.inserted.toLocaleString()} inserted, ${t.updated.toLocaleString()} updated, ${t.unchanged.toLocaleString()} unchanged, ${t.protectedRows} protected, ${t.rejected + t.duplicates} skipped, ${t.failed} failed)`);
    }
    if (!headersChecked && t.read === 0 && !interrupted) {
      throw new Error("CSV contained a header but no data rows (or no header at all).");
    }
    await commit();

    if (dry) {
      const outcome = classifyRun({ rowsRead: t.read, rowsFailed: t.failed, rowsSkipped: t.rejected + t.duplicates });
      return finalResult(outcome.status === "failed" ? "would-fail" : "ok", outcome.errorRate);
    }

    if (interrupted) {
      await finishRun(run.id, "failed", { errorMessage: `Interrupted at data row ${consumed}; resume with --resume ${run.id}` });
      return finalResult("failed", 0);
    }

    const outcome = classifyRun({ rowsRead: t.read, rowsFailed: t.failed, rowsSkipped: t.rejected + t.duplicates });
    // Refresh planner statistics after a bulk load so the trigram / partial
    // indexes are actually chosen for the first user queries.
    await db.$executeRawUnsafe('ANALYZE "Company"').catch(() => {});
    await finishRun(run.id, outcome.status, {
      errorMessage:
        outcome.status === "success" && t.failed + t.rejected + t.duplicates === 0
          ? null
          : `${t.failed} failed and ${t.rejected + t.duplicates} skipped of ${t.read} rows (${(outcome.errorRate * 100).toFixed(2)}%)` +
            (t.failed ? `; ${t.failed} are retriable: ch:bulk-ingest --retry-failed ${run.id}` : ""),
    });
    return finalResult(outcome.status, outcome.errorRate);
  } catch (err) {
    // Deliberately NOT persisting progress here: buffered rows were never
    // committed, so the stored checkpoint (last committed batch) is the truth.
    if (!dry) await finishRun(run.id, "failed", { errorMessage: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    source.close();
  }
}

// Retries the retriable (database-failure) rows of a run from the ledger. Rows
// that now fail validation become permanent; rows that import are marked
// resolved and the run's counters are adjusted. Safe to repeat.
export async function retryFailedRows(runId: string, options: { log?: (m: string) => void } = {}) {
  const log = options.log ?? (() => {});
  const run = await db.ingestionRun.findUniqueOrThrow({ where: { id: runId } });
  const asOfStr = (run.statsJson ? (JSON.parse(run.statsJson) as PersistedStats).snapshotDate : null) ?? null;
  const asOf = asOfStr ? new Date(`${asOfStr}T00:00:00.000Z`) : null;
  const rows = await db.$queryRaw<{ id: string; rowNumber: number; companyNumber: string | null; rawJson: string | null }[]>`
    SELECT "id", "rowNumber", "companyNumber", "rawJson" FROM "IngestRowFailure"
    WHERE "runId" = ${runId} AND "retryState" = 'retriable' ORDER BY "rowNumber"`;
  const out = { attempted: rows.length, resolved: 0, stillFailing: 0, nowRejected: 0 };
  let dIns = 0, dUpd = 0, dUnch = 0;
  for (const r of rows) {
    const mapped = r.rawJson ? mapCsvRecord(JSON.parse(r.rawJson), emptyMappingStats()) : ({ ok: false, reason: "no stored row to retry" } as const);
    if (!mapped.ok) {
      out.nowRejected++;
      await db.$executeRaw`UPDATE "IngestRowFailure" SET "retryState" = 'permanent', "attempts" = "attempts" + 1, "reason" = ${mapped.reason.slice(0, 500)} WHERE "id" = ${r.id}`;
      continue;
    }
    try {
      const res = await upsertBatch(db, [mapped.row], asOf);
      dIns += res.inserted;
      dUpd += res.updated;
      dUnch += 1 - res.inserted - res.updated;
      out.resolved++;
      await db.$executeRaw`UPDATE "IngestRowFailure" SET "retryState" = 'resolved', "attempts" = "attempts" + 1, "resolvedAt" = now() WHERE "id" = ${r.id}`;
    } catch (err) {
      out.stillFailing++;
      await db.$executeRaw`UPDATE "IngestRowFailure" SET "attempts" = "attempts" + 1, "reason" = ${errorText(err).slice(0, 500)} WHERE "id" = ${r.id}`;
    }
  }
  if (out.resolved + out.nowRejected > 0) {
    const stats: PersistedStats = run.statsJson ? JSON.parse(run.statsJson) : {};
    stats.unchanged = (stats.unchanged ?? 0) + dUnch;
    stats.rejected = (stats.rejected ?? 0) + out.nowRejected;
    await db.ingestionRun.update({
      where: { id: runId },
      data: {
        rowsInserted: { increment: dIns },
        rowsUpdated: { increment: dUpd },
        rowsProcessed: { increment: dIns + dUpd },
        rowsFailed: { decrement: out.resolved + out.nowRejected },
        rowsSkipped: { increment: out.nowRejected },
        statsJson: JSON.stringify(stats),
      },
    });
  }
  log(`Retry of run ${runId}: ${JSON.stringify(out)}`);
  return out;
}

// ===========================================================================
// 2. Advanced Search ingest (dev/test slice of real data via the REST API)
// ===========================================================================
const ADVANCED_SEARCH_PATH = "/advanced-search/companies";

interface AdvancedSearchItem {
  company_number: string;
  company_name: string;
  company_status: string;
  company_type: string;
  date_of_creation?: string;
  registered_office_address?: {
    address_line_1?: string;
    address_line_2?: string;
    locality?: string;
    region?: string;
    postal_code?: string;
  };
}

interface AdvancedSearchResponse {
  items: AdvancedSearchItem[];
  hits: number;
}

async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CompaniesHouseRateLimitError && attempt < 4) {
        await new Promise((r) => setTimeout(r, err.retryAfterMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Exceeded rate-limit retry attempts");
}

function addressToFields(addr: AdvancedSearchItem["registered_office_address"]) {
  return {
    registeredAddress1: addr?.address_line_1 ?? "",
    registeredAddress2: addr?.address_line_2 ?? null,
    registeredCity: addr?.locality ?? "",
    registeredPostcode: normalisePostcode(addr?.postal_code ?? ""),
    registeredCounty: addr?.region ?? null,
  };
}

// `company_status` MUST be one of the real enum values (active, dissolved,
// liquidation, ...) - company_status_detail values are REST-profile only.
export interface SearchIngestOptions {
  status: string;
  limit: number;
  enrichLimit: number; // how many of the fetched companies also get a full REST profile pull (accounts/dormant/SIC/statusDetail)
}

export async function bulkIngestFromSearch(options: SearchIngestOptions) {
  const run = await startRun("advanced_search");
  let rowsRead = 0;
  let rowsSkipped = 0;
  let rowsFailed = 0;
  let rowsInserted = 0;
  let rowsUpdated = 0;
  const samples = new ErrorSampler(25);

  try {
    const pageSize = Math.min(options.limit, 5000);
    const res = await chRestGet<AdvancedSearchResponse>(ADVANCED_SEARCH_PATH, {
      params: { company_status: options.status, size: pageSize, start_index: 0 },
      quotaClass: "backfill",
    });
    const items = (res.items ?? []).slice(0, options.limit);

    for (const item of items) {
      rowsRead++;
      const incorporationDate = parseChDate(item.date_of_creation);
      if (!incorporationDate) {
        rowsSkipped++;
        samples.add(rowsRead, "missing/invalid date_of_creation", item.company_number);
        continue;
      }
      const number = item.company_number.toUpperCase();
      try {
        const existing = await db.company.findUnique({ where: { companyNumber: number }, select: { id: true } });
        await db.company.upsert({
          where: { companyNumber: number },
          create: {
            companyNumber: number,
            name: item.company_name,
            status: item.company_status,
            type: item.company_type,
            incorporationDate,
            ...addressToFields(item.registered_office_address),
            source: "advanced_search",
            chLastFetchedAt: new Date(),
          },
          // Never downgrade provenance/richer fields of a company we already hold.
          update: {
            name: item.company_name,
            status: item.company_status,
            type: item.company_type,
            ...addressToFields(item.registered_office_address),
            chLastFetchedAt: new Date(),
          },
        });
        if (existing) rowsUpdated++;
        else rowsInserted++;
      } catch (err) {
        rowsFailed++;
        samples.add(rowsRead, err instanceof Error ? err.message.split("\n").pop() ?? "failed" : String(err), number);
      }
    }
    await touchRun(run.id, { rowsRead, rowsInserted, rowsUpdated, rowsSkipped, rowsFailed, rowsProcessed: rowsInserted + rowsUpdated });

    // Enrich a bounded subset with the full REST profile.
    for (const item of items.slice(0, options.enrichLimit)) {
      try {
        await withRateLimitRetry(() => syncCompanyProfile(item.company_number, "rest_enrichment", { quotaClass: "backfill" }));
      } catch (err) {
        rowsFailed++;
        samples.add(rowsRead, `enrich: ${err instanceof Error ? err.message : err}`, item.company_number);
      }
    }

    const outcome = classifyRun({ rowsRead, rowsFailed, rowsSkipped });
    await finishRun(run.id, outcome.status, {
      rowsRead, rowsInserted, rowsUpdated, rowsSkipped, rowsFailed,
      rowsProcessed: rowsInserted + rowsUpdated,
      errorSamples: samples.toJson(),
      errorMessage: rowsFailed + rowsSkipped ? `${rowsFailed} failed, ${rowsSkipped} skipped of ${rowsRead}` : null,
    });
    return { runId: run.id, status: outcome.status, rowsRead, rowsProcessed: rowsInserted + rowsUpdated, rowsFailed, rowsSkipped, hits: res.hits };
  } catch (err) {
    await finishRun(run.id, "failed", {
      rowsRead, rowsInserted, rowsUpdated, rowsSkipped, rowsFailed,
      errorMessage: err instanceof Error ? err.message : String(err),
      errorSamples: samples.toJson(),
    });
    throw err;
  }
}
