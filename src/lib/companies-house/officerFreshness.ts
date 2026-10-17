import { db } from "@/lib/db";
import { enqueueOfficerJobs, loadOfficerConfig, OFFICER_PRIORITY, type OfficerQueueConfig } from "./officerQueue";

// Officer data freshness. A company stays "full" after its officers are
// fetched; this module notices when that confirmed data may have changed.
//
// Filing types that change WHO the directors are (and so directorCount).
// Details-only changes (CH01 / CH02 / LLCH01 ...) and secretary filings do not
// alter the count and are ignored. Only filing types the stream actually
// delivers can trigger this: today that is the filings stream the worker is
// already connected to - no separate officers stream is assumed.
export const OFFICER_CHANGE_FILING_TYPES = new Set([
  "AP01", // appointment of a director
  "AP02", // appointment of a corporate director
  "TM01", // termination of a director
  "LLAP01", // LLP: appointment of a member
  "LLAP02", // LLP: appointment of a corporate member
  "LLTM01", // LLP: termination of a member
]);
// A company's incorporation includes its first officers.
export const INCORPORATION_FILING_TYPES = new Set(["NEWINC", "LLIN01"]);

export const isOfficerChangeFiling = (type: string) => OFFICER_CHANGE_FILING_TYPES.has(type) || INCORPORATION_FILING_TYPES.has(type);

export type OfficerFilingEffect = "marked_dirty" | "requeued_unavailable" | "no_action" | "unknown_company";

// A change on a confirmed company marks it dirty (the last confirmed count is
// KEPT, but flagged "changes pending") and queues a P4 refresh. A company with
// no officer data yet will simply be fetched fresh; an unavailable one is
// re-checked when it has just been incorporated.
export async function handleOfficerFiling(companyNumber: string, filingType: string, now: Date = new Date()): Promise<OfficerFilingEffect> {
  if (!isOfficerChangeFiling(filingType)) return "no_action";
  const company = await db.company.findUnique({ where: { companyNumber }, select: { id: true, officersCoverage: true } });
  if (!company) return "unknown_company";

  if (company.officersCoverage === "full") {
    await db.company.update({ where: { id: company.id }, data: { officersDirtyAt: now } });
    await enqueueOfficerJobs([company.id], { priority: OFFICER_PRIORITY.REFRESH, reason: `officer_filing:${filingType}`, coverage: ["full"] });
    return "marked_dirty";
  }
  if (company.officersCoverage === "unavailable" && INCORPORATION_FILING_TYPES.has(filingType)) {
    await enqueueOfficerJobs([company.id], { priority: OFFICER_PRIORITY.REFRESH, reason: `officer_filing:${filingType}`, coverage: ["unavailable"] });
    return "requeued_unavailable";
  }
  return "no_action";
}

// Soft refresh on a detail-page view: confirmed data older than the soft
// threshold is queued for a background refresh. The per-company cooldown is
// the queue row itself: while a job exists (queued, retrying with back-off, or
// parked) a view does not enqueue again, and a completed refresh resets the
// age.
export async function maybeSoftRefresh(
  company: { id: string; officersCoverage: string; officersFetchedAt: Date | null },
  options: { config?: OfficerQueueConfig; now?: Date } = {}
): Promise<boolean> {
  const config = options.config ?? loadOfficerConfig();
  const now = options.now ?? new Date();
  if (company.officersCoverage !== "full" || !company.officersFetchedAt) return false;
  if (now.getTime() - company.officersFetchedAt.getTime() < config.softRefreshDays * 86_400_000) return false;
  const res = await enqueueOfficerJobs([company.id], { priority: OFFICER_PRIORITY.REFRESH, reason: "soft_refresh", coverage: ["full"], cap: 1 });
  return res.inserted > 0;
}
