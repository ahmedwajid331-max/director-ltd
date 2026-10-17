import { db } from "@/lib/db";
import type { QuotaClass } from "./quota";

// Officer sync queue (OfficerSyncJob) + the keyset crawl over the Company
// table. Design rules:
//  - the queue holds only PRIORITISED or FAILED work. The general background
//    crawl (P5) walks the Company table with a persistent keyset cursor, so
//    nothing ever materialises one row per register company;
//  - enqueueing is idempotent: one row per company, the highest priority wins;
//  - claiming uses FOR UPDATE SKIP LOCKED + a lease, so concurrent workers
//    never double-process and a dead worker's jobs return to the queue;
//  - retry state (attempts / lastAttemptAt / nextAttemptAt) is per company
//    with exponential backoff + jitter, and a company that keeps failing is
//    PARKED so it can never monopolise the queue;
//  - systemic failures (429, circuit breaker, outage) never consume attempts.

// Column types are `timestamp` (UTC wall time, no zone) as Prisma writes them.
// Raw SQL must not depend on the database SESSION time zone: instants are
// passed as ISO-8601 strings and cast with ::timestamp (which ignores the
// trailing Z, i.e. keeps the UTC wall time). All instants come from the one
// application clock (never the database's now()), so comparisons are consistent.
const utc = (n: number) => `$${n}::timestamp`;

export const OFFICER_PRIORITY = {
  VIEWING: 0, // inline from the company page, user quota class - never queued
  REPORT: 1, // saved / daily-refresh reports
  FOLLOWED: 2, // followed companies
  FILTER: 3, // ad-hoc director-filter workflow
  REFRESH: 4, // stale / dirty confirmed data
  CRAWL: 5, // general background crawl
} as const;
export type OfficerPriority = (typeof OFFICER_PRIORITY)[keyof typeof OFFICER_PRIORITY];

