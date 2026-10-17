// Dedicated officer synchronisation worker (all officer fetching lives here;
// the daily update only enqueues).
//
//   npm run ch:officer-worker -- --status                 read-only health snapshot, no API calls
//   npm run ch:officer-worker -- --limit 500              process up to 500 companies, then stop
//   npm run ch:officer-worker -- --limit 500 --crawl      ...and also walk the background crawl (P5)
//   npm run ch:officer-worker -- --crawl --max-minutes 60 run the crawl for an hour
//   npm run ch:officer-worker -- --reset-breaker auth     clear the 401/403 circuit breaker
//   npm run ch:officer-worker -- --retry-parked           put parked companies back in the queue
//
// Safe defaults: the background crawl is OPT-IN (--crawl). Without it only
// already-queued work (reports, followed companies, director-filter requests,
// refreshes) is processed. Every request goes through the shared Companies
// House quota gate; a 401/403 circuit breaker stops the worker.
import { runOfficerWorker } from "../src/lib/companies-house/officerWorker";
import { loadOfficerPipelineStatus } from "../src/lib/companies-house/officerStatus";
import { retryParkedJobs } from "../src/lib/companies-house/officerQueue";
import { resetBreaker, type BreakerName } from "../src/lib/companies-house/breaker";
import { JobAlreadyRunningError } from "../src/lib/jobs/runs";
import { db } from "../src/lib/db";
import { makeLogger } from "../src/lib/log";

const logger = makeLogger("officer-worker");
const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const value = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const numberArg = (flag: string): number | undefined => {
  const v = value(flag);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number`);
  return n;
};

async function main() {
  if (has("--status")) {
    const status = await loadOfficerPipelineStatus();
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  if (has("--reset-breaker")) {
    const which = (value("--reset-breaker") ?? "auth") as BreakerName;
    if (which !== "auth" && which !== "outage") throw new Error("--reset-breaker takes 'auth' or 'outage'");
    await resetBreaker(which);
    logger.info(`Circuit breaker '${which}' reset`);
    return;
  }
  if (has("--retry-parked")) {
    logger.info(`Requeued ${await retryParkedJobs()} parked companies`);
    return;
  }

  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.on(sig, () => controller.abort());

  const limit = numberArg("--limit");
  const minutes = numberArg("--max-minutes");
  const priorityMax = numberArg("--priority-max");
  const stats = await runOfficerWorker({
    maxCompanies: limit,
    maxRuntimeMs: minutes !== undefined ? minutes * 60_000 : undefined,
    priorityMax,
    crawl: has("--crawl"),
    queue: !has("--no-queue"),
    exitWhenIdle: has("--exit-when-idle") || limit !== undefined,
    signal: controller.signal,
    log: (m) => logger.info(m),
  });
  logger.info("Officer worker finished", { ...stats });
  if (stats.stopReason === "auth_breaker" || stats.stopReason === "no_credentials") process.exitCode = 1;
}

main()
  .catch((err) => {
    if (err instanceof JobAlreadyRunningError) logger.warn(err.message);
    else logger.error("Officer worker failed", { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect().catch(() => {});
    process.exit(process.exitCode ?? 0);
  });
