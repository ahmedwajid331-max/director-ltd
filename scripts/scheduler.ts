// Minimal in-process scheduler for single-container deployments:
//   npm run jobs:scheduler
// - new-registration sync (ON whenever COMPANIES_HOUSE_API_KEY is set; NEW_REGISTRATIONS_ENABLED=0 turns it off):
//   every NEW_REGISTRATIONS_INTERVAL_HOURS (default 6) it fetches companies incorporated since the last covered day
//   (see src/lib/companies-house/newRegistrations.ts). It runs BEFORE the daily update so the daily report refresh
//   sees the newest companies. A failed run is simply resumed by the next one.
// - daily update at DAILY_UPDATE_UTC_HOUR (default 03:00 UTC), once per UTC day
// - monthly bulk CSV on MONTHLY_INGEST_DAY (default the 3rd) at MONTHLY_INGEST_UTC_HOUR
//   (default 04:00 UTC) - ONLY if MONTHLY_INGEST_ENABLED=1 (off by default)
// - officer worker (OFF by default): OFFICER_WORKER_ENABLED=1 keeps the dedicated officer
//   sync worker running alongside (queued work only); OFFICER_CRAWL_ENABLED=1 additionally
//   lets it walk the background crawl. The daily update itself only enqueues officer work.
// - filing stream (OFF by default): STREAM_WORKER_ENABLED=1 keeps the DS01/officer filing stream
//   consumer running inside this process (restarted if it dies). Do NOT also run `npm run ch:stream`:
//   Companies House allows one stream connection per key.
// - the daily update is retried (DAILY_RETRY_MINUTES, default 30, max DAILY_MAX_ATTEMPTS per UTC
//   day, default 5) if it fails, and is skipped if a daily_update run already succeeded today -
//   so restarting the scheduler never runs it twice.
// On AWS you can instead run `npm run ch:daily-update` from an EventBridge
// scheduled rule; both are safe together because the run table enforces one
// running job per kind.
import { runDailyUpdate } from "../src/lib/companies-house/dailyUpdate";
import { bulkIngestFromCsv, snapshotDateFromName } from "../src/lib/companies-house/bulkIngest";
import { resolveLatestMonthlyUrl } from "../src/lib/companies-house/csv/source";
import { runStreamWorker } from "../src/lib/companies-house/streamWorker";
import { syncNewRegistrations } from "../src/lib/companies-house/newRegistrations";
import { isRestConfigured, isStreamConfigured } from "../src/lib/companies-house/client";
import { restartDelayMs, runOfficerWorker } from "../src/lib/companies-house/officerWorker";
import { JobAlreadyRunningError, reconcileStaleRuns } from "../src/lib/jobs/runs";
import { db } from "../src/lib/db";
import { makeLogger } from "../src/lib/log";

const logger = makeLogger("scheduler");

const DAILY_HOUR = Number(process.env.DAILY_UPDATE_UTC_HOUR ?? 3);
const MONTHLY_DAY = Number(process.env.MONTHLY_INGEST_DAY ?? 3);
const MONTHLY_HOUR = Number(process.env.MONTHLY_INGEST_UTC_HOUR ?? 4);
const MONTHLY_ENABLED = process.env.MONTHLY_INGEST_ENABLED === "1";

const OFFICER_WORKER_ENABLED = process.env.OFFICER_WORKER_ENABLED === "1";
const OFFICER_CRAWL_ENABLED = process.env.OFFICER_CRAWL_ENABLED === "1";

const STREAM_ENABLED = process.env.STREAM_WORKER_ENABLED === "1";
const NEW_REG_ENABLED = process.env.NEW_REGISTRATIONS_ENABLED !== "0";
const NEW_REG_INTERVAL_MS = Math.max(1, Number(process.env.NEW_REGISTRATIONS_INTERVAL_HOURS ?? 6)) * 3_600_000;
const NEW_REG_RETRY_MS = 15 * 60_000;
let newRegNextAttempt = 0;
const DAILY_RETRY_MS = Number(process.env.DAILY_RETRY_MINUTES ?? 30) * 60_000;
const DAILY_MAX_ATTEMPTS = Number(process.env.DAILY_MAX_ATTEMPTS ?? 5);

