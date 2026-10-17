import { randomUUID } from "node:crypto";
import { classifyRun, finishRun, startRun, touchRun } from "@/lib/jobs/runs";
import { CompaniesHouseApiError, CompaniesHouseBreakerOpenError, CompaniesHouseQuotaDeferredError, CompaniesHouseRateLimitError, isRestConfigured } from "./client";
import { readBreaker } from "./breaker";
import { syncCompanyOfficers } from "./sync";
import {
  claimOfficerJobs,
  enqueueFreshnessRefreshes,
  extendLeases,
  failOfficerJob,
  loadOfficerConfig,
  OFFICER_PRIORITY,
  quotaClassForPriority,
  releaseExpiredLeases,
  releaseWorkerLeases,
  saveCrawlCursor,
  selectCrawlBatch,
  type OfficerQueueConfig,
} from "./officerQueue";

// The dedicated officer synchronisation worker. It owns ALL large-scale
// officer fetching (the daily update only enqueues). One instance runs at a
// time (advisory-lock single-flight in startRun); jobs are claimed with
// FOR UPDATE SKIP LOCKED + a lease, so a crash returns in-flight work to the
// queue. Per loop:
//   1. stop if the auth circuit breaker is open (bad API key), pause while
//      the outage breaker is open
//   2. claim a batch of queued/retry jobs by priority (P1..P4)
//   3. if the queue is empty and the crawl is enabled, take the next batch
//      from the keyset crawl (P5)
//   4. fetch officers company by company; the shared quota gate decides when
//      a request may actually be sent
// Systemic problems hand the work back WITHOUT charging the company an
// attempt; company-specific failures back off and eventually park the company.
// Two very different "slow down" signals are kept apart:
//   - the shared quota gate DEFERRED the request (internal; nothing was sent,
//     Companies House did not rate limit us). Normally the gate paces the
//     background classes inside the request, so a deferral only happens when
//     the budget is genuinely spoken for (higher-class demand, cooldown);
//   - Companies House answered HTTP 429 (real; the gate opens a global
//     cooldown that every process respects).
// One request is in flight at a time: the quota, not concurrency, is the limit.

// Longest single wait after an internal quota deferral (one accounting window).
const MAX_DEFERRAL_SLEEP_MS = 5 * 60_000;

// How long a supervising process (the scheduler) should wait before starting the worker again, by why the last run stopped.
// Without this the scheduler would start a new run every minute while idle: a run row per minute, and a freshness sweep
// per start. A run that hit its time limit while there was still work restarts at once; one that found nothing to do waits
// out the freshness-sweep interval; a rejected key waits for a human rather than hammering Companies House.
export function restartDelayMs(stopReason: OfficerWorkerStats["stopReason"] | "error" | "already_running"): number {
  switch (stopReason) {
    case "runtime":
    case "limit":
      return 0;
    case "idle":
      return 10 * 60_000;
    case "auth_breaker":
    case "no_credentials":
      return 15 * 60_000;
    case "already_running":
      return 60_000;
    default:
      return 5 * 60_000; // aborted (shutting down) / unexpected error
  }
}

export interface OfficerWorkerOptions {
  workerId?: string;
  maxCompanies?: number; // stop after this many companies were processed (pilots)
  maxRuntimeMs?: number;
  signal?: AbortSignal;
  queue?: boolean; // process queued jobs (default true)
  crawl?: boolean; // process the P5 background crawl (default FALSE: opt-in)
  priorityMax?: number; // only claim queued jobs with priority <= this
  freshness?: boolean; // enqueue dirty / TTL refreshes when idle (default true)
  exitWhenIdle?: boolean; // return instead of waiting when there is nothing to do
  idleSleepMs?: number;
  heartbeatMs?: number;
  batchSize?: number;
  config?: OfficerQueueConfig;
  log?: (message: string) => void;
}

