import { db } from "@/lib/db";
import { compileFilterToWhere } from "@/lib/filters/compile";
import { syncCompanyDirectors } from "./sync";
import { CompaniesHouseRateLimitError, isRestConfigured } from "./client";

export interface DailyUpdateOptions {
  officerBackfillBatchSize?: number;
}

export interface DailyUpdateResult {
  overdueRecomputed: number;
  officersBackfilled: number;
  officersFailed: number;
  reportsRefreshed: number;
  reportsFailed: number;
}

// The real scheduled "daily refresh" job (see README for the AWS shape).
// Runnable locally via `npm run ch:daily-update`. Records an IngestionRun
// so Settings/Super Admin can show a genuine last-run/last-failure status
// instead of a hardcoded "refreshes daily" claim.
export async function runDailyUpdate(options: DailyUpdateOptions = {}): Promise<DailyUpdateResult> {
  const batchSize = options.officerBackfillBatchSize ?? 500;
  const run = await db.ingestionRun.create({ data: { kind: "daily_update", status: "running" } });

  const result: DailyUpdateResult = {
    overdueRecomputed: 0,
    officersBackfilled: 0,
    officersFailed: 0,
    reportsRefreshed: 0,
    reportsFailed: 0,
  };

  try {
    const now = new Date();

    // 1. Recompute overdue flags from stored due-dates — pure DB work, no
    // Companies House calls, always safe to run.
    const overdueAccounts = await db.company.updateMany({
      where: { accountsNextDue: { lt: now }, accountsOverdue: false },
      data: { accountsOverdue: true },
    });
    const overdueConfirmation = await db.company.updateMany({
      where: { confirmationNextDue: { lt: now }, confirmationOverdue: false },
      data: { confirmationOverdue: true },
    });
    result.overdueRecomputed = overdueAccounts.count + overdueConfirmation.count;

    // 2. Rate-limited officer backfill queue: real (non-seed) companies
    // without full officer coverage, active companies first.
    if (isRestConfigured()) {
      const queue = await db.company.findMany({
        where: { source: { not: "seed" }, officersCoverage: { not: "full" } },
        orderBy: [{ status: "asc" }, { updatedAt: "asc" }], // "active" sorts before other real statuses alphabetically is not guaranteed; explicit priority below
        take: batchSize * 2,
      });
      const prioritized = [
        ...queue.filter((c) => c.status === "active"),
        ...queue.filter((c) => c.status !== "active"),
      ].slice(0, batchSize);

      for (const company of prioritized) {
        try {
          await syncCompanyDirectors(company.id, company.companyNumber);
          result.officersBackfilled++;
        } catch (err) {
          result.officersFailed++;
          if (err instanceof CompaniesHouseRateLimitError) {
            // Out of quota for this run — stop rather than fail the whole job.
            break;
          }
        }
      }
    }

    // 3. Refresh every report flagged for daily refresh.
    const reports = await db.report.findMany({ where: { dailyRefresh: true } });
    for (const report of reports) {
      try {
        const filter = JSON.parse(report.filterJson);
        const where = compileFilterToWhere(filter);
        const resultCount = await db.company.count({ where });
        await db.report.update({
          where: { id: report.id },
          data: { resultCount, lastRunAt: new Date(), lastRefreshError: null },
        });
        result.reportsRefreshed++;
      } catch (err) {
        result.reportsFailed++;
        await db.report.update({
          where: { id: report.id },
          data: { lastRefreshError: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    await db.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: result.officersFailed > 0 || result.reportsFailed > 0 ? "partial" : "success",
        finishedAt: new Date(),
        rowsProcessed: result.overdueRecomputed + result.officersBackfilled + result.reportsRefreshed,
        rowsFailed: result.officersFailed + result.reportsFailed,
      },
    });

    return result;
  } catch (err) {
    await db.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}