export interface OfficerQueueConfig {
  leaseMs: number;
  maxAttempts: number; // failures before a job is parked
  backoffMs: number[]; // delay before retry N (index = failures so far - 1); last value repeats
  retryShare: number; // max share of one claimed batch that may be retries
  enqueueCap: number; // max companies one request / report may enqueue
  batchSize: number;
  staleAfterDays: number; // confirmed data older than this is "stale" and re-fetched by the TTL sweep
  softRefreshDays: number; // detail-page view older than this triggers a background refresh
  unavailableRecheckDays: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

export function loadOfficerConfig(env: NodeJS.ProcessEnv = process.env): OfficerQueueConfig {
  const n = (name: string, d: number) => (Number.isFinite(Number(env[name])) && Number(env[name]) > 0 ? Number(env[name]) : d);
  return {
    leaseMs: n("OFFICER_LEASE_MINUTES", 5) * MIN,
    maxAttempts: n("OFFICER_MAX_ATTEMPTS", 6),
    backoffMs: [5 * MIN, 30 * MIN, 2 * HOUR, 8 * HOUR, 24 * HOUR, 72 * HOUR],
    retryShare: 0.1,
    enqueueCap: n("OFFICER_ENQUEUE_CAP", 2000),
    batchSize: n("OFFICER_WORKER_BATCH", 25),
    staleAfterDays: n("OFFICER_STALE_AFTER_DAYS", 180),
    softRefreshDays: n("OFFICER_SOFT_REFRESH_DAYS", 30),
    unavailableRecheckDays: n("OFFICER_UNAVAILABLE_RECHECK_DAYS", 90),
  };
}

// The quota class a job is charged to: refreshes of confirmed data are
// "refresh"; every other background fetch is "backfill" (the first class to
// yield when quota is scarce).
export function quotaClassForPriority(priority: number): QuotaClass {
  if (priority <= OFFICER_PRIORITY.VIEWING) return "user";
  return priority === OFFICER_PRIORITY.REFRESH ? "refresh" : "backfill";
}

// ---------------------------------------------------------------------------
// Retry planning (pure)
// ---------------------------------------------------------------------------
// failuresSoFar >= 1. +/-20% jitter so a wave of failures does not retry in
// lock-step.
export function computeBackoffMs(failuresSoFar: number, config: OfficerQueueConfig, rand: () => number = Math.random): number {
  const idx = Math.min(Math.max(failuresSoFar, 1) - 1, config.backoffMs.length - 1);
  const base = config.backoffMs[idx];
  return Math.round(base * (0.8 + rand() * 0.4));
}

export type FailurePlan =
  | { status: "retry"; attempts: number; nextAttemptAt: Date; parkedAt: null }
  | { status: "parked"; attempts: number; nextAttemptAt: Date; parkedAt: Date };

export function planFailure(attemptsBefore: number, now: Date, config: OfficerQueueConfig, rand: () => number = Math.random): FailurePlan {
  const attempts = attemptsBefore + 1;
  if (attempts >= config.maxAttempts) return { status: "parked", attempts, nextAttemptAt: now, parkedAt: now };
  return { status: "retry", attempts, nextAttemptAt: new Date(now.getTime() + computeBackoffMs(attempts, config, rand)), parkedAt: null };
}

export function retryCapForBatch(batchSize: number, config: OfficerQueueConfig): number {
  return Math.max(1, Math.ceil(batchSize * config.retryShare));
}

// ---------------------------------------------------------------------------
// Enqueue (idempotent)
// ---------------------------------------------------------------------------
export interface EnqueueResult {
  requested: number;
  inserted: number; // new queue rows
  upgraded: number; // already queued/retrying (priority raised if higher)
  ineligible: number; // wrong coverage, seed data, unknown id, or parked/leased (left alone)
  truncated: boolean; // the cap cut the request short
}

const CHUNK = 2000;

// One row per company. Re-enqueueing keeps the HIGHEST priority (lowest
// number) and never bypasses a retry back-off, never un-parks a parked job
// and never touches a leased one.
export async function enqueueOfficerJobs(
  companyIds: string[],
  options: { priority: OfficerPriority; reason: string; coverage?: string[]; cap?: number }
): Promise<EnqueueResult> {
  const cap = options.cap ?? loadOfficerConfig().enqueueCap;
  const unique = [...new Set(companyIds)];
  const ids = unique.slice(0, cap);
  const coverage = options.coverage ?? ["none"];
  let inserted = 0;
  let upgraded = 0;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await db.$queryRawUnsafe<{ inserted: boolean }[]>(
      `WITH eligible AS (
         SELECT c."id" FROM "Company" c
         WHERE c."id" = ANY($1::text[]) AND c."officersCoverage" = ANY($2::text[]) AND c."source" <> 'seed'
       )
       INSERT INTO "OfficerSyncJob" ("companyId","priority","reason","status","enqueuedAt","nextAttemptAt","updatedAt")
       SELECT e."id", $3::int, $4::text, 'queued', $5::timestamp, $5::timestamp, $5::timestamp FROM eligible e
       ON CONFLICT ("companyId") DO UPDATE SET
         "priority" = LEAST("OfficerSyncJob"."priority", EXCLUDED."priority"),
         "reason" = CASE WHEN EXCLUDED."priority" < "OfficerSyncJob"."priority" THEN EXCLUDED."reason" ELSE "OfficerSyncJob"."reason" END,
         "updatedAt" = $5::timestamp
       WHERE "OfficerSyncJob"."status" IN ('queued','retry')
       RETURNING (xmax = 0) AS inserted`,
      chunk,
      coverage,
      options.priority,
      options.reason.slice(0, 80),
      new Date().toISOString()
    );
    for (const r of rows) {
      if (r.inserted) inserted++;
      else upgraded++;
    }
  }

  return {
    requested: unique.length,
    inserted,
    upgraded,
    ineligible: ids.length - inserted - upgraded,
    truncated: unique.length > ids.length,
  };
}

// ---------------------------------------------------------------------------
// Claim / lease
// ---------------------------------------------------------------------------
export interface ClaimedJob {
  companyId: string;
  companyNumber: string;
  priority: number;
  attempts: number;
}

