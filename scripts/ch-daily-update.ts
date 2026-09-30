// Manual / scheduled trigger for the daily update job. In production this is
// the exact function an AWS EventBridge scheduled rule -> ECS task calls
// (or the built-in scheduler: npm run jobs:scheduler).
//   npm run ch:daily-update
import { runDailyUpdate } from "../src/lib/companies-house/dailyUpdate";
import { db } from "../src/lib/db";

runDailyUpdate()
  .then(async (result) => {
    console.log("Daily update complete:", result);
    await db.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("Daily update failed:", err instanceof Error ? err.message : err);
    await db.$disconnect().catch(() => {});
    process.exit(1);
  });
