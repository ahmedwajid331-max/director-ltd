// Long-lived filing-stream consumer (run as an always-on process).
//   npm run ch:stream                     run until stopped (Ctrl+C / SIGTERM: clean stop)
//   npm run ch:stream -- --max-seconds 60 run for a bounded time (tests / catch-up)
// Reconnects automatically and resumes from the stored checkpoint.
import { runStreamWorker } from "../src/lib/companies-house/streamWorker";
import { db } from "../src/lib/db";

const args = process.argv.slice(2);
const maxSeconds = args.includes("--max-seconds") ? Number(args[args.indexOf("--max-seconds") + 1]) : undefined;

const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n${sig} received - stopping stream worker...`);
    controller.abort();
  });
}

runStreamWorker({
  signal: controller.signal,
  maxRuntimeMs: maxSeconds ? maxSeconds * 1000 : undefined,
  onEvent: (msg) => console.log(`[${new Date().toISOString()}] ${msg}`),
})
  .then(async () => {
    await db.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("Stream worker failed:", err instanceof Error ? err.message : err);
    await db.$disconnect().catch(() => {});
    process.exit(1);
  });
