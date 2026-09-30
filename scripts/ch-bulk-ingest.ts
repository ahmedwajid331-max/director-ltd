// Companies House bulk loaders.
//
//   Monthly CSV (production path; accepts the .zip as published, a .csv, or an https URL):
//     npm run ch:bulk-ingest -- --input <file-or-url> [--limit N] [--batch 500]
//     npm run ch:bulk-ingest -- --latest --limit 5000          (download latest monthly file, read 5,000 rows)
//     npm run ch:bulk-ingest -- --resume <runId> --input <same file>
//     npm run ch:bulk-ingest -- --resume-latest --input <same file>
//
//   Advanced Search API slice (small real sample for development):
//     npm run ch:bulk-ingest -- --search --status active --limit 2000 --enrich 200
//
// Safety: loading the whole register (~5.6M rows) needs the explicit flag
//   --i-understand-this-is-the-full-register
// without --limit. Nothing here runs automatically.
import fs from "node:fs";
import { bulkIngestFromCsv, bulkIngestFromSearch } from "../src/lib/companies-house/bulkIngest";
import { db } from "../src/lib/db";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string, fallback?: string) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log("\nInterrupt received - finishing the current batch, then stopping (run stays resumable)...");
    controller.abort();
  });
}

async function main() {
  if (has("--search")) {
    const result = await bulkIngestFromSearch({
      status: val("--status", "active")!,
      limit: Number(val("--limit", "2000")),
      enrichLimit: Number(val("--enrich", "200")),
    });
    console.log("Advanced Search ingest done:", result);
    return;
  }

  const input = val("--input");
  const wantsLatest = has("--latest");
  if (!input && !wantsLatest) {
    console.log("Nothing to do. Use --input <zip|csv|url> or --latest (see the header of scripts/ch-bulk-ingest.ts).");
    return;
  }

  const limit = val("--limit") ? Number(val("--limit")) : undefined;
  if (limit === undefined && !has("--i-understand-this-is-the-full-register")) {
    const local = input && !/^https?:\/\//i.test(input) && fs.existsSync(input) ? fs.statSync(input).size : Infinity;
    if (local > 100 * 1024 * 1024) {
      console.error(
        "Refusing to load a full-size file without --limit. To intentionally load the whole register pass\n" +
          "  --i-understand-this-is-the-full-register"
      );
      process.exit(2);
    }
  }

  let resumeRunId = val("--resume");
  if (has("--resume-latest")) {
    const last = await db.ingestionRun.findFirst({ where: { kind: "bulk_csv", status: { in: ["failed", "running"] } }, orderBy: { startedAt: "desc" } });
    if (!last) throw new Error("No failed/stalled bulk_csv run to resume");
    resumeRunId = last.id;
  }

  console.log(`Starting CSV ingest of ${input ?? "latest monthly file"}${limit ? ` (limit ${limit} rows)` : ""}...`);
  const result = await bulkIngestFromCsv({
    input,
    limit,
    batchSize: val("--batch") ? Number(val("--batch")) : undefined,
    resumeRunId,
    signal: controller.signal,
    log: (m) => console.log(m),
  });
  console.log("Done:", result);
  if (result.status === "failed") process.exitCode = 1;
}

main()
  .then(() => db.$disconnect())
  .then(() => process.exit(process.exitCode ?? 0))
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await db.$disconnect().catch(() => {});
    process.exit(1);
  });
