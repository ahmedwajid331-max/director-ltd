// Long-lived filing-stream consumer for local dev.
//   npm run ch:stream
// Ctrl+C to stop cleanly (the run is marked "success" on a clean abort,
// "failed" on an actual connection error).
import { runStreamWorker } from "../src/lib/companies-house/streamWorker";
import { db } from "../src/lib/db";

const controller = new AbortController();
process.on("SIGINT", () => {
  console.log("\nStopping stream worker...");
  controller.abort();
});

runStreamWorker({ signal: controller.signal, onEvent: (msg) => console.log(msg) })
  .then(async () => {
    console.log("Stream worker stopped.");
    await db.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("Stream worker failed:", err);
    await db.$disconnect().catch(() => {});
    process.exit(1);
  });
