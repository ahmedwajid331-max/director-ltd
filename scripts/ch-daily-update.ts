// Manual / scheduled trigger for the daily update job. In production this is
// the exact function an AWS EventBridge scheduled rule -> ECS task calls
// (or the built-in scheduler: npm run jobs:scheduler).
//   npm run ch:daily-update
import { runDailyUpdate } from "../src/lib/companies-house/dailyUpdate";
import { db } from "../src/lib/db";
import { makeLogger } from "../src/lib/log";

const logger = makeLogger("daily-update");

runDailyUpdate()
  .then(async (result) => {
    logger.info("Daily update complete", { ...result });
    await db.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error("Daily update failed", { error: err instanceof Error ? err.message : String(err) });
    await db.$disconnect().catch(() => {});
    process.exit(1);
  });
