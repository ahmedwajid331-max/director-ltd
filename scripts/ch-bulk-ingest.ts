// Companies House bulk loaders.
//
//   Monthly CSV (production path; accepts the .zip as published, a .csv, or an https URL):
//     npm run ch:bulk-ingest -- --input <file-or-url> [--limit N] [--batch 500]
//     npm run ch:bulk-ingest -- --latest --limit 5000          (download latest monthly file, read 5,000 rows)
//     npm run ch:bulk-ingest -- --resume <runId> --input <same file>
//     npm run ch:bulk-ingest -- --resume-latest --input <same file>
//
//   Verify without writing anything (parses the whole file, predicts inserts/updates/unchanged/protected/rejected):
//     npm run ch:bulk-ingest -- --input <file> --dry-run [--snapshot-date YYYY-MM-DD]
//   Retry the database-failed rows of a finished run from its failed-row ledger:
//     npm run ch:bulk-ingest -- --retry-failed <runId>
//   --snapshot-date defaults to the date in the file name; live stream/REST data newer than it is never overwritten.
//
//   Advanced Search API slice (small real sample for development):
//     npm run ch:bulk-ingest -- --search --status active --limit 2000 --enrich 200
//
// Safety: loading the whole register (~5.6M rows) needs the explicit flag
//   --i-understand-this-is-the-full-register
// without --limit. Nothing here runs automatically.
import fs from "node:fs";
import { bulkIngestFromCsv, bulkIngestFromSearch, retryFailedRows } from "../src/lib/companies-house/bulkIngest";
import { db } from "../src/lib/db";
import { makeLogger } from "../src/lib/log";

const logger = makeLogger("bulk-ingest");

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

  if (has("--retry-failed")) {
    const runId = val("--retry-failed");
    if (!runId) throw new Error("--retry-failed needs a run id");
    console.log("Retry result:", await retryFailedRows(runId, { log: (m) => logger.info(m) }));
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

  console.log(`Starting CSV ${has("--dry-run") ? "DRY RUN (writes nothing) " : ""}ingest of ${input ?? "latest monthly file"}${limit ? ` (limit ${limit} rows)` : ""}...`);
  const result = await bulkIngestFromCsv({
    input,
    limit,
    batchSize: val("--batch") ? Number(val("--batch")) : undefined,
    resumeRunId,
    dryRun: has("--dry-run"),
    snapshotDate: val("--snapshot-date") ? new Date(`${val("--snapshot-date")}T00:00:00.000Z`) : undefined,
    signal: controller.signal,
    log: (m) => logger.info(m.trim()),
  });
  logger.info("Bulk CSV ingest finished", { ...result });
  if (result.status === "failed" || result.status === "would-fail") process.exitCode = 1;
}

main()
  .then(() => db.$disconnect())
  .then(() => process.exit(process.exitCode ?? 0))
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await db.$disconnect().catch(() => {});
    process.exit(1);
  });
