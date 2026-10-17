import { db } from "@/lib/db";
import { CompaniesHouseRateLimitError, StreamOutOfRangeError, streamFilings } from "./client";
import { applyFilingEvent, parseFilingEvent, persistFilingEvent, reconcilePendingFilingEvents, shouldStore } from "./filingEvents";
import { handleOfficerFiling, isOfficerChangeFiling } from "./officerFreshness";
import { finishRun, startRun, touchRun } from "@/lib/jobs/runs";

const CHECKPOINT_NAME = "filings";
// An event that makes processing throw is retried (the checkpoint has not moved past it) this many times. After that it is
// skipped LOUDLY - counted in stats.failed, written to the run's errorSamples - so one bad event cannot stall the stream forever
// while every later event waits behind it.
export const POISON_AFTER = 3;

// Raised only for a failure while PROCESSING one event (database rejected it, apply threw). Connection and transport errors come
// from the stream iterator itself and are never charged against an event.
class EventProcessingError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

export interface StreamStats {
  connects: number;
  reconnects: number;
  eventsSeen: number;
  malformed: number;
  stored: number;
  duplicates: number;
  applied: number;
  pending: number;
  gaps: number;
  failed: number; // events skipped after repeated processing failures (see POISON_AFTER); each is recorded in errorSamples
  officerDirty: number;
  lastTimepoint: number | null;
  lastPublishedAt?: string | null; // publish time of the newest event seen: how far the stream has caught up
}

export interface StreamWorkerOptions {
  signal?: AbortSignal;
  onEvent?: (msg: string) => void;
  maxRuntimeMs?: number; // stop cleanly after this long (tests, scheduled catch-up runs)
  idleTimeoutMs?: number;
  backoff?: { initialMs: number; maxMs: number };
}

export async function loadCheckpoint(): Promise<number | null> {
  const cp = await db.streamCheckpoint.findUnique({ where: { name: CHECKPOINT_NAME } });
  return cp ? Number(cp.timepoint) : null;
}

