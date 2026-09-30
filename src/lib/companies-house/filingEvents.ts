import { db } from "@/lib/db";
import { syncCompanyProfile } from "./sync";
import { CompaniesHouseNotFoundError, CompaniesHouseRateLimitError } from "./client";
import { parseChDate } from "./csv/dates";

// Filing types that change Company state. DS01 = application to strike the
// company off; DS02 = withdrawal of that application.
export const STATE_CHANGING_TYPES = new Set(["DS01", "DS02"]);

export interface ParsedFilingEvent {
  transactionId: string;
  companyNumber: string;
  type: string;
  date: string | null;
  description: string | null;
  resourceUri: string;
  timepoint: number | null;
}

function extractCompanyNumber(resourceUri: string): string | null {
  const match = resourceUri.match(/\/company\/([^/]+)\/filing-history/);
  return match ? match[1].toUpperCase() : null;
}

// Returns null (never throws) for anything that is not a well-formed
// filing-history event - malformed stream lines are skipped, not fatal.
export function parseFilingEvent(raw: unknown): ParsedFilingEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const ev = raw as {
    resource_uri?: unknown;
    data?: { type?: unknown; date?: unknown; description?: unknown; transaction_id?: unknown };
    event?: { timepoint?: unknown };
  };
  const data = ev.data;
  if (typeof ev.resource_uri !== "string" || !data || typeof data.transaction_id !== "string" || !data.transaction_id) {
    return null;
  }
  const companyNumber = extractCompanyNumber(ev.resource_uri);
  if (!companyNumber) return null;
  return {
    transactionId: data.transaction_id,
    companyNumber,
    type: typeof data.type === "string" ? data.type : "unknown",
    date: typeof data.date === "string" ? data.date : null,
    description: typeof data.description === "string" ? data.description : null,
    resourceUri: ev.resource_uri,
    timepoint: typeof ev.event?.timepoint === "number" ? ev.event.timepoint : null,
  };
}

export function shouldStore(type: string): boolean {
  return STATE_CHANGING_TYPES.has(type) || process.env.STREAM_STORE_ALL === "1";
}

// Persist an event exactly once. The unique transactionId is the duplicate
// guard: a replayed/overlapping event is reported as `duplicate`, never
// inserted twice and never re-applied.
export async function persistFilingEvent(p: ParsedFilingEvent): Promise<{ status: "created" | "duplicate"; id: string }> {
  const existing = await db.filingEvent.findUnique({ where: { transactionId: p.transactionId }, select: { id: true } });
  if (existing) return { status: "duplicate", id: existing.id };

  const company = await db.company.findUnique({ where: { companyNumber: p.companyNumber }, select: { id: true } });
  // ON CONFLICT DO NOTHING: if two workers race, exactly one insert wins.
  const { count } = await db.filingEvent.createMany({
    data: [
      {
        companyId: company?.id ?? null,
        companyNumber: p.companyNumber,
        transactionId: p.transactionId,
        type: p.type,
        date: p.date,
        description: p.description,
        resourceUri: p.resourceUri,
        timepoint: p.timepoint !== null ? BigInt(p.timepoint) : null,
        applyStatus: STATE_CHANGING_TYPES.has(p.type) ? "pending" : "ignored",
      },
    ],
    skipDuplicates: true,
  });
  const row = await db.filingEvent.findUniqueOrThrow({ where: { transactionId: p.transactionId }, select: { id: true } });
  return { status: count === 1 ? "created" : "duplicate", id: row.id };
}

// Applies a persisted DS01/DS02 event to its Company. Idempotent: applying
// an already-applied event is a no-op. If the company is not in our database
// yet its profile is fetched first; if Companies House cannot be reached
// (rate limit etc.) the event stays `pending` with lastError and is retried
// by reconcilePendingFilingEvents - it is never dropped.
export async function applyFilingEvent(eventId: string): Promise<"applied" | "pending" | "ignored"> {
  const event = await db.filingEvent.findUnique({ where: { id: eventId } });
  if (!event) return "ignored";
  if (event.applyStatus === "applied") return "applied";
  if (!STATE_CHANGING_TYPES.has(event.type)) return "ignored";

  try {
    let company = await db.company.findUnique({ where: { companyNumber: event.companyNumber } });
    if (!company) {
      company = await syncCompanyProfile(event.companyNumber, "stream");
    }

    const eventDate = parseChDate(event.date) ?? new Date(Date.UTC(event.processedAt.getUTCFullYear(), event.processedAt.getUTCMonth(), event.processedAt.getUTCDate()));

    if (event.type === "DS01") {
      // Keep the newest DS01 date if somehow replayed out of order.
      const filedAt = company.ds01FiledAt && company.ds01FiledAt > eventDate ? company.ds01FiledAt : eventDate;
      await db.$transaction([
        db.company.update({ where: { id: company.id }, data: { hasDS01: true, ds01FiledAt: filedAt } }),
        db.filingEvent.update({
          where: { id: event.id },
          data: { companyId: company.id, applyStatus: "applied", appliedAt: new Date(), lastError: null },
        }),
      ]);
    } else {
      // DS02 withdraws the strike-off application. Only clears a DS01 that was
      // filed on or before the withdrawal.
      const clears = !company.ds01FiledAt || company.ds01FiledAt <= eventDate;
      await db.$transaction([
        ...(clears
          ? [
              db.company.update({
                where: { id: company.id },
                data: { ds01FiledAt: null, hasDS01: company.statusDetail === "active-proposal-to-strike-off" },
              }),
            ]
          : []),
        db.filingEvent.update({
          where: { id: event.id },
          data: { companyId: company.id, applyStatus: "applied", appliedAt: new Date(), lastError: null },
        }),
      ]);
    }
    return "applied";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof CompaniesHouseNotFoundError) {
      // The company does not exist on the register (yet). Keep retrying a few
      // times via reconcile, but make the reason visible.
      await db.filingEvent.update({ where: { id: event.id }, data: { lastError: `company not found: ${message}` } });
      return "pending";
    }
    await db.filingEvent.update({ where: { id: event.id }, data: { lastError: message.slice(0, 500) } });
    if (err instanceof CompaniesHouseRateLimitError) throw err; // let the caller back off
    return "pending";
  }
}

// Retries every pending DS01/DS02 event (oldest first). Returns counts.
export async function reconcilePendingFilingEvents(limit = 200): Promise<{ applied: number; stillPending: number }> {
  const pending = await db.filingEvent.findMany({
    where: { applyStatus: "pending", type: { in: [...STATE_CHANGING_TYPES] } },
    orderBy: { processedAt: "asc" },
    take: limit,
    select: { id: true },
  });
  let applied = 0;
  let stillPending = 0;
  for (const p of pending) {
    try {
      const result = await applyFilingEvent(p.id);
      if (result === "applied") applied++;
      else stillPending++;
    } catch (err) {
      if (err instanceof CompaniesHouseRateLimitError) {
        stillPending += pending.length - applied - stillPending;
        break;
      }
      stillPending++;
    }
  }
  return { applied, stillPending };
}
