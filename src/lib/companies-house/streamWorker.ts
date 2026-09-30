import { db } from "@/lib/db";
import { streamFilings } from "./client";
import { syncCompanyProfile } from "./sync";

interface FilingStreamEvent {
  resource_uri?: string;
  data?: {
    type?: string;
    date?: string;
    description?: string;
    transaction_id?: string;
  };
}

function extractCompanyNumber(resourceUri: string): string | null {
  const match = resourceUri.match(/\/company\/([^/]+)\/filing-history/);
  return match ? match[1] : null;
}

// Long-lived consumer of the Companies House filing stream. Persists every
// event to FilingEvent (transactionId is unique, so restarts/overlaps never
// duplicate rows) and, for DS01 events specifically, fetches + upserts the
// full company profile so hasDS01/statusDetail reflect reality within
// seconds of the real filing. Intended to run as an always-on process (see
// npm run ch:stream) — not a scheduled job, the connection itself is the
// point.
export async function runStreamWorker(options: { signal?: AbortSignal; onEvent?: (msg: string) => void } = {}) {
  const run = await db.ingestionRun.create({ data: { kind: "stream_backfill", status: "running" } });
  let rowsProcessed = 0;
  let rowsFailed = 0;
  const log = options.onEvent ?? (() => {});

  try {
    log("Connecting to Companies House filing stream...");
    for await (const raw of streamFilings(options.signal)) {
      const event = raw as FilingStreamEvent;
      const data = event.data;
      if (!data?.transaction_id || !event.resource_uri) continue;

      const companyNumber = extractCompanyNumber(event.resource_uri);
      if (!companyNumber) continue;

      try {
        const existing = await db.filingEvent.findUnique({ where: { transactionId: data.transaction_id } });
        if (existing) continue; // already processed — safe against duplicates/restarts

        const company = await db.company.findUnique({ where: { companyNumber } });

        await db.filingEvent.create({
          data: {
            companyId: company?.id ?? null,
            companyNumber,
            transactionId: data.transaction_id,
            type: data.type ?? "unknown",
            date: data.date ?? null,
            description: data.description ?? null,
            resourceUri: event.resource_uri,
          },
        });

        if (data.type === "DS01") {
          log(`DS01 filing: ${companyNumber}`);
          await syncCompanyProfile(companyNumber, "stream");
        }

        rowsProcessed++;
        if (rowsProcessed % 20 === 0) {
          await db.ingestionRun.update({ where: { id: run.id }, data: { rowsProcessed, rowsFailed } });
        }
      } catch (err) {
        rowsFailed++;
        log(`Error processing event for ${companyNumber}: ${err instanceof Error ? err.message : err}`);
      }
    }

    await db.ingestionRun.update({
      where: { id: run.id },
      data: { status: "success", finishedAt: new Date(), rowsProcessed, rowsFailed },
    });
  } catch (err) {
    await db.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: options.signal?.aborted ? "success" : "failed",
        finishedAt: new Date(),
        rowsProcessed,
        rowsFailed,
        errorMessage: options.signal?.aborted ? null : err instanceof Error ? err.message : String(err),
      },
    });
    if (!options.signal?.aborted) throw err;
  }
}