async function saveCheckpoint(timepoint: number) {
  await db.streamCheckpoint.upsert({
    where: { name: CHECKPOINT_NAME },
    create: { name: CHECKPOINT_NAME, timepoint: BigInt(timepoint), lastEventAt: new Date() },
    update: { timepoint: BigInt(timepoint), lastEventAt: new Date() },
  });
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

// Long-lived, self-healing consumer of the Companies House filing stream.
//
// Delivery guarantee: AT-LEAST-ONCE with idempotent processing (not
// exactly-once). Every state-changing event (DS01/DS02) is persisted before
// the checkpoint moves past it; after a crash or reconnect the stream is
// replayed from the last checkpoint, and the unique transactionId makes the
// replay harmless. If Companies House no longer holds the checkpoint
// (downtime longer than its backlog) the gap is counted and logged loudly -
// those events cannot be recovered from the stream.
export async function runStreamWorker(options: StreamWorkerOptions = {}): Promise<StreamStats> {
  const log = options.onEvent ?? (() => {});
  const backoff = options.backoff ?? { initialMs: 1000, maxMs: 60_000 };
  const stats: StreamStats = {
    connects: 0, reconnects: 0, eventsSeen: 0, malformed: 0, stored: 0, duplicates: 0, applied: 0, pending: 0, gaps: 0, failed: 0, officerDirty: 0, lastTimepoint: null,
  };
  const errorSamples: { timepoint: number; error: string }[] = [];
  const attempts = new Map<number, number>();
  let current: number | null = null; // timepoint of the event being processed (for failure attribution)

  const run = await startRun("stream");
  const started = Date.now();
  const expired = () => options.maxRuntimeMs !== undefined && Date.now() - started >= options.maxRuntimeMs;
  const stopped = () => options.signal?.aborted || expired();

  const flushStats = () => touchRun(run.id, { rowsRead: stats.eventsSeen, rowsProcessed: stats.applied, statsJson: JSON.stringify(stats) }).catch(() => {});
  const heartbeat = setInterval(flushStats, 30_000);
  // Connection-scoped abort so maxRuntimeMs can end a healthy connection too.
  const runtime = new AbortController();
  options.signal?.addEventListener("abort", () => runtime.abort(), { once: true });
  const runtimeTimer = options.maxRuntimeMs !== undefined ? setTimeout(() => runtime.abort(), options.maxRuntimeMs) : undefined;

  let delay = backoff.initialMs;
  let lastReconcile = Date.now();
  let fatal: unknown = null;

  try {
    const rec = await reconcilePendingFilingEvents().catch(() => ({ applied: 0, stillPending: 0 }));
    if (rec.applied) log(`Applied ${rec.applied} previously pending DS01/DS02 events`);

    while (!stopped()) {
      let checkpoint = await loadCheckpoint();
      let gotEvent = false;
      let sinceSave = 0;
      try {
        log(checkpoint ? `Connecting to filing stream, resuming from timepoint ${checkpoint}` : "Connecting to filing stream (live)");
        stats.connects++;
        if (stats.connects > 1) stats.reconnects++;

        for await (const { event: raw, timepoint } of streamFilings({ signal: runtime.signal, timepoint: checkpoint, idleTimeoutMs: options.idleTimeoutMs })) {
          gotEvent = true;
          current = timepoint;
          delay = backoff.initialMs; // healthy connection: reset backoff
          stats.eventsSeen++;
          const published = (raw as { event?: { published_at?: unknown } } | null)?.event?.published_at;
          if (typeof published === "string" && !Number.isNaN(Date.parse(published + (/[zZ]|[+-]\d\d:?\d\d$/.test(published) ? "" : "Z")))) stats.lastPublishedAt = published;

          const parsed = parseFilingEvent(raw);
          // Officer filings mark the company's confirmed officer data dirty and
          // queue a refresh (local database only - no Companies House call here).
          if (parsed && isOfficerChangeFiling(parsed.type)) {
            try {
              if ((await handleOfficerFiling(parsed.companyNumber, parsed.type)) === "marked_dirty") stats.officerDirty++;
            } catch (err) {
              log(`officer filing ${parsed.type} for ${parsed.companyNumber} not applied: ${err instanceof Error ? err.message : err}`);
            }
          }

          if (!parsed) {
            stats.malformed++;
          } else if (shouldStore(parsed.type)) {
            const { status, id } = await persistFilingEvent(parsed).catch((e) => {
              throw new EventProcessingError(e);
            });
            if (status === "duplicate") stats.duplicates++;
            else stats.stored++;
            if (status === "created" || parsed.type === "DS01" || parsed.type === "DS02") {
              try {
                const res = await applyFilingEvent(id, "stream");
                if (res === "applied") {
                  stats.applied++;
                  if (status === "created") log(`${parsed.type} filing applied: ${parsed.companyNumber}`);
                } else stats.pending++;
              } catch (err) {
                if (err instanceof CompaniesHouseRateLimitError) stats.pending++;
                else throw new EventProcessingError(err);
              }
            }
          }

          if (timepoint !== null) {
            stats.lastTimepoint = timepoint;
            sinceSave++;
            // State-changing events advance the checkpoint immediately (they
            // are already persisted); the rest are batched.
            if ((parsed && shouldStore(parsed.type)) || sinceSave >= 25) {
              await saveCheckpoint(timepoint);
              sinceSave = 0;
            }
          }

          if (Date.now() - lastReconcile > 5 * 60_000) {
            lastReconcile = Date.now();
            await reconcilePendingFilingEvents().catch(() => {});
          }
          if (stopped()) break;
        }
        if (stats.lastTimepoint !== null && sinceSave > 0) await saveCheckpoint(stats.lastTimepoint);
        if (stopped()) break;
        log("Stream connection closed by Companies House; reconnecting");
      } catch (err) {
        if (stats.lastTimepoint !== null && sinceSave > 0) await saveCheckpoint(stats.lastTimepoint).catch(() => {});
        if (stopped()) break;

        if (err instanceof StreamOutOfRangeError) {
          stats.gaps++;
          log(`GAP: checkpoint ${checkpoint} is no longer available from Companies House - events between it and now cannot be recovered. Resuming live.`);
          await db.streamCheckpoint.deleteMany({ where: { name: CHECKPOINT_NAME } });
          checkpoint = null;
          continue;
        }
        if (err instanceof CompaniesHouseRateLimitError) {
          log(`Stream rate limited; waiting ${Math.round(err.retryAfterMs / 1000)}s`);
          await sleep(err.retryAfterMs, runtime.signal);
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        // A failure while processing one event: count it against that event.
        if (err instanceof EventProcessingError && current !== null) {
          const n = (attempts.get(current) ?? 0) + 1;
          attempts.set(current, n);
          if (n >= POISON_AFTER) {
            stats.failed++;
            if (errorSamples.length < 20) errorSamples.push({ timepoint: current, error: message.slice(0, 300) });
            log(`Event at timepoint ${current} failed ${n} times and is skipped: ${message}`);
            await saveCheckpoint(current + 1).catch(() => {});
            attempts.delete(current);
            current = null;
            continue;
          }
        }
        // Bad credentials are not transient - stop instead of hammering the API.
        if (/HTTP 40[13]/.test(message)) {
          fatal = err;
          break;
        }
        log(`Stream error: ${message}. Reconnecting in ${Math.round(delay / 1000)}s`);
        await sleep(delay, runtime.signal);
        delay = Math.min(backoff.maxMs, delay * 2);
        continue;
      }
      if (!gotEvent) {
        await sleep(delay, runtime.signal);
        delay = Math.min(backoff.maxMs, delay * 2);
      }
    }
  } catch (err) {
    fatal = err;
  } finally {
    clearInterval(heartbeat);
    if (runtimeTimer) clearTimeout(runtimeTimer);
  }

  const patch = { rowsRead: stats.eventsSeen, rowsProcessed: stats.applied, rowsFailed: stats.malformed + stats.failed, statsJson: JSON.stringify(stats), ...(errorSamples.length ? { errorSamples: JSON.stringify(errorSamples) } : {}) };
  if (fatal) {
    await finishRun(run.id, "failed", { ...patch, errorMessage: fatal instanceof Error ? fatal.message : String(fatal) });
    throw fatal;
  }
  await finishRun(run.id, "success", patch);
  log(`Stream worker stopped: ${JSON.stringify(stats)}`);
  return stats;
}