async function claimByStatus(
  status: "queued" | "retry",
  workerId: string,
  limit: number,
  now: Date,
  leaseUntil: Date,
  priorityMax: number
): Promise<ClaimedJob[]> {
  if (limit <= 0) return [];
  // The status literal lets the planner use the partial claim index.
  return db.$queryRawUnsafe<ClaimedJob[]>(
    `UPDATE "OfficerSyncJob" j
        SET "status" = 'leased', "leasedBy" = $1, "leaseUntil" = ${utc(2)}, "lastAttemptAt" = ${utc(3)}, "updatedAt" = ${utc(3)}
       FROM (
         SELECT "companyId" FROM "OfficerSyncJob"
          WHERE "status" = '${status}' AND "nextAttemptAt" <= ${utc(3)} AND "priority" <= $4
          ORDER BY "priority", "nextAttemptAt"
          LIMIT $5
          FOR UPDATE SKIP LOCKED
       ) pick
      WHERE j."companyId" = pick."companyId"
      RETURNING j."companyId", j."priority", j."attempts",
                (SELECT c."companyNumber" FROM "Company" c WHERE c."id" = j."companyId") AS "companyNumber"`,
    workerId,
    leaseUntil.toISOString(),
    now.toISOString(),
    priorityMax,
    limit
  );
}

// Fresh jobs and retries are claimed separately so a failure wave can fill at
// most `retryCap` slots of a batch and never starves new work.
export async function claimOfficerJobs(
  workerId: string,
  options: { limit?: number; priorityMax?: number; now?: Date; config?: OfficerQueueConfig } = {}
): Promise<ClaimedJob[]> {
  const config = options.config ?? loadOfficerConfig();
  const limit = options.limit ?? config.batchSize;
  const now = options.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + config.leaseMs);
  const priorityMax = options.priorityMax ?? OFFICER_PRIORITY.CRAWL;

  const retries = await claimByStatus("retry", workerId, retryCapForBatch(limit, config), now, leaseUntil, priorityMax);
  const fresh = await claimByStatus("queued", workerId, limit - retries.length, now, leaseUntil, priorityMax);
  return [...retries, ...fresh].sort((a, b) => a.priority - b.priority);
}

// Dead worker: its leased jobs go back to the queue without charging an
// attempt (the company did nothing wrong).
export async function releaseExpiredLeases(now: Date = new Date()): Promise<number> {
  const rows = await db.$queryRaw<{ companyId: string }[]>`
    UPDATE "OfficerSyncJob"
       SET "status" = CASE WHEN "attempts" > 0 THEN 'retry' ELSE 'queued' END,
           "leasedBy" = NULL, "leaseUntil" = NULL, "nextAttemptAt" = (${now.toISOString()}::timestamp), "updatedAt" = (${now.toISOString()}::timestamp)
     WHERE "status" = 'leased' AND "leaseUntil" < (${now.toISOString()}::timestamp)
    RETURNING "companyId"`;
  return rows.length;
}

export async function extendLeases(workerId: string, config: OfficerQueueConfig = loadOfficerConfig(), now: Date = new Date()): Promise<number> {
  const res = await db.officerSyncJob.updateMany({
    where: { leasedBy: workerId, status: "leased" },
    data: { leaseUntil: new Date(now.getTime() + config.leaseMs) },
  });
  return res.count;
}

// Systemic problem (429 / breaker / outage): hand the job back, attempts untouched.
export async function releaseJobUncharged(companyId: string, workerId: string, delayMs: number, now: Date = new Date()): Promise<void> {
  await db.$executeRaw`
    UPDATE "OfficerSyncJob"
       SET "status" = CASE WHEN "attempts" > 0 THEN 'retry' ELSE 'queued' END,
           "leasedBy" = NULL, "leaseUntil" = NULL,
           "nextAttemptAt" = (${new Date(now.getTime() + Math.max(0, delayMs)).toISOString()}::timestamp), "updatedAt" = (${now.toISOString()}::timestamp)
     WHERE "companyId" = ${companyId} AND "leasedBy" = ${workerId} AND "status" = 'leased'`;
}

// Hand back every job this worker still holds (graceful shutdown).
export async function releaseWorkerLeases(workerId: string, now: Date = new Date()): Promise<number> {
  const rows = await db.$queryRaw<{ companyId: string }[]>`
    UPDATE "OfficerSyncJob"
       SET "status" = CASE WHEN "attempts" > 0 THEN 'retry' ELSE 'queued' END,
           "leasedBy" = NULL, "leaseUntil" = NULL, "nextAttemptAt" = (${now.toISOString()}::timestamp), "updatedAt" = (${now.toISOString()}::timestamp)
     WHERE "leasedBy" = ${workerId} AND "status" = 'leased'
    RETURNING "companyId"`;
  return rows.length;
}

