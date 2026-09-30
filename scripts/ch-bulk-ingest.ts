// Usage:
//   npm run ch:bulk-ingest -- --status active --limit 2000 --enrich 200
//   npm run ch:bulk-ingest -- --csv                      (full production CSV path)
//   npm run ch:bulk-ingest -- --csv --limit 5000          (CSV path, capped for testing)
import { bulkIngestFromSearch, bulkIngestFromCsv } from "../src/lib/companies-house/bulkIngest";
import { db } from "../src/lib/db";

function argValue(flag: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

async function main() {
  if (process.argv.includes("--csv")) {
    const limit = argValue("--limit");
    console.log("Starting CSV bulk ingest" + (limit ? ` (limit ${limit})` : " (full file)") + "...");
    const result = await bulkIngestFromCsv({ limit: limit ? Number(limit) : undefined });
    console.log("Done:", result);
    return;
  }

  const status = argValue("--status", "active")!;
  const limit = Number(argValue("--limit", "2000"));
  const enrichLimit = Number(argValue("--enrich", "200"));

  console.log(`Starting Advanced Search ingest: status=${status} limit=${limit} enrich=${enrichLimit}`);
  const result = await bulkIngestFromSearch({ status, limit, enrichLimit });
  console.log("Done:", result);
}

main()
  .then(() => db.$disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect().catch(() => {});
    process.exit(1);
  });
