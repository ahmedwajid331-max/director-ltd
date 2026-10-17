import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { chRestGet, CompaniesHouseBreakerOpenError, CompaniesHouseRateLimitError } from "./client";
import { parseChDate } from "./csv/dates";
import { normalisePostcode } from "./csv/mapping";
import { classifyRun, ErrorSampler, finishRun, startRun, touchRun } from "@/lib/jobs/runs";

// New-registration sync: keeps the register current BETWEEN the monthly bulk files.
//
// The monthly Companies House snapshot is published within 5 working days of month end and covers companies up to the end
// of the previous month, so on its own the newest registrations are always missing. This job asks Companies House
// Advanced Search for the companies incorporated on each day of a window (incorporated_from == incorporated_to == the day):
//   - one request per day (about 2,500-3,500 companies on a weekday, the API returns up to 5,000 per request);
//   - every company_status is returned (no status filter), with SIC codes, type, address and incorporation date;
//   - repeatable and idempotent: companies are inserted once (unique company number) and a re-run only refreshes them;
//   - self-healing: the window starts at the last fully covered day (minus a small overlap), so a failed or missed run is
//     recovered by the next one without any manual step.
// Rows held from the live stream / a full REST profile are never overwritten (they are richer than a search hit).
// It does not know accounts due dates, dormant, officers or strike-off detail: those stay at their defaults until the
// monthly bulk file or a full profile fetch fills them in (exactly as for any stream-created company).

const SEARCH_PATH = "/advanced-search/companies";
const PAGE_SIZE = 5000; // documented maximum for `size`
// Re-fetch this many already-covered days each run: a company can appear in search a little after its incorporation day.
export const OVERLAP_DAYS = 2;
// Never look back further than this in one run (a long outage is recovered by the monthly bulk file instead).
export const MAX_LOOKBACK_DAYS = 120;
const DAY_MS = 86_400_000;

export interface NewRegistrationsOptions {
  from?: string; // YYYY-MM-DD, inclusive (default: resume point)
  to?: string; // YYYY-MM-DD, inclusive (default: today, UTC)
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

export interface NewRegistrationsResult {
  runId: string;
  status: string;
  from: string;
  to: string;
  coveredThrough: string | null;
  daysCovered: number;
  rowsRead: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  error: string | null;
}

interface AdvancedSearchItem {
  company_number: string;
  company_name: string;
  company_status: string;
  company_type: string;
  date_of_creation?: string;
  date_of_cessation?: string;
  sic_codes?: string[];
  registered_office_address?: { address_line_1?: string; address_line_2?: string; locality?: string; region?: string; postal_code?: string };
}
interface AdvancedSearchResponse {
  items?: AdvancedSearchItem[];
  hits?: number;
}

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => isoDay(new Date(Date.parse(day + "T00:00:00Z") + n * DAY_MS));
const validDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));

// Pure: which days to ask for. `resumeFrom` is the first day not yet known to be covered.
export function planWindow(input: { today: string; from?: string; to?: string; lastCovered?: string | null; bulkSnapshot?: string | null }): { from: string; to: string } {
  // Never beyond today: a typo or a future date must not push the resume point into the future.
  const to = input.to && input.to < input.today ? input.to : input.today;
  let from: string;
  if (input.from) from = input.from;
  else if (input.lastCovered) from = addDays(input.lastCovered, 1 - OVERLAP_DAYS);
  // First ever run: the monthly file dated D covers up to the end of the previous month, so D itself is the first uncovered day.
  else if (input.bulkSnapshot) from = input.bulkSnapshot;
  else from = addDays(to, -30);
  const floor = addDays(to, -MAX_LOOKBACK_DAYS);
  if (from < floor) from = floor;
  return { from, to };
}

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// Pure: a search hit as a Company row, or the reason it cannot be stored.
export function mapSearchItem(item: AdvancedSearchItem): { ok: true; data: Prisma.CompanyCreateManyInput } | { ok: false; reason: string } {
  const incorporationDate = parseChDate(item.date_of_creation);
  if (!incorporationDate) return { ok: false, reason: "missing/invalid date_of_creation" };
  if (!item.company_number || !item.company_name || !item.company_status || !item.company_type) return { ok: false, reason: "missing required field" };
  const a = item.registered_office_address;
  return {
    ok: true,
    data: {
      companyNumber: item.company_number.toUpperCase(),
      name: item.company_name,
      status: item.company_status,
      type: item.company_type,
      incorporationDate,
      dissolutionDate: parseChDate(item.date_of_cessation),
      sicCodes: (item.sic_codes ?? []).join(","),
      registeredAddress1: a?.address_line_1 ?? "",
      registeredAddress2: a?.address_line_2 ?? null,
      registeredCity: a?.locality ?? "",
      registeredPostcode: normalisePostcode(a?.postal_code ?? ""),
      registeredCounty: a?.region ?? null,
      source: "advanced_search",
      chLastFetchedAt: new Date(),
    },
  };
}