// A company-specific failure: charge an attempt, back off, park after the cap.
export async function failOfficerJob(
  companyId: string,
  failure: { httpStatus: number | null; error: string },
  options: { config?: OfficerQueueConfig; now?: Date; rand?: () => number; crawl?: { workerId: string } } = {}
): Promise<FailurePlan> {
  const config = options.config ?? loadOfficerConfig();
  const now = options.now ?? new Date();

  if (options.crawl) {
    // A crawl company has no queue row yet: create it so its retry state lives
    // somewhere and the crawl skips it from now on.
    await db.officerSyncJob.createMany({
      data: [{ companyId, priority: OFFICER_PRIORITY.CRAWL, reason: "crawl", status: "leased", leasedBy: options.crawl.workerId, leaseUntil: new Date(now.getTime() + config.leaseMs), lastAttemptAt: now }],
      skipDuplicates: true,
    });
  }

  const job = await db.officerSyncJob.findUnique({ where: { companyId }, select: { attempts: true } });
  const plan = planFailure(job?.attempts ?? 0, now, config, options.rand);
  await db.officerSyncJob.updateMany({
    where: { companyId },
    data: {
      status: plan.status,
      attempts: plan.attempts,
      nextAttemptAt: plan.nextAttemptAt,
      parkedAt: plan.parkedAt,
      lastHttpStatus: failure.httpStatus,
      lastError: failure.error.slice(0, 500),
      leasedBy: null,
      leaseUntil: null,
    },
  });
  return plan;
}

// Super Admin: put parked jobs back in the queue with a clean slate.
export async function retryParkedJobs(options: { companyIds?: string[]; limit?: number } = {}): Promise<number> {
  const where = { status: "parked", ...(options.companyIds ? { companyId: { in: options.companyIds } } : {}) };
  const targets = await db.officerSyncJob.findMany({ where, select: { companyId: true }, take: options.limit ?? 1000 });
  if (targets.length === 0) return 0;
  const res = await db.officerSyncJob.updateMany({
    where: { companyId: { in: targets.map((t) => t.companyId) }, status: "parked" },
    data: { status: "queued", attempts: 0, nextAttemptAt: new Date(), parkedAt: null, lastError: null, lastHttpStatus: null },
  });
  return res.count;
}

// ---------------------------------------------------------------------------
// Background crawl (P5): keyset cursor over Company, never OFFSET
// ---------------------------------------------------------------------------
const CURSOR_NAME = "officers";
export type CrawlPhase = "active" | "other";

export interface CrawlItem {
  id: string;
  companyNumber: string;
}

export interface CrawlSelection {
  items: CrawlItem[];
  phase: CrawlPhase;
  // True when a complete pass found nothing left to fetch.
  exhausted: boolean;
}

export async function loadCrawlCursor(): Promise<{ phase: CrawlPhase; lastId: string; passes: number }> {
  const row = await db.officerCrawlCursor.findUnique({ where: { name: CURSOR_NAME } });
  return { phase: (row?.phase as CrawlPhase) ?? "active", lastId: row?.lastId ?? "", passes: row?.passes ?? 0 };
}

export async function saveCrawlCursor(phase: CrawlPhase, lastId: string, passes?: number): Promise<void> {
  await db.officerCrawlCursor.upsert({
    where: { name: CURSOR_NAME },
    create: { name: CURSOR_NAME, phase, lastId, passes: passes ?? 0 },
    update: { phase, lastId, ...(passes !== undefined ? { passes } : {}) },
  });
}

// Eligible = real company, officersCoverage 'none', no queue row (jobs that
// already exist - retrying or parked - are owned by the queue). Active
// companies are walked first. The WHERE literals match the partial indexes.
async function crawlPage(phase: CrawlPhase, afterId: string, limit: number): Promise<CrawlItem[]> {
  const statusCond = phase === "active" ? `c."status" = 'active'` : `c."status" <> 'active'`;
  return db.$queryRawUnsafe<CrawlItem[]>(
    `SELECT c."id", c."companyNumber" FROM "Company" c
      WHERE c."officersCoverage" = 'none' AND c."source" <> 'seed' AND ${statusCond} AND c."id" > $1
        AND NOT EXISTS (SELECT 1 FROM "OfficerSyncJob" j WHERE j."companyId" = c."id")
      ORDER BY c."id" LIMIT $2`,
    afterId,
    limit
  );
}

