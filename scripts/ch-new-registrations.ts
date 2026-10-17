// Syncs newly registered companies from Companies House (Advanced Search, one request per incorporation day).
//   npm run ch:new-registrations                       resume from the last covered day (or the last bulk snapshot date)
//   npm run ch:new-registrations -- --from 2026-10-01 --to 2026-10-12     an explicit window (backfill / re-check)
// Safe to run any number of times: companies are inserted once and a re-run only refreshes them.
import { syncNewRegistrations } from "../src/lib/companies-house/newRegistrations";
import { isRestConfigured } from "../src/lib/companies-house/client";
import { db } from "../src/lib/db";
import { makeLogger } from "../src/lib/log";

const logger = makeLogger("new-registrations");
const args = process.argv.slice(2);
const val = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
};

const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => controller.abort());

async function main() {
  if (!isRestConfigured()) throw new Error("COMPANIES_HOUSE_API_KEY is not set");
  const result = await syncNewRegistrations({ from: val("--from"), to: val("--to"), signal: controller.signal, log: (m) => logger.info(m) });
  console.log("New registrations sync:", result);
  if (result.status === "failed") process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect().then(() => process.exit(process.exitCode ?? 0)));
