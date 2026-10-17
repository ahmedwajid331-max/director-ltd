// Long-lived filing-stream consumer (run as an always-on process).
//   npm run ch:stream                     run until stopped (Ctrl+C / SIGTERM: clean stop)
//   npm run ch:stream -- --max-seconds 60 run for a bounded time (tests / catch-up)
// Reconnects automatically and resumes from the stored checkpoint.
import { runStreamWorker } from "../src/lib/companies-house/streamWorker";
import { db } from "../src/lib/db";
import { makeLogger } from "../src/lib/log";

const logger = makeLogger("stream");

const args = process.argv.slice(2);
const maxSeconds = args.includes("--max-seconds") ? Number(args[args.indexOf("--max-seconds") + 1]) : undefined;

const controller = new AbortController();
// SIGHUP / SIGBREAK: closing the terminal window (Windows sends these) must end the run cleanly, not leave it unfinished.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
  process.on(sig, () => {
    console.log(`\n${sig} received - stopping stream worker...`);
    controller.abort();
  });
}

runStreamWorker({
  signal: controller.signal,
  maxRuntimeMs: maxSeconds ? maxSeconds * 1000 : undefined,
  onEvent: (msg) => logger.info(msg),
})
  .then(async () => {
    await db.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error("Stream worker failed", { error: err instanceof Error ? err.message : String(err) });
    await db.$disconnect().catch(() => {});
    process.exit(1);
  });