async function fetchDay(day: string, signal?: AbortSignal): Promise<AdvancedSearchResponse> {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      return await chRestGet<AdvancedSearchResponse>(SEARCH_PATH, {
        params: { incorporated_from: day, incorporated_to: day, size: PAGE_SIZE, start_index: 0 },
        quotaClass: "backfill",
        maxQuotaWaitMs: 5 * 60_000,
        timeoutMs: 120_000,
      });
    } catch (err) {
      if (err instanceof CompaniesHouseRateLimitError && attempt < 4) {
        await new Promise((r) => setTimeout(r, Math.max(1000, err.retryAfterMs)));
        continue;
      }
      throw err;
    }
  }
}

// Stores one day. Returns the counters. Throws if the day cannot be stored completely (then the day is NOT covered).
async function storeDay(day: string, signal?: AbortSignal) {
  const res = await fetchDay(day, signal);
  const items = res.items ?? [];
  const hits = res.hits ?? items.length;
  // Deeper paging is not available from this endpoint (start_index beyond the first page errors), so a day larger than
  // one page cannot be read completely. Refuse to claim coverage rather than silently dropping companies.
  if (hits > items.length) throw new Error(`${day}: ${hits} companies match but only ${items.length} could be read in one request`);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const samples = new ErrorSampler(10);
  const mapped: Prisma.CompanyCreateManyInput[] = [];
  items.forEach((item, i) => {
    const m = mapSearchItem(item);
    if (m.ok) mapped.push(m.data);
    else {
      skipped++;
      samples.add(i, m.reason, item.company_number);
    }
  });

  for (let i = 0; i < mapped.length; i += 500) {
    const chunk = mapped.slice(i, i + 500);
    const numbers = chunk.map((c) => c.companyNumber);
    const existing = await db.company.findMany({ where: { companyNumber: { in: numbers } }, select: { companyNumber: true, source: true } });
    const known = new Map(existing.map((e) => [e.companyNumber, e.source]));
    const fresh = chunk.filter((c) => !known.has(c.companyNumber));
    if (fresh.length) {
      // skipDuplicates makes a concurrent writer (the stream creating the same company) harmless.
      const r = await db.company.createMany({ data: fresh, skipDuplicates: true });
      inserted += r.count;
    }
    // Existing rows from the bulk file or an earlier search are refreshed; stream / full-profile rows are left alone.
    for (const c of chunk) {
      const src = known.get(c.companyNumber);
      if (src !== "bulk_import" && src !== "advanced_search") continue;
      await db.company.update({
        where: { companyNumber: c.companyNumber },
        data: {
          name: c.name,
          status: c.status,
          type: c.type,
          dissolutionDate: c.dissolutionDate,
          sicCodes: c.sicCodes,
          registeredAddress1: c.registeredAddress1,
          registeredAddress2: c.registeredAddress2,
          registeredCity: c.registeredCity,
          registeredPostcode: c.registeredPostcode,
          registeredCounty: c.registeredCounty,
          // Only rows this job owns carry its fetch time; a bulk row's provenance and fetch state are not touched.
          ...(src === "advanced_search" ? { chLastFetchedAt: new Date() } : {}),
        },
      });
      updated++;
    }
  }
  return { read: items.length, inserted, updated, skipped, samples: samples.toJson() };
}