let officerWorkerRunning = false;
let streamRunning = false;
let streamWarned = false;
const streamAbort = new AbortController();
let dailyDay = "";
let dailyAttempts = 0;
let dailyNextAttempt = 0;
const log = (m: string) => logger.info(m);

// The officer worker runs independently of the daily update (separate run row,
// separate single-flight lock). Started at most once at a time per scheduler.
let officerNextStart = 0;
function ensureOfficerWorker() {
  if (!OFFICER_WORKER_ENABLED || officerWorkerRunning || Date.now() < officerNextStart) return;
  officerWorkerRunning = true;
  runOfficerWorker({ crawl: OFFICER_CRAWL_ENABLED, maxRuntimeMs: 55 * 60_000, exitWhenIdle: true, log })
    .then((stats) => {
      officerNextStart = Date.now() + restartDelayMs(stats.stopReason);
    })
    .catch((err) => {
      if (err instanceof JobAlreadyRunningError) {
        officerNextStart = Date.now() + restartDelayMs("already_running");
        log(`Officer worker skipped: ${err.message}`);
      } else {
        officerNextStart = Date.now() + restartDelayMs("error");
        log(`Officer worker failed: ${err instanceof Error ? err.message : err}`);
      }
    })
    .finally(() => {
      officerWorkerRunning = false;
    });
}

// The stream worker is a long-lived consumer; it resumes from its stored
// checkpoint, so a restart (after a crash or a Companies House disconnect that
// exhausted its own retries) loses nothing.
function ensureStreamWorker() {
  if (!STREAM_ENABLED || streamRunning || streamAbort.signal.aborted) return;
  if (!isStreamConfigured()) {
    if (!streamWarned) log("Stream worker NOT started: COMPANIES_HOUSE_STREAM_KEY is not configured");
    streamWarned = true;
    return;
  }
  streamRunning = true;
  runStreamWorker({ signal: streamAbort.signal, onEvent: log })
    .catch((err) => log(`Stream worker stopped: ${err instanceof Error ? err.message : err}`))
    .finally(() => {
      streamRunning = false;
    });
}

// True when a daily_update run already completed (success or partial) today (UTC).
async function dailyDoneToday(day: string): Promise<boolean> {
  const done = await db.ingestionRun.findFirst({
    where: { kind: "daily_update", status: { in: ["success", "partial"] }, startedAt: { gte: new Date(`${day}T00:00:00.000Z`) } },
    select: { id: true },
  });
  return !!done;
}

async function maybeRunDaily(now: Date, day: string) {
  if (now.getUTCHours() < DAILY_HOUR || now.getTime() < dailyNextAttempt) return;
  if (dailyDay !== day) {
    dailyDay = day;
    dailyAttempts = 0;
  }
  if (dailyAttempts >= DAILY_MAX_ATTEMPTS || (await dailyDoneToday(day))) return;
  dailyAttempts++;
  dailyNextAttempt = now.getTime() + DAILY_RETRY_MS; // only matters if this attempt fails
  log(`Running daily update (attempt ${dailyAttempts}/${DAILY_MAX_ATTEMPTS})`);
  try {
    const result = await runDailyUpdate();
    log(`Daily update: ${JSON.stringify(result)}`);
    if (result.reportsFailed > 0) log(`Daily update had ${result.reportsFailed} failed report(s); will retry in ${DAILY_RETRY_MS / 60_000} min if the run was not marked success/partial`);
  } catch (err) {
    if (err instanceof JobAlreadyRunningError) {
      dailyAttempts--; // someone else (e.g. ch:daily-update) is doing it: not a failure
      dailyNextAttempt = 0;
      throw err;
    }
    log(`Daily update FAILED (attempt ${dailyAttempts}/${DAILY_MAX_ATTEMPTS}); retry in ${DAILY_RETRY_MS / 60_000} min: ${err instanceof Error ? err.message : err}`);
  }
}

