// Manual trigger for the daily update job. In production this is the exact
// function an AWS EventBridge scheduled rule -> Lambda/ECS task would call.
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
    console.error("Daily update failed:", err);
    await db.$disconnect().catch(() => {});
    process.exit(1);
  });