async function resumePoint(): Promise<{ lastCovered: string | null; bulkSnapshot: string | null }> {
  const last = await db.ingestionRun.findFirst({ where: { kind: "new_registrations", checkpoint: { not: null, lte: isoDay(new Date()) } }, orderBy: { checkpoint: "desc" }, select: { checkpoint: true } });
  const lastCovered = last?.checkpoint && validDay(last.checkpoint) ? last.checkpoint : null;
  let bulkSnapshot: string | null = null;
  if (!lastCovered) {
    const bulk = await db.ingestionRun.findFirst({ where: { kind: "bulk_csv", status: { in: ["success", "partial"] } }, orderBy: { startedAt: "desc" }, select: { statsJson: true } });
    try {
      const s = bulk?.statsJson ? (JSON.parse(bulk.statsJson) as { snapshotDate?: string | null }).snapshotDate : null;
      if (s && validDay(s)) bulkSnapshot = s;
    } catch {
      /* unreadable stats: fall back to the default window */
    }
  }
  return { lastCovered, bulkSnapshot };
}

export async function syncNewRegistrations(options: NewRegistrationsOptions = {}): Promise<NewRegistrationsResult> {
  const log = options.log ?? (() => {});
  for (const d of [options.from, options.to]) if (d && !validDay(d)) throw new Error(`Invalid date "${d}" (use YYYY-MM-DD)`);
  const today = isoDay(new Date());
  const { lastCovered, bulkSnapshot } = await resumePoint();
  const { from, to } = planWindow({ today, from: options.from, to: options.to, lastCovered, bulkSnapshot });
  const days = from <= to ? daysBetween(from, to) : [];
  log(`New registrations: ${from} to ${to} (${days.length} day(s))${lastCovered ? `, resuming after ${lastCovered}` : ""}`);

  const run = await startRun("new_registrations", { inputName: `${from}..${to}` });
  const totals = { read: 0, inserted: 0, updated: 0, skipped: 0 };
  let covered: string | null = null;
  let daysCovered = 0;
  let error: string | null = null;
  let samples: string | null = null;

  for (const day of days) {
    if (options.signal?.aborted) {
      error = "aborted";
      break;
    }
    try {
      const r = await storeDay(day, options.signal);
      totals.read += r.read;
      totals.inserted += r.inserted;
      totals.updated += r.updated;
      totals.skipped += r.skipped;
      if (r.samples) samples = r.samples;
      covered = day;
      daysCovered++;
      // The checkpoint is "the last day fully stored": it only ever advances over contiguous, completed days.
      await touchRun(run.id, { checkpoint: day, rowsRead: totals.read, rowsInserted: totals.inserted, rowsUpdated: totals.updated, rowsSkipped: totals.skipped, rowsProcessed: totals.inserted + totals.updated });
      log(`  ${day}: ${r.read} read, ${r.inserted} new, ${r.updated} refreshed${r.skipped ? `, ${r.skipped} skipped` : ""}`);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      if (err instanceof CompaniesHouseBreakerOpenError) error = `Companies House unavailable: ${error}`;
      log(`  ${day}: FAILED - ${error}. Stopping; the next run resumes from ${covered ?? "the same point"}.`);
      break; // never skip a failed day: that would leave a hole the checkpoint then claims is covered
    }
  }

  let status: "success" | "partial" | "failed";
  if (error) status = daysCovered > 0 ? "partial" : "failed";
  else status = totals.read === 0 ? "success" : classifyRun({ rowsRead: totals.read, rowsFailed: 0, rowsSkipped: totals.skipped }).status;
  await finishRun(run.id, status, {
    rowsRead: totals.read,
    rowsInserted: totals.inserted,
    rowsUpdated: totals.updated,
    rowsSkipped: totals.skipped,
    rowsProcessed: totals.inserted + totals.updated,
    checkpoint: covered ?? undefined,
    errorMessage: error,
    errorSamples: samples,
    statsJson: JSON.stringify({ from, to, daysCovered, daysRequested: days.length }),
  });
  return { runId: run.id, status, from, to, coveredThrough: covered, daysCovered, rowsRead: totals.read, rowsInserted: totals.inserted, rowsUpdated: totals.updated, rowsSkipped: totals.skipped, error };
}
