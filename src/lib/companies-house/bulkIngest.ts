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
  batchSize?: number;
  resumeRunId?: string;
  downloadDir?: string;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

export interface CsvIngestResult {
  runId: string;
  status: string;
  rowsRead: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  rowsFailed: number;
  errorRate: number;
}

const COMPANY_COLUMNS = [
  "id", "companyNumber", "name", "status", "statusDetail", "type", "incorporationDate", "dissolutionDate",
  "dormant", "accountType", "sicCodes", "registeredAddress1", "registeredAddress2", "registeredCity",
  "registeredPostcode", "registeredCounty", "accountsNextDue", "accountsLastMadeUp", "accountsOverdue",
  "confirmationNextDue", "confirmationLastMadeUp", "confirmationOverdue", "hasDS01", "source",
  "chLastFetchedAt", "createdAt", "updatedAt",
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

// One multi-row INSERT ... ON CONFLICT DO UPDATE per batch. Idempotent (the
// unique companyNumber is the identity) and it deliberately does NOT touch
// officer-derived columns (directorCount, singleDirector, officersCoverage,
// officersFetchedAt) or ds01FiledAt: hasDS01 stays true if a DS01 *event* was
// ever recorded, even if this month's file does not show the strike-off status.
// Returns how many rows were inserted vs updated (xmax = 0 marks an insert).
async function upsertBatch(rows: CompanyCsvRow[]): Promise<{ inserted: number; updated: number }> {
  const now = new Date().toISOString();
  const out = await db.$queryRaw<{ inserted: boolean }[]>(Prisma.sql`
    INSERT INTO "Company" (${Prisma.join(COMPANY_COLUMNS.map((c) => Prisma.raw(`"${c}"`)))})
    VALUES ${Prisma.join(rows.map((r) => rowTuple(r, now)))}
    ON CONFLICT ("companyNumber") DO UPDATE SET
      "name" = EXCLUDED."name",
      "status" = EXCLUDED."status",
      "statusDetail" = EXCLUDED."statusDetail",
      "type" = EXCLUDED."type",
      "incorporationDate" = EXCLUDED."incorporationDate",
      "dissolutionDate" = EXCLUDED."dissolutionDate",
      "dormant" = EXCLUDED."dormant",
      "accountType" = EXCLUDED."accountType",
      "sicCodes" = EXCLUDED."sicCodes",
      "registeredAddress1" = EXCLUDED."registeredAddress1",
      "registeredAddress2" = EXCLUDED."registeredAddress2",
      "registeredCity" = EXCLUDED."registeredCity",
      "registeredPostcode" = EXCLUDED."registeredPostcode",
      "registeredCounty" = EXCLUDED."registeredCounty",
      "accountsNextDue" = EXCLUDED."accountsNextDue",
      "accountsLastMadeUp" = EXCLUDED."accountsLastMadeUp",
      "accountsOverdue" = EXCLUDED."accountsOverdue",
      "confirmationNextDue" = EXCLUDED."confirmationNextDue",
      "confirmationLastMadeUp" = EXCLUDED."confirmationLastMadeUp",
      "confirmationOverdue" = EXCLUDED."confirmationOverdue",
      "hasDS01" = EXCLUDED."hasDS01" OR "Company"."ds01FiledAt" IS NOT NULL,
      "source" = EXCLUDED."source",
      "chLastFetchedAt" = EXCLUDED."chLastFetchedAt",
      "updatedAt" = EXCLUDED."updatedAt"
    RETURNING (xmax = 0) AS inserted`);
  const inserted = out.filter((r) => r.inserted).length;
  return { inserted, updated: out.length - inserted };
}

export async function bulkIngestFromCsv(options: CsvIngestOptions = {}): Promise<CsvIngestResult> {
  const log = options.log ?? (() => {});

  // Company names contain non-Latin characters (e.g. "Ŷ", "Ē"); a database
  // created with a legacy encoding (WIN1252 on a default Windows initdb)
  // silently rejects those rows. Fail fast instead.
  const [{ server_encoding }] = await db.$queryRaw<{ server_encoding: string }[]>`SHOW server_encoding`;
  if (server_encoding.toUpperCase() !== "UTF8") {
    throw new Error(`Database encoding is ${server_encoding}; the ingest requires UTF8. Recreate the database with ENCODING 'UTF8'.`);
  }
  const batchSize = options.batchSize ?? 500;

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

  // ---- create or resume the run ---------------------------------------------
  let run: IngestionRun;
  let startRow = 0;
  if (options.resumeRunId) {
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
    startRow = Number(prior.checkpoint ?? "0");
    run = await db.ingestionRun.update({
      where: { id: prior.id },
      data: { status: "running", finishedAt: null, errorMessage: null, heartbeatAt: new Date() },
    });
    log(`Resuming run ${run.id} after data row ${startRow}`);
  } else {
    run = await startRun("bulk_csv", { inputName: source.name, inputFingerprint: source.fingerprint, checkpoint: "0" });
  }

  let rowIndex = 0;
  let { rowsRead, rowsInserted, rowsUpdated, rowsSkipped, rowsFailed } = run;
  const priorStats = run.statsJson ? (JSON.parse(run.statsJson) as { mapping?: ReturnType<typeof emptyMappingStats>; duplicatesInFile?: number; batchFallbacks?: number }) : {};
  const mappingStats = priorStats.mapping ?? emptyMappingStats();
  let duplicatesInFile = priorStats.duplicatesInFile ?? 0;
  let batchFallbacks = priorStats.batchFallbacks ?? 0;
  const samples = new ErrorSampler(25);
  if (run.errorSamples) for (const s of JSON.parse(run.errorSamples)) samples.add(s.row, s.error, s.companyNumber);

  let batch: { row: CompanyCsvRow; index: number }[] = [];

  async function persistProgress(extra: Prisma.IngestionRunUpdateInput = {}) {
    await touchRun(run.id, {
      rowsRead, rowsInserted, rowsUpdated, rowsSkipped, rowsFailed,
      rowsProcessed: rowsInserted + rowsUpdated,
      checkpoint: String(rowIndex),
      errorSamples: samples.toJson(),
      statsJson: JSON.stringify({ mapping: mappingStats, duplicatesInFile, batchFallbacks }),
      ...extra,
    });
  }

  async function flush() {
    if (batch.length === 0) return;
    // A single statement cannot touch the same company twice: keep the last
    // occurrence of a duplicated number and count the rest as skipped.
    const byNumber = new Map<string, { row: CompanyCsvRow; index: number }>();
    for (const item of batch) {
      if (byNumber.has(item.row.companyNumber)) {
        duplicatesInFile++;
        rowsSkipped++;
        samples.add(item.index, "duplicate company number within the file (earlier occurrence skipped)", item.row.companyNumber);
      }
      byNumber.set(item.row.companyNumber, item);
    }
    const unique = [...byNumber.values()];
    try {
      const res = await upsertBatch(unique.map((u) => u.row));
      rowsInserted += res.inserted;
      rowsUpdated += res.updated;
    } catch (err) {
      // Something in the batch was rejected by the database. Retry row by
      // row so one bad row costs one failure, not 500.
      batchFallbacks++;
      for (const item of unique) {
        try {
          const res = await upsertBatch([item.row]);
          rowsInserted += res.inserted;
          rowsUpdated += res.updated;
        } catch (rowErr) {
          rowsFailed++;
          samples.add(item.index, rowErr instanceof Error ? rowErr.message.split("\n").pop() ?? "row failed" : String(rowErr), item.row.companyNumber);
        }
      }
      log(`Batch ending at row ${rowIndex} fell back to per-row inserts (${err instanceof Error ? err.message.slice(0, 120) : err})`);
    }
    batch = [];
    await persistProgress();
  }

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

    for await (const record of parser as AsyncIterable<Record<string, string>>) {
      if (options.signal?.aborted) {
        interrupted = true;
        break;
      }
      rowIndex++;
      if (rowIndex <= startRow) continue; // resume: already durable
      if (options.limit !== undefined && rowsRead - (run.rowsRead ?? 0) >= options.limit) break;
      rowsRead++;

      const mapped = mapCsvRecord(record, mappingStats);
      if (!mapped.ok) {
        rowsSkipped++;
        samples.add(rowIndex, mapped.reason, mapped.companyNumber);
      } else {
        batch.push({ row: mapped.row, index: rowIndex });
      }

      if (batch.length >= batchSize) await flush();
      if (rowsRead % 50_000 === 0) log(`  ${rowsRead.toLocaleString()} rows read (${rowsInserted.toLocaleString()} inserted, ${rowsUpdated.toLocaleString()} updated, ${rowsSkipped} skipped, ${rowsFailed} failed)`);
    }
    if (!headersChecked && rowsRead === 0 && !interrupted) {
      throw new Error("CSV contained a header but no data rows (or no header at all).");
    }
    await flush();

    if (interrupted) {
      await persistProgress();
      await finishRun(run.id, "failed", { errorMessage: `Interrupted at data row ${rowIndex}; resume with --resume ${run.id}` });
      return summary("failed", 0);
    }

    const outcome = classifyRun({ rowsRead, rowsFailed, rowsSkipped });
    // Refresh planner statistics after a bulk load so the trigram / partial
    // indexes are actually chosen for the first user queries.
    await db.$executeRawUnsafe('ANALYZE "Company"').catch(() => {});
    await persistProgress();
    await finishRun(run.id, outcome.status, {
      errorMessage:
        outcome.status === "success" && rowsFailed + rowsSkipped === 0
          ? null
          : `${rowsFailed} failed and ${rowsSkipped} skipped of ${rowsRead} rows (${(outcome.errorRate * 100).toFixed(2)}%)`,
    });
    return summary(outcome.status, outcome.errorRate);
  } catch (err) {
    await persistProgress().catch(() => {});
    await finishRun(run.id, "failed", { errorMessage: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    source.close();
  }

  function summary(status: string, errorRate: number): CsvIngestResult {
    return { runId: run.id, status, rowsRead, rowsInserted, rowsUpdated, rowsSkipped, rowsFailed, errorRate };
  }
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
        await withRateLimitRetry(() => syncCompanyProfile(item.company_number, "rest_enrichment"));
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
