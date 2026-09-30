// Minimal in-process scheduler for single-container deployments:
//   npm run jobs:scheduler
// - daily update at DAILY_UPDATE_UTC_HOUR (default 03:00 UTC), once per UTC day
// - monthly bulk CSV on MONTHLY_INGEST_DAY (default the 3rd) at MONTHLY_INGEST_UTC_HOUR
//   (default 04:00 UTC) - ONLY if MONTHLY_INGEST_ENABLED=1 (off by default)
// On AWS you can instead run `npm run ch:daily-update` from an EventBridge
// scheduled rule; both are safe together because the run table enforces one
// running job per kind.
import { runDailyUpdate } from "../src/lib/companies-house/dailyUpdate";
import { bulkIngestFromCsv } from "../src/lib/companies-house/bulkIngest";
import { JobAlreadyRunningError, reconcileStaleRuns } from "../src/lib/jobs/runs";
import { db } from "../src/lib/db";
import { makeLogger } from "../src/lib/log";

const logger = makeLogger("scheduler");

const DAILY_HOUR = Number(process.env.DAILY_UPDATE_UTC_HOUR ?? 3);
const MONTHLY_DAY = Number(process.env.MONTHLY_INGEST_DAY ?? 3);
const MONTHLY_HOUR = Number(process.env.MONTHLY_INGEST_UTC_HOUR ?? 4);
const MONTHLY_ENABLED = process.env.MONTHLY_INGEST_ENABLED === "1";

let lastDaily = "";
let lastMonthly = "";
const log = (m: string) => logger.info(m);

async function tick() {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  try {
    await reconcileStaleRuns();
    if (now.getUTCHours() >= DAILY_HOUR && lastDaily !== day) {
      lastDaily = day;
      log("Running daily update");
      log(`Daily update: ${JSON.stringify(await runDailyUpdate())}`);
    }
    if (MONTHLY_ENABLED && now.getUTCDate() >= MONTHLY_DAY && now.getUTCHours() >= MONTHLY_HOUR && lastMonthly !== day.slice(0, 7)) {
      lastMonthly = day.slice(0, 7);
      log("Running monthly bulk ingest");
      log(`Monthly ingest: ${JSON.stringify(await bulkIngestFromCsv({ log }))}`);
    }
  } catch (err) {
    if (err instanceof JobAlreadyRunningError) log(`Skipped: ${err.message}`);
    else log(`Scheduler job failed: ${err instanceof Error ? err.message : err}`);
  }
}

log(`Scheduler started (daily ${DAILY_HOUR}:00 UTC; monthly ingest ${MONTHLY_ENABLED ? `day ${MONTHLY_DAY} ${MONTHLY_HOUR}:00 UTC` : "disabled"})`);
void tick();
const timer = setInterval(tick, 60_000);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    clearInterval(timer);
    await db.$disconnect();
    process.exit(0);
  });
}