export interface OfficerWorkerStats {
  workerId: string;
  claimed: number;
  processed: number; // companies actually attempted (excludes systemic hand-backs)
  full: number;
  unavailable: number;
  failures: number; // charged retryable failures
  parked: number;
  systemicHandBacks: number; // every hand-back: quota deferrals + real 429s + breaker / outage
  quotaDeferrals: number; // internal quota gate said wait (NOT an HTTP 429)
  http429s: number; // Companies House actually answered HTTP 429
  expiredLeasesReleased: number;
  freshnessEnqueued: number;
  crawled: number;
  stopReason: "limit" | "runtime" | "aborted" | "idle" | "auth_breaker" | "no_credentials";
  companiesPerMinute: number;
}

type Classified =
  | { kind: "deferred"; retryAfterMs: number; reason: string }
  | { kind: "systemic"; retryAfterMs: number; authStop: boolean; reason: string; http429?: boolean }
  | { kind: "maybe_outage"; httpStatus: number | null; message: string }
  | { kind: "failure"; httpStatus: number | null; message: string };

function classify(err: unknown): Classified {
  if (err instanceof CompaniesHouseBreakerOpenError) {
    const wait = err.retryAt ? Math.max(1000, err.retryAt.getTime() - Date.now()) : 30_000;
    return { kind: "systemic", retryAfterMs: Math.min(wait, 60_000), authStop: err.breaker === "auth", reason: err.message };
  }
  if (err instanceof CompaniesHouseQuotaDeferredError) return { kind: "deferred", retryAfterMs: err.retryAfterMs, reason: err.message };
  if (err instanceof CompaniesHouseRateLimitError) return { kind: "systemic", retryAfterMs: err.retryAfterMs, authStop: false, reason: err.message, http429: true };
  if (err instanceof CompaniesHouseApiError) {
    // Bad key: the breaker decides; the company is blameless.
    if (err.status === 401 || err.status === 403) return { kind: "systemic", retryAfterMs: 1000, authStop: false, reason: err.message };
    if (err.status >= 500) return { kind: "maybe_outage", httpStatus: err.status, message: err.message };
    return { kind: "failure", httpStatus: err.status, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  // fetch() network failures / timeouts surface as TypeError / AbortError.
  if (err instanceof TypeError || (err instanceof Error && err.name === "AbortError")) return { kind: "maybe_outage", httpStatus: null, message };
  return { kind: "failure", httpStatus: null, message };
}

export async function runOfficerWorker(options: OfficerWorkerOptions = {}): Promise<OfficerWorkerStats> {
  const log = options.log ?? (() => {});
  const config = options.config ?? loadOfficerConfig();
  const workerId = options.workerId ?? `officer-worker-${randomUUID().slice(0, 8)}`;
  const useQueue = options.queue ?? true;
  const useCrawl = options.crawl ?? false;
  const useFreshness = options.freshness ?? true;
  const batchSize = options.batchSize ?? config.batchSize;
  const idleSleepMs = options.idleSleepMs ?? 30_000;

  const stats: OfficerWorkerStats = {
    workerId, claimed: 0, processed: 0, full: 0, unavailable: 0, failures: 0, parked: 0, systemicHandBacks: 0, quotaDeferrals: 0, http429s: 0,
    expiredLeasesReleased: 0, freshnessEnqueued: 0, crawled: 0, stopReason: "idle", companiesPerMinute: 0,
  };

  if (!isRestConfigured()) {
    stats.stopReason = "no_credentials";
    log("COMPANIES_HOUSE_API_KEY is not configured; nothing to do");
    return stats;
  }

  const run = await startRun("officer_backfill", { inputName: workerId });
  const started = Date.now();
  const expired = () => options.maxRuntimeMs !== undefined && Date.now() - started >= options.maxRuntimeMs;
  const limitReached = () => options.maxCompanies !== undefined && stats.processed >= options.maxCompanies;
  const stopped = () => options.signal?.aborted === true;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      options.signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });

  const snapshot = () => {
    const minutes = Math.max((Date.now() - started) / 60_000, 1 / 60);
    stats.companiesPerMinute = Math.round((stats.processed / minutes) * 10) / 10;
    return stats;
  };
  const beat = async () => {
    await touchRun(run.id, { rowsRead: stats.processed, rowsProcessed: stats.full + stats.unavailable, rowsFailed: stats.failures + stats.parked, statsJson: JSON.stringify(snapshot()) }).catch(() => {});
    await extendLeases(workerId, config).catch(() => {});
  };
  // Timer heartbeat (independent of how long one company takes).
  const heartbeat = setInterval(beat, options.heartbeatMs ?? 30_000);
  heartbeat.unref?.();

  let lastFreshnessAt = 0;
  let fatal: unknown = null;
  let breakerMessage: string | null = null;

  async function chargeFailure(item: { companyId: string; companyNumber: string }, httpStatus: number | null, message: string, fromCrawl: boolean) {
    const plan = await failOfficerJob(item.companyId, { httpStatus, error: message }, { config, crawl: fromCrawl ? { workerId } : undefined });
    stats.processed++;
    if (plan.status === "parked") stats.parked++;
    else stats.failures++;
    log(`failed ${item.companyNumber}: ${message} -> ${plan.status}`);
  }

  async function handleItem(item: { companyId: string; companyNumber: string; priority: number }, fromCrawl: boolean): Promise<"ok" | "systemic" | "stop"> {
    try {
      const outcome = await syncCompanyOfficers(item.companyId, item.companyNumber, { quotaClass: quotaClassForPriority(item.priority) });
      if (outcome.kind === "kept_confirmed") {
        // 404 for a company whose confirmed data we keep: a retryable failure, state untouched.
        await chargeFailure(item, 404, "officers 404 for an already-confirmed company; confirmed data kept", fromCrawl);
        return "ok";
      }
      stats.processed++;
      if (outcome.kind === "full") stats.full++;
      else stats.unavailable++;
      return "ok";
    } catch (err) {
      const c = classify(err);
      if (c.kind === "deferred") {
        // Our own gate: wait out the advertised slot, then carry on. No attempt is charged.
        stats.quotaDeferrals++;
        stats.systemicHandBacks++;
        await releaseWorkerLeases(workerId);
        log(`quota gate deferred (internal, not an HTTP 429): ${c.reason}; handing work back, waiting ${Math.round(c.retryAfterMs / 1000)}s`);
        await sleep(Math.min(Math.max(c.retryAfterMs, 1000), MAX_DEFERRAL_SLEEP_MS));
        return "systemic";
      }
      let systemic = c.kind === "systemic";
      if (c.kind === "maybe_outage") {
        const outage = await readBreaker("outage").catch(() => null);
        systemic = !!outage && outage.state === "open" && !!outage.openUntil && outage.openUntil > new Date();
      }
      if (systemic) {
        const wait = c.kind === "systemic" ? c.retryAfterMs : 30_000;
        stats.systemicHandBacks++;
        if (c.kind === "systemic" && c.http429) stats.http429s++;
        await releaseWorkerLeases(workerId);
        log(`systemic: ${c.kind === "systemic" ? c.reason : "outage breaker open"}; handing work back, pausing ${Math.round(wait / 1000)}s`);
        if (c.kind === "systemic" && c.authStop) {
          breakerMessage = c.reason;
          return "stop";
        }
        await sleep(Math.min(Math.max(wait, 1000), 60_000));
        return "systemic";
      }
      const message = c.kind === "systemic" ? c.reason : c.message;
      const httpStatus = c.kind === "systemic" ? null : c.httpStatus;
      await chargeFailure(item, httpStatus, message, fromCrawl);
      return "ok";
    }
  }

  async function authGate(): Promise<"ok" | "stop" | "wait"> {
    const b = await readBreaker("auth").catch(() => null);
    if (!b || b.state === "closed") return "ok";
    const now = new Date();
    if (b.state === "open") {
      if (b.openUntil && now < b.openUntil) {
        breakerMessage = b.reason ?? "auth circuit breaker open";
        return "stop";
      }
      return "ok"; // probe is due: the client lets exactly one request through
    }
    const probeFresh = b.probeStartedAt !== null && now.getTime() - b.probeStartedAt.getTime() < 2 * 60_000;
    return probeFresh ? "wait" : "ok";
  }

  try {
    stats.expiredLeasesReleased = await releaseExpiredLeases();
    if (stats.expiredLeasesReleased) log(`released ${stats.expiredLeasesReleased} expired leases from a previous worker`);

    loop: while (true) {
      if (stopped()) { stats.stopReason = "aborted"; break; }
      if (expired()) { stats.stopReason = "runtime"; break; }
      if (limitReached()) { stats.stopReason = "limit"; break; }

      const gate = await authGate();
      if (gate === "stop") { stats.stopReason = "auth_breaker"; break; }
      if (gate === "wait") { await sleep(5000); continue; }
      const outage = await readBreaker("outage").catch(() => null);
      if (outage && outage.state === "open" && outage.openUntil && outage.openUntil > new Date()) {
        const wait = Math.min(outage.openUntil.getTime() - Date.now(), 60_000);
        log(`outage breaker open (${outage.reason}); background work paused ${Math.round(wait / 1000)}s`);
        await sleep(Math.max(wait, 1000));
        continue;
      }

      const remaining = options.maxCompanies !== undefined ? options.maxCompanies - stats.processed : batchSize;
      const take = Math.max(1, Math.min(batchSize, remaining));

      // ---- queue (P1..P4) ----
      if (useQueue) {
        const jobs = await claimOfficerJobs(workerId, { limit: take, priorityMax: options.priorityMax, config });
        if (jobs.length > 0) {
          stats.claimed += jobs.length;
          for (const job of jobs) {
            if (stopped() || expired() || limitReached()) break;
            const r = await handleItem(job, false);
            if (r === "stop") { stats.stopReason = "auth_breaker"; break loop; }
            if (r === "systemic") continue loop;
          }
          await releaseWorkerLeases(workerId); // anything not reached goes back, uncharged
          continue;
        }
      }

      // ---- crawl (P5) ----
      if (useCrawl) {
        const sel = await selectCrawlBatch(take);
        if (sel.items.length > 0) {
          let lastDone: string | null = null;
          for (const item of sel.items) {
            if (stopped() || expired() || limitReached()) break;
            const r = await handleItem({ companyId: item.id, companyNumber: item.companyNumber, priority: OFFICER_PRIORITY.CRAWL }, true);
            if (r === "stop") { stats.stopReason = "auth_breaker"; break; }
            if (r === "systemic") break;
            lastDone = item.id;
            stats.crawled++;
          }
          if (lastDone) await saveCrawlCursor(sel.phase, lastDone);
          if (stats.stopReason === "auth_breaker") break;
          continue;
        }
      }

      // ---- idle: look for refresh work, then wait or exit ----
      if (useFreshness && Date.now() - lastFreshnessAt > 10 * 60_000) {
        lastFreshnessAt = Date.now();
        const r = await enqueueFreshnessRefreshes({ config });
        const n = r.dirty + r.stale + r.unavailable;
        stats.freshnessEnqueued += n;
        if (n > 0) {
          log(`enqueued ${n} refreshes (dirty ${r.dirty}, stale ${r.stale}, unavailable re-check ${r.unavailable})`);
          continue;
        }
      }
      if (options.exitWhenIdle) { stats.stopReason = "idle"; break; }
      await sleep(idleSleepMs);
    }
  } catch (err) {
    fatal = err;
  } finally {
    clearInterval(heartbeat);
    await releaseWorkerLeases(workerId).catch(() => {});
  }

  snapshot();
  const patch = {
    rowsRead: stats.processed,
    rowsProcessed: stats.full + stats.unavailable,
    rowsFailed: stats.failures + stats.parked,
    statsJson: JSON.stringify(stats),
  };
  if (fatal) {
    await finishRun(run.id, "failed", { ...patch, errorMessage: fatal instanceof Error ? fatal.message : String(fatal) });
    throw fatal;
  }
  if (stats.stopReason === "auth_breaker") {
    await finishRun(run.id, "failed", { ...patch, errorMessage: `Circuit breaker open: ${breakerMessage ?? "Companies House rejected the API key"}. Fix the key, then reset the breaker (npm run ch:officer-worker -- --reset-breaker).` });
    return stats;
  }
  const verdict = stats.processed === 0 ? "success" : classifyRun({ rowsRead: stats.processed, rowsFailed: stats.failures + stats.parked, rowsSkipped: 0 }).status;
  await finishRun(run.id, verdict, patch);
  log(`officer worker stopped (${stats.stopReason}): ${JSON.stringify(stats)}`);
  return stats;
}
