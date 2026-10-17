import type { IngestionRun, Prisma } from "@prisma/client";
import { db } from "@/lib/db";

// Bookkeeping for every background job (bulk CSV, Advanced Search, stream,
// officer backfill, daily update). Design rules:
//  - a job is "alive" only while its heartbeat is fresh; a "running" row with
//    a stale heartbeat is a dead job and is reconciled to "failed", so
//    Settings/Super Admin never show a crashed job as still running;
//  - a run is only "success" if its failure rate is honestly low.

export type RunKind = "advanced_search" | "bulk_csv" | "stream" | "officer_backfill" | "daily_update" | "new_registrations";
export type RunStatus = "running" | "success" | "partial" | "failed";

// Jobs heartbeat at least every minute (stream: every 30s, CSV: every batch).
export const STALE_AFTER_MS = 10 * 60 * 1000;
// The officer worker heartbeats on a timer every ~30s, so a few missed beats
// already mean it is dead.
export const OFFICER_WORKER_STALE_AFTER_MS = 2 * 60 * 1000;

export function staleAfterMs(kind: string): number {
  return kind === "officer_backfill" ? OFFICER_WORKER_STALE_AFTER_MS : STALE_AFTER_MS;
}

// Written by reconcileStaleRuns. A worker that was merely paused (laptop sleep, long GC, DB outage) can heartbeat again
// after being reconciled; such a row is not a real failure.
export const RECONCILED_MESSAGE = "Job stopped without finishing (no heartbeat); marked failed by stale-run reconciliation.";

export function isStale(run: Pick<IngestionRun, "status" | "heartbeatAt"> & { kind?: string }, now: Date = new Date()): boolean {
  return run.status === "running" && now.getTime() - run.heartbeatAt.getTime() > staleAfterMs(run.kind ?? "");
}

// What to show for a run without writing anything (used by Settings/Admin).
export function effectiveStatus(
  run: Pick<IngestionRun, "status" | "heartbeatAt"> & { kind?: string; finishedAt?: Date | null; errorMessage?: string | null },
  now: Date = new Date()
): string {
  // Reconciled as failed, but the worker has heartbeated since and still is: it is alive.
  if (
    run.status === "failed" &&
    run.errorMessage === RECONCILED_MESSAGE &&
    run.finishedAt &&
    run.heartbeatAt > run.finishedAt &&
    now.getTime() - run.heartbeatAt.getTime() <= staleAfterMs(run.kind ?? "")
  ) {
    return "running";
  }
  return isStale(run, now) ? "stalled" : run.status;
}

export async function reconcileStaleRuns(now: Date = new Date()): Promise<number> {
  const data = {
    status: "failed",
    finishedAt: now,
    errorMessage: RECONCILED_MESSAGE,
  };
  const officer = await db.ingestionRun.updateMany({
    where: { status: "running", kind: "officer_backfill", heartbeatAt: { lt: new Date(now.getTime() - OFFICER_WORKER_STALE_AFTER_MS) } },
    data,
  });
  const others = await db.ingestionRun.updateMany({
    where: { status: "running", kind: { not: "officer_backfill" }, heartbeatAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) } },
    data,
  });
  return officer.count + others.count;
}

export class JobAlreadyRunningError extends Error {
  constructor(public kind: string, public runId: string) {
    super(`A ${kind} job is already running (run ${runId}). Wait for it, or pass --force if you are sure it is dead.`);
  }
}

// Kinds that must not overlap with themselves (two daily updates or two bulk
// loads racing would duplicate work and fight over rows). The stream is
// exempt: Companies House itself allows a single connection per key.
const SINGLE_FLIGHT: RunKind[] = ["bulk_csv", "daily_update", "officer_backfill", "advanced_search", "new_registrations"];

export async function startRun(
  kind: RunKind,
  data: Partial<Prisma.IngestionRunUncheckedCreateInput> = {},
  options: { force?: boolean } = {}
) {
  await reconcileStaleRuns();
  const create = { ...data, kind, status: "running" } as Prisma.IngestionRunUncheckedCreateInput;
  if (options.force || !SINGLE_FLIGHT.includes(kind)) return db.ingestionRun.create({ data: create });

  // Single-flight: the check and the insert happen under a PostgreSQL advisory
  // lock (transaction-scoped, so it is safe with a connection pool), so two
  // processes starting at the same instant cannot both see "nothing running".
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"ingestion_run:" + kind}))`;
    const live = await tx.ingestionRun.findFirst({ where: { kind, status: "running" } });
    if (live) throw new JobAlreadyRunningError(kind, live.id);
    return tx.ingestionRun.create({ data: create });
  });
}

export async function touchRun(id: string, patch: Prisma.IngestionRunUpdateInput = {}) {
  await db.ingestionRun.update({ where: { id }, data: { ...patch, heartbeatAt: new Date() } });
  // A live worker touching a row that stale-reconciliation wrongly failed brings it back to running.
  await db.ingestionRun.updateMany({
    where: { id, status: "failed", errorMessage: RECONCILED_MESSAGE },
    data: { status: "running", finishedAt: null, errorMessage: null },
  });
}

export async function finishRun(id: string, status: Exclude<RunStatus, "running">, patch: Prisma.IngestionRunUpdateInput = {}) {
  await db.ingestionRun.update({ where: { id }, data: { ...patch, status, finishedAt: new Date(), heartbeatAt: new Date() } });
}

function envRate(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Outcome of a batch run from its counters.
//   no failures or skips                      -> success
//   failure+skip rate <= 0.1%                 -> success (errors still recorded)
//   <= 5%                                     -> partial
//   > 5%  (or nothing read/processed at all)  -> failed
// Thresholds are overridable (INGEST_SUCCESS_MAX_ERROR_RATE / INGEST_PARTIAL_MAX_ERROR_RATE).
export function classifyRun(counts: { rowsRead: number; rowsFailed: number; rowsSkipped: number }): {
  status: Exclude<RunStatus, "running">;
  errorRate: number;
} {
  const { rowsRead, rowsFailed, rowsSkipped } = counts;
  if (rowsRead === 0) return { status: "failed", errorRate: 0 };
  const errorRate = (rowsFailed + rowsSkipped) / rowsRead;
  if (errorRate === 0) return { status: "success", errorRate };
  if (errorRate <= envRate("INGEST_SUCCESS_MAX_ERROR_RATE", 0.001)) return { status: "success", errorRate };
  if (errorRate <= envRate("INGEST_PARTIAL_MAX_ERROR_RATE", 0.05)) return { status: "partial", errorRate };
  return { status: "failed", errorRate };
}

// Keeps only the first N row-level error samples so a bad file cannot bloat
// the run row, while still showing the operator concrete examples.
export class ErrorSampler {
  private samples: { row: number; companyNumber?: string; error: string }[] = [];
  constructor(private max = 25) {}
  add(row: number, error: string, companyNumber?: string) {
    if (this.samples.length < this.max) this.samples.push({ row, companyNumber, error: error.slice(0, 300) });
  }
  toJson(): string | null {
    return this.samples.length ? JSON.stringify(this.samples) : null;
  }
}