// Runs the new-registration sync when the last successful one is older than the interval. Restart-safe (the decision is
// read from the run table) and never throws into the scheduler: a failure is logged and retried in 15 minutes.
async function maybeRunNewRegistrations() {
  if (!NEW_REG_ENABLED || !isRestConfigured() || Date.now() < newRegNextAttempt) return;
  const last = await db.ingestionRun.findFirst({ where: { kind: "new_registrations", status: "success" }, orderBy: { startedAt: "desc" }, select: { startedAt: true } });
  if (last && Date.now() - last.startedAt.getTime() < NEW_REG_INTERVAL_MS) return;
  newRegNextAttempt = Date.now() + NEW_REG_RETRY_MS; // only matters if this attempt does not succeed
  try {
    const r = await syncNewRegistrations({ log });
    log(`New registrations: ${r.status}, covered through ${r.coveredThrough ?? "-"}, ${r.rowsInserted} new, ${r.rowsUpdated} refreshed${r.error ? `, error: ${r.error}` : ""}`);
    if (r.status === "success") newRegNextAttempt = 0;
  } catch (err) {
    if (err instanceof JobAlreadyRunningError) log(`New registrations skipped: ${err.message}`);
    else log(`New registrations FAILED; retry in ${NEW_REG_RETRY_MS / 60_000} min: ${err instanceof Error ? err.message : err}`);
  }
}

// Monthly bulk file. Restart-safe and publication-aware: it runs only when the newest PUBLISHED file is newer than the
// snapshot already loaded (read from the run table, not from memory), so a scheduler restart never reloads a file and a
// file that Companies House has not published yet is simply re-checked in an hour instead of the old one being re-run.
let monthlyNextCheck = 0;
async function maybeRunMonthly(now: Date) {
  if (Date.now() < monthlyNextCheck) return;
  monthlyNextCheck = Date.now() + 60 * 60_000;
  const url = await resolveLatestMonthlyUrl(now);
  const published = snapshotDateFromName(url.split("/").pop() ?? "");
  const lastRun = await db.ingestionRun.findFirst({ where: { kind: "bulk_csv", status: { in: ["success", "partial"] } }, orderBy: { startedAt: "desc" }, select: { statsJson: true } });
  let loaded: string | null = null;
  try {
    loaded = lastRun?.statsJson ? ((JSON.parse(lastRun.statsJson) as { snapshotDate?: string | null }).snapshotDate ?? null) : null;
  } catch {
    /* unreadable stats: treat as nothing loaded */
  }
  if (published && loaded && published.toISOString().slice(0, 10) <= loaded) return; // already have the newest published file
  log(`Running monthly bulk ingest (published ${published?.toISOString().slice(0, 10) ?? "unknown"}, loaded ${loaded ?? "none"})`);
  log(`Monthly ingest: ${JSON.stringify(await bulkIngestFromCsv({ input: url, log }))}`);
}

async function tick() {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  try {
    await reconcileStaleRuns();
    ensureOfficerWorker();
    ensureStreamWorker();
    await maybeRunNewRegistrations();
    await maybeRunDaily(now, day);
    if (MONTHLY_ENABLED && now.getUTCDate() >= MONTHLY_DAY && now.getUTCHours() >= MONTHLY_HOUR) await maybeRunMonthly(now);
  } catch (err) {
    if (err instanceof JobAlreadyRunningError) log(`Skipped: ${err.message}`);
    else log(`Scheduler job failed: ${err instanceof Error ? err.message : err}`);
  }
}

log(`Scheduler started (daily ${DAILY_HOUR}:00 UTC; monthly ingest ${MONTHLY_ENABLED ? `day ${MONTHLY_DAY} ${MONTHLY_HOUR}:00 UTC` : "disabled"}; new registrations ${NEW_REG_ENABLED && isRestConfigured() ? `every ${NEW_REG_INTERVAL_MS / 3_600_000}h` : "disabled"}; stream worker ${STREAM_ENABLED ? "on" : "disabled"}; officer worker ${OFFICER_WORKER_ENABLED ? (OFFICER_CRAWL_ENABLED ? "on + crawl" : "on, queue only") : "disabled"})`);
void tick();
const timer = setInterval(tick, 60_000);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
  process.on(sig, async () => {
    clearInterval(timer);
    streamAbort.abort();
    await db.$disconnect();
    process.exit(0);
  });
}
