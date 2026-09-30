import type { IngestionRun, Prisma } from "@prisma/client";
import { db } from "@/lib/db";

// Bookkeeping for every background job (bulk CSV, Advanced Search, stream,
// officer backfill, daily update). Design rules:
//  - a job is "alive" only while its heartbeat is fresh; a "running" row with
//    a stale heartbeat is a dead job and is reconciled to "failed", so
//    Settings/Super Admin never show a crashed job as still running;
//  - a run is only "success" if its failure rate is honestly low.

export type RunKind = "advanced_search" | "bulk_csv" | "stream" | "officer_backfill" | "daily_update";
export type RunStatus = "running" | "success" | "partial" | "failed";

// Jobs heartbeat at least every minute (stream: every 30s, CSV: every batch).
export const STALE_AFTER_MS = 10 * 60 * 1000;

export function isStale(run: Pick<IngestionRun, "status" | "heartbeatAt">, now: Date = new Date()): boolean {
  return run.status === "running" && now.getTime() - run.heartbeatAt.getTime() > STALE_AFTER_MS;
}

// What to show for a run without writing anything (used by Settings/Admin).
export function effectiveStatus(run: Pick<IngestionRun, "status" | "heartbeatAt">, now: Date = new Date()): string {
  return isStale(run, now) ? "stalled" : run.status;
}

export async function reconcileStaleRuns(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
  const res = await db.ingestionRun.updateMany({
    where: { status: "running", heartbeatAt: { lt: cutoff } },
    data: {
      status: "failed",
      finishedAt: now,
      errorMessage: "Job stopped without finishing (no heartbeat); marked failed by stale-run reconciliation.",
    },
  });
  return res.count;
}

export class JobAlreadyRunningError extends Error {
  constructor(public kind: string, public runId: string) {
    super(`A ${kind} job is already running (run ${runId}). Wait for it, or pass --force if you are sure it is dead.`);
  }
}

// Kinds that must not overlap with themselves (two daily updates or two bulk
// loads racing would duplicate work and fight over rows). The stream is
// exempt: Companies House itself allows a single connection per key.
const SINGLE_FLIGHT: RunKind[] = ["bulk_csv", "daily_update", "officer_backfill", "advanced_search"];

export async function startRun(
  kind: RunKind,
  data: Partial<Prisma.IngestionRunUncheckedCreateInput> = {},
  options: { force?: boolean } = {}
) {
  await reconcileStaleRuns();
  if (!options.force && SINGLE_FLIGHT.includes(kind)) {
    const live = await db.ingestionRun.findFirst({ where: { kind, status: "running" } });
    if (live) throw new JobAlreadyRunningError(kind, live.id);
  }
  return db.ingestionRun.create({ data: { ...data, kind, status: "running" } as Prisma.IngestionRunUncheckedCreateInput });
}

export async function touchRun(id: string, patch: Prisma.IngestionRunUpdateInput = {}) {
  await db.ingestionRun.update({ where: { id }, data: { ...patch, heartbeatAt: new Date() } });
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
