import { db } from "@/lib/db";
import { buildCompanyWhere } from "@/lib/data/companies";
import { isRestConfigured } from "./client";
import { reconcilePendingFilingEvents } from "./filingEvents";
import { enqueueFollowedCompanies, enqueueOfficerJobs, loadOfficerConfig, OFFICER_PRIORITY } from "./officerQueue";
import { hasActiveDirectorRules } from "@/lib/filters/compile";
import { finishRun, reconcileStaleRuns, startRun, touchRun } from "@/lib/jobs/runs";

export interface DailyUpdateOptions {
  // Max companies one report / the followed list may add to the officer queue
  // per run (default OFFICER_ENQUEUE_CAP). 0 disables the orchestration step.
  officerEnqueueCap?: number;
}

export interface DailyUpdateResult {
  staleRunsClosed: number;
  overdueRecomputed: number;
  pendingEventsApplied: number;
  pendingEventsRemaining: number;
  officersQueuedForReports: number;
  officersQueuedForFollowed: number;
  reportsRefreshed: number;
  reportsFailed: number;
}

function utcToday(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

// The scheduled daily job (see README for the AWS shape). Safe to run more
// than once a day. Steps:
//   0. close dead "running" jobs
//   1. recompute overdue flags from stored due dates (both directions)
//   2. apply any DS01/DS02 stream events that could not be applied earlier
//   3. QUEUE officer work for saved director reports (P1) and followed
//      companies (P2). This is orchestration only - a few SQL statements, no
//      Companies House calls. All officer fetching belongs to the dedicated
//      officer worker (npm run ch:officer-worker).
//   4. refresh every report flagged dailyRefresh
// It does NOT re-download company profiles: the monthly bulk file is the
// refresh for profile data, the stream covers DS01 in near real time.
export async function runDailyUpdate(options: DailyUpdateOptions = {}): Promise<DailyUpdateResult> {
  const enqueueCap = options.officerEnqueueCap ?? loadOfficerConfig().enqueueCap;
  const run = await startRun("daily_update");
  // The parent run heartbeats on a timer, so a slow step can never make it
  // look dead to the stale-run reconciliation.
  const heartbeat = setInterval(() => void touchRun(run.id).catch(() => {}), 30_000);
  heartbeat.unref?.();

  const result: DailyUpdateResult = {
    staleRunsClosed: 0,
    overdueRecomputed: 0,
    pendingEventsApplied: 0,
    pendingEventsRemaining: 0,
    officersQueuedForReports: 0,
    officersQueuedForFollowed: 0,
    reportsRefreshed: 0,
    reportsFailed: 0,
  };

  try {
    result.staleRunsClosed = await reconcileStaleRuns();

    // 1. Overdue flags. A company is late only while it is live (active) and
    // its due date has passed; the flag clears again once the date moves on.
    const today = utcToday();
    const counts = await Promise.all([
      db.company.updateMany({ where: { status: "active", accountsNextDue: { lt: today }, accountsOverdue: false }, data: { accountsOverdue: true } }),
      db.company.updateMany({
        where: { accountsOverdue: true, OR: [{ status: { not: "active" } }, { accountsNextDue: null }, { accountsNextDue: { gte: today } }] },
        data: { accountsOverdue: false },
      }),
      db.company.updateMany({ where: { status: "active", confirmationNextDue: { lt: today }, confirmationOverdue: false }, data: { confirmationOverdue: true } }),
      db.company.updateMany({
        where: { confirmationOverdue: true, OR: [{ status: { not: "active" } }, { confirmationNextDue: null }, { confirmationNextDue: { gte: today } }] },
        data: { confirmationOverdue: false },
      }),
    ]);
    result.overdueRecomputed = counts.reduce((s, c) => s + c.count, 0);
    await touchRun(run.id);

    // 2. Pending DS01/DS02 events.
    if (isRestConfigured()) {
      const rec = await reconcilePendingFilingEvents().catch(() => ({ applied: 0, stillPending: 0 }));
      result.pendingEventsApplied = rec.applied;
      result.pendingEventsRemaining = rec.stillPending;
    }

    // 3. Queue officer work (no API calls here). Reports first (P1), then
    // followed companies (P2). Idempotent: re-running never duplicates jobs and
    // keeps the highest priority.
    if (enqueueCap > 0) {
      const reports = await db.report.findMany({ where: { dailyRefresh: true } });
      for (const report of reports) {
        try {
          const filter = JSON.parse(report.filterJson);
          if (!hasActiveDirectorRules(filter)) continue;
          const where = buildCompanyWhere({ filter, mode: "possible", userId: report.ownerId });
          const candidates = await db.company.findMany({
            where: { AND: [where, { officersCoverage: "none" }] },
            select: { id: true },
            orderBy: { id: "asc" },
            take: enqueueCap + 1,
          });
          const queued = await enqueueOfficerJobs(candidates.map((c) => c.id), { priority: OFFICER_PRIORITY.REPORT, reason: "report", cap: enqueueCap });
          result.officersQueuedForReports += queued.inserted;
        } catch {
          /* a broken report must not stop the daily job; the refresh step below records its error */
        }
      }
      result.officersQueuedForFollowed = (await enqueueFollowedCompanies(enqueueCap)).inserted;
      await touchRun(run.id);
    }

    // 4. Report refresh (counts only what the user is allowed to see - the
    // same scope rules as the live search).
    const reports = await db.report.findMany({ where: { dailyRefresh: true } });
    for (const report of reports) {
      try {
        const resultCount = await db.company.count({ where: buildCompanyWhere({ filter: JSON.parse(report.filterJson), userId: report.ownerId }) });
        const now = new Date();
        // lastAutoRefreshAt is written HERE and nowhere else, and only after the count succeeded: it is the one field that
        // means "the scheduled job refreshed this report". A failure (below) records the error and leaves both timestamps alone.
        await db.report.update({ where: { id: report.id }, data: { resultCount, lastRunAt: now, lastAutoRefreshAt: now, lastRefreshError: null } });
        result.reportsRefreshed++;
      } catch (err) {
        result.reportsFailed++;
        await db.report.update({
          where: { id: report.id },
          data: { lastRefreshError: err instanceof Error ? err.message.slice(0, 500) : String(err) },
        });
      }
    }

    const failed = result.reportsFailed;
    const total = result.reportsRefreshed + failed;
    await finishRun(run.id, failed === 0 ? "success" : failed / Math.max(total, 1) > 0.5 ? "failed" : "partial", {
      rowsRead: total,
      rowsProcessed: result.overdueRecomputed + result.reportsRefreshed + result.pendingEventsApplied,
      rowsFailed: failed,
      statsJson: JSON.stringify(result),
    });
    return result;
  } catch (err) {
    await finishRun(run.id, "failed", { errorMessage: err instanceof Error ? err.message : String(err), statsJson: JSON.stringify(result) });
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}