// Returns the next batch and where the cursor stands. The caller persists the
// cursor (saveCrawlCursor) only after the batch is processed, so an
// interrupted batch is simply re-selected - already-fetched companies no
// longer match the eligibility predicate.
export async function selectCrawlBatch(limit: number): Promise<CrawlSelection> {
  const cursor = await loadCrawlCursor();
  let { phase, lastId } = cursor;

  for (let hop = 0; hop < 3; hop++) {
    const items = await crawlPage(phase, lastId, limit);
    if (items.length > 0) return { items, phase, exhausted: false };
    if (phase === "active") {
      phase = "other";
      lastId = "";
      await saveCrawlCursor(phase, lastId);
    } else {
      // Wrapped the whole table: restart from the beginning next time.
      await saveCrawlCursor("active", "", cursor.passes + 1);
      return { items: [], phase: "active", exhausted: true };
    }
  }
  return { items: [], phase, exhausted: false };
}

// ---------------------------------------------------------------------------
// Queue orchestration used by dailyUpdate / reports / the UI
// ---------------------------------------------------------------------------
export async function enqueueFollowedCompanies(cap: number = loadOfficerConfig().enqueueCap): Promise<EnqueueResult> {
  const rows = await db.userCompanyState.findMany({
    where: { followed: true, company: { officersCoverage: "none", source: { not: "seed" } } },
    select: { companyId: true },
    distinct: ["companyId"],
    take: cap + 1,
  });
  return enqueueOfficerJobs(rows.map((r) => r.companyId), { priority: OFFICER_PRIORITY.FOLLOWED, reason: "followed", cap });
}

// Companies with confirmed-dirty officer data, then confirmed data past the
// TTL, then unavailable data due a re-check. Bounded per call.
export async function enqueueFreshnessRefreshes(
  options: { cap?: number; config?: OfficerQueueConfig; now?: Date } = {}
): Promise<{ dirty: number; stale: number; unavailable: number }> {
  const config = options.config ?? loadOfficerConfig();
  const cap = options.cap ?? Math.min(config.enqueueCap, 500);
  const now = options.now ?? new Date();
  const day = 86_400_000;

  const pick = async (sql: string, ...params: unknown[]) => (await db.$queryRawUnsafe<{ id: string }[]>(sql, ...params)).map((r) => r.id);

  const dirtyIds = await pick(
    `SELECT c."id" FROM "Company" c
      WHERE c."officersDirtyAt" IS NOT NULL AND c."officersCoverage" = 'full'
        AND NOT EXISTS (SELECT 1 FROM "OfficerSyncJob" j WHERE j."companyId" = c."id")
      ORDER BY c."officersDirtyAt" LIMIT $1`,
    cap
  );
  const staleIds = await pick(
    `SELECT c."id" FROM "Company" c
      WHERE c."officersCoverage" = 'full' AND c."officersFetchedAt" < ${utc(1)}
        AND NOT EXISTS (SELECT 1 FROM "OfficerSyncJob" j WHERE j."companyId" = c."id")
      ORDER BY c."officersFetchedAt" LIMIT $2`,
    new Date(now.getTime() - config.staleAfterDays * day).toISOString(),
    cap
  );
  const unavailableIds = await pick(
    `SELECT c."id" FROM "Company" c
      WHERE c."officersCoverage" = 'unavailable' AND c."officersFetchedAt" < ${utc(1)}
        AND NOT EXISTS (SELECT 1 FROM "OfficerSyncJob" j WHERE j."companyId" = c."id")
      ORDER BY c."officersFetchedAt" LIMIT $2`,
    new Date(now.getTime() - config.unavailableRecheckDays * day).toISOString(),
    cap
  );

  const run = (ids: string[], reason: string, coverage: string[]) =>
    ids.length ? enqueueOfficerJobs(ids, { priority: OFFICER_PRIORITY.REFRESH, reason, coverage, cap }) : Promise.resolve({ inserted: 0 });
  const [d, s, u] = await Promise.all([run(dirtyIds, "dirty", ["full"]), run(staleIds, "ttl", ["full"]), run(unavailableIds, "unavailable_recheck", ["unavailable"])]);
  return { dirty: d.inserted, stale: s.inserted, unavailable: u.inserted };
}
