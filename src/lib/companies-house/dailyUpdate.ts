import { db } from "@/lib/db";
import { buildCompanyWhere } from "@/lib/data/companies";
import { syncCompanyDirectors } from "./sync";
import { CompaniesHouseRateLimitError, isRestConfigured } from "./client";
import { reconcilePendingFilingEvents } from "./filingEvents";
import { finishRun, reconcileStaleRuns, startRun, touchRun } from "@/lib/jobs/runs";

export interface DailyUpdateOptions {
  officerBackfillBatchSize?: number;
}

export interface DailyUpdateResult {
  staleRunsClosed: number;
  overdueRecomputed: number;
  pendingEventsApplied: number;
  pendingEventsRemaining: number;
  officersBackfilled: number;
  officersFailed: number;
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
//   3. advance the rate-limited officer backfill (own `officer_backfill` run)
//   4. refresh every report flagged dailyRefresh
// It does NOT re-download company profiles: the monthly bulk file is the
// refresh for profile data, the stream covers DS01 in near real time.
export async function runDailyUpdate(options: DailyUpdateOptions = {}): Promise<DailyUpdateResult> {
  const batchSize = options.officerBackfillBatchSize ?? Number(process.env.OFFICER_BACKFILL_BATCH ?? 500);
  const run = await startRun("daily_update");

  const result: DailyUpdateResult = {
    staleRunsClosed: 0,
    overdueRecomputed: 0,
    pendingEventsApplied: 0,
    pendingEventsRemaining: 0,
    officersBackfilled: 0,
    officersFailed: 0,
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

    // 3. Officer backfill: real (non-seed) companies without officer data,
    // active companies first. Bounded per run so the 600 req / 5 min quota
    // is shared fairly; stops cleanly when the quota is exhausted.
    if (isRestConfigured() && batchSize > 0) {
      const backfill = await startRun("officer_backfill");
      let read = 0;
      try {
        const base = { source: { not: "seed" }, officersCoverage: { not: "full" } } as const;
        const active = await db.company.findMany({ where: { ...base, status: "active" }, orderBy: { updatedAt: "asc" }, take: batchSize });
        const others = active.length < batchSize
          ? await db.company.findMany({ where: { ...base, status: { not: "active" } }, orderBy: { updatedAt: "asc" }, take: batchSize - active.length })
          : [];
        for (const company of [...active, ...others]) {
          read++;
          try {
            await syncCompanyDirectors(company.id, company.companyNumber);
            result.officersBackfilled++;
          } catch (err) {
            result.officersFailed++;
            if (err instanceof CompaniesHouseRateLimitError) break;
          }
          if (read % 50 === 0) await touchRun(backfill.id, { rowsRead: read, rowsProcessed: result.officersBackfilled, rowsFailed: result.officersFailed });
        }
        const failedRate = read === 0 ? 0 : result.officersFailed / read;
        await finishRun(backfill.id, failedRate > 0.5 ? "failed" : failedRate > 0.05 ? "partial" : "success", {
          rowsRead: read,
          rowsProcessed: result.officersBackfilled,
          rowsFailed: result.officersFailed,
        });
      } catch (err) {
        await finishRun(backfill.id, "failed", { rowsRead: read, errorMessage: err instanceof Error ? err.message : String(err) });
      }
    }

    // 4. Report refresh (counts only what the user is allowed to see - the
    // same scope rules as the live search).
    const reports = await db.report.findMany({ where: { dailyRefresh: true } });
    for (const report of reports) {
      try {
        const resultCount = await db.company.count({ where: buildCompanyWhere({ filter: JSON.parse(report.filterJson) }) });
        await db.report.update({ where: { id: report.id }, data: { resultCount, lastRunAt: new Date(), lastRefreshError: null } });
        result.reportsRefreshed++;
      } catch (err) {
        result.reportsFailed++;
        await db.report.update({
          where: { id: report.id },
          data: { lastRefreshError: err instanceof Error ? err.message.slice(0, 500) : String(err) },
        });
      }
    }

    const failed = result.officersFailed + result.reportsFailed;
    const total = result.officersBackfilled + result.reportsRefreshed + failed;
    await finishRun(run.id, failed === 0 ? "success" : failed / Math.max(total, 1) > 0.5 ? "failed" : "partial", {
      rowsRead: total,
      rowsProcessed: result.overdueRecomputed + result.officersBackfilled + result.reportsRefreshed + result.pendingEventsApplied,
      rowsFailed: failed,
      statsJson: JSON.stringify(result),
    });
    return result;
  } catch (err) {
    await finishRun(run.id, "failed", { errorMessage: err instanceof Error ? err.message : String(err), statsJson: JSON.stringify(result) });
    throw err;
  }
}
