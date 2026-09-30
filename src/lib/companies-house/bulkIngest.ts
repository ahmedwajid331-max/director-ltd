import { parse } from "csv-parse";
import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { chRestGet, CompaniesHouseRateLimitError } from "./client";
import { syncCompanyProfile } from "./sync";

// chRestGet prepends the REST base URL itself — this must be a path, not
// an absolute URL (passing an absolute URL here previously produced a
// malformed double-URL that failed DNS resolution).
const ADVANCED_SEARCH_PATH = "/advanced-search/companies";
const BULK_CSV_URL_TEMPLATE = "http://download.companieshouse.gov.uk/BasicCompanyDataAsOneFile-{date}.zip";

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
    registeredPostcode: addr?.postal_code ?? "",
    registeredCounty: addr?.region ?? null,
  };
}

// Real, working query against the Companies House Advanced Search API.
// `company_status` MUST be one of the real enum values (active, dissolved,
// liquidation, ...) — the prior prototype's use of the REST-only
// company_status_detail value here is what caused its HTTP 400s.
export interface SearchIngestOptions {
  status: string;
  limit: number;
  enrichLimit: number; // how many of the fetched companies also get a full REST profile pull (accounts/dormant/SIC/statusDetail)
}

export async function bulkIngestFromSearch(options: SearchIngestOptions) {
  const run = await db.ingestionRun.create({ data: { kind: "bulk_csv", status: "running" } });
  let rowsProcessed = 0;
  let rowsFailed = 0;

  try {
    const pageSize = Math.min(options.limit, 5000);
    const res = await chRestGet<AdvancedSearchResponse>(ADVANCED_SEARCH_PATH, {
      params: { company_status: options.status, size: pageSize, start_index: 0 },
    });

    const items = res.items.slice(0, options.limit);

    for (const item of items) {
      try {
        await db.company.upsert({
          where: { companyNumber: item.company_number },
          create: {
            companyNumber: item.company_number,
            name: item.company_name,
            status: item.company_status,
            type: item.company_type,
            incorporationDate: item.date_of_creation ? new Date(item.date_of_creation) : new Date(0),
            ...addressToFields(item.registered_office_address),
            source: "bulk_import",
            chLastFetchedAt: new Date(),
          },
          update: {
            name: item.company_name,
            status: item.company_status,
            type: item.company_type,
            ...addressToFields(item.registered_office_address),
            source: "bulk_import",
            chLastFetchedAt: new Date(),
          },
        });
        rowsProcessed++;
      } catch (err) {
        rowsFailed++;
        console.error(`Failed to upsert ${item.company_number}:`, err);
      }
    }

    // Enrich a bounded subset with the full REST profile (accounts/dormant/
    // SIC/company_status_detail aren't in the search response at all).
    const toEnrich = items.slice(0, options.enrichLimit);
    for (const item of toEnrich) {
      try {
        await withRateLimitRetry(() => syncCompanyProfile(item.company_number, "rest_enrichment"));
      } catch (err) {
        rowsFailed++;
        console.error(`Failed to enrich ${item.company_number}:`, err);
      }
    }

    await db.ingestionRun.update({
      where: { id: run.id },
      data: { status: "success", finishedAt: new Date(), rowsProcessed, rowsFailed },
    });

    return { rowsProcessed, rowsFailed, hits: res.hits };
  } catch (err) {
    await db.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        rowsProcessed,
        rowsFailed,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

// Production path: streams the official monthly "Free Company Data
// Product" CSV (no API key needed) and upserts in batches. Column names
// are read from the CSV's own header row rather than hardcoded, so this
// tolerates the minor column-set changes Companies House has made over
// past releases. `checkpoint` (row index) lets an interrupted run resume.
export interface CsvIngestOptions {
  url?: string;
  limit?: number; // for dev testing; omit for the full file
  batchSize?: number;
  resumeRun?: string; // an existing IngestionRun id to resume
}

function todayBulkFileUrl(): string {
  const d = new Date();
  const firstOfMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  return BULK_CSV_URL_TEMPLATE.replace("{date}", firstOfMonth);
}

function csvStatusToReal(csvStatus: string): { status: string; statusDetail: string | null; hasDS01: boolean } {
  const normalized = csvStatus.trim().toLowerCase();
  const hasDS01 = normalized.includes("proposal to strike off");
  if (hasDS01) return { status: "active", statusDetail: "active-proposal-to-strike-off", hasDS01: true };
  // The bulk CSV's CompanyStatus column uses capitalized free text
  // ("Active", "Dissolved", ...) that otherwise maps 1:1 to the real enum.
  return { status: normalized.replace(/\s+/g, "-"), statusDetail: null, hasDS01: false };
}

export async function bulkIngestFromCsv(options: CsvIngestOptions = {}) {
  const url = options.url ?? todayBulkFileUrl();
  const batchSize = options.batchSize ?? 500;
  const limit = options.limit;

  const run = options.resumeRun
    ? await db.ingestionRun.findUniqueOrThrow({ where: { id: options.resumeRun } })
    : await db.ingestionRun.create({ data: { kind: "bulk_csv", status: "running", checkpoint: "0" } });

  const startRow = Number(run.checkpoint ?? "0");
  let rowIndex = 0;
  let rowsProcessed = run.rowsProcessed;
  let rowsFailed = run.rowsFailed;
  let batch: Record<string, unknown>[] = [];

  async function flush() {
    if (batch.length === 0) return;
    for (const row of batch) {
      try {
        await db.company.upsert({
          where: { companyNumber: row.companyNumber as string },
          create: row as never,
          update: row as never,
        });
        rowsProcessed++;
      } catch (err) {
        rowsFailed++;
        console.error(`CSV row failed for ${row.companyNumber}:`, err);
      }
    }
    await db.ingestionRun.update({
      where: { id: run.id },
      data: { rowsProcessed, rowsFailed, checkpoint: String(rowIndex) },
    });
    batch = [];
  }

  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`Bulk CSV download failed: HTTP ${res.status} for ${url}`);
    }

    // Note: the file is distributed as a .zip; this expects a pre-unzipped
    // CSV stream at `url` in production (unzip as part of the fetch/pipe
    // step, e.g. via a Lambda that downloads+unzips to S3 first). Kept as a
    // plain stream here so the row-mapping logic is identical either way.
    const nodeStream = Readable.fromWeb(res.body as never);
    const parser = nodeStream.pipe(parse({ columns: true, skip_empty_lines: true, trim: true }));

    for await (const record of parser as AsyncIterable<Record<string, string>>) {
      rowIndex++;
      if (rowIndex <= startRow) continue; // resume past the checkpoint
      if (limit && rowsProcessed >= limit) break;

      const { status, statusDetail, hasDS01 } = csvStatusToReal(record.CompanyStatus ?? "");
      const accountType = (record["Accounts.AccountCategory"] ?? "").trim().toLowerCase() || null;

      batch.push({
        companyNumber: record.CompanyNumber,
        name: record.CompanyName,
        status,
        statusDetail,
        type: (record.CompanyCategory ?? "").trim().toLowerCase().replace(/\s+/g, "-"),
        incorporationDate: record.IncorporationDate ? new Date(record.IncorporationDate) : new Date(0),
        dissolutionDate: record.DissolutionDate ? new Date(record.DissolutionDate) : null,
        dormant: accountType === "dormant",
        accountType,
        sicCodes: [record.SICCode_SicText_1, record.SICCode_SicText_2, record.SICCode_SicText_3, record.SICCode_SicText_4]
          .filter(Boolean)
          .join(","),
        registeredAddress1: record.RegAddress_AddressLine1 ?? "",
        registeredAddress2: record.RegAddress_AddressLine2 ?? null,
        registeredCity: record.RegAddress_PostTown ?? "",
        registeredPostcode: record.RegAddress_PostCode ?? "",
        registeredCounty: record.RegAddress_County ?? null,
        accountsNextDue: record["Accounts.NextDueDate"] ? new Date(record["Accounts.NextDueDate"]) : null,
        accountsOverdue: record["Accounts.NextDueDate"]
          ? new Date(record["Accounts.NextDueDate"]) < new Date()
          : false,
        hasDS01,
        source: "bulk_import",
        chLastFetchedAt: new Date(),
      });

      if (batch.length >= batchSize) await flush();
    }
    await flush();

    await db.ingestionRun.update({
      where: { id: run.id },
      data: { status: "success", finishedAt: new Date() },
    });

    return { rowsProcessed, rowsFailed };
  } catch (err) {
    await db.ingestionRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), errorMessage: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}
