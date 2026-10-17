// Thin, honest wrapper around the real Companies House REST + streaming
// APIs.
//
// No `import "server-only"` guard: this module (and the rest of
// src/lib/companies-house + src/lib/calendar) also runs as standalone CLI
// scripts via tsx (npm run ch:*), outside Next's webpack build where that
// guard would unconditionally throw.
//
// REST auth: HTTP Basic, API key as username, empty password.
// Rate limit: 600 requests / 5 minutes per key, reported via
// X-Ratelimit-* response headers. Every REST call goes through
// chRestGetWithRateInfo, which
//  (a) reserves a request from the SHARED, database-backed quota gate
//      (quota.ts) under a request class, so every process honours one budget,
//  (b) checks the persistent circuit breakers (breaker.ts),
//  (c) retries 429 after the advertised reset (a 429 also opens a global
//      cooldown every process sees), and
//  (d) retries transient 5xx/network failures with exponential backoff.

import {
  acquireQuota,
  INLINE_BACKGROUND_WAIT_MS,
  isBackgroundClass,
  recordQuotaEvent,
  recordQuotaResponse,
  recordRequestStat,
  outcomeFromStatus,
  snapshotFromState,
  type DenyReason,
  type QuotaClass,
  type QuotaSnapshot,
} from "./quota";
import { checkBreakers, recordBreakerOutcome } from "./breaker";

const REST_BASE_URL = process.env.COMPANIES_HOUSE_REST_BASE_URL ?? "https://api.company-information.service.gov.uk";
export const STREAM_URL = process.env.COMPANIES_HOUSE_STREAM_URL ?? "https://stream.companieshouse.gov.uk/filings";
export const PUBLIC_COMPANY_URL = "https://find-and-update.company-information.service.gov.uk/company";

export class CompaniesHouseConfigError extends Error {}
// Companies House itself answered HTTP 429 (or a stream connect did).
export class CompaniesHouseRateLimitError extends Error {
  readonly http429: boolean = true;
  constructor(public retryAfterMs: number, message?: string) {
    super(message ?? `Companies House returned HTTP 429; retry after ${retryAfterMs}ms`);
  }
}
// Our OWN shared quota gate declined to send a request (reserve / pacing /
// cooldown after a real 429). Nothing was sent and Companies House did not
// rate limit us. Subclasses the 429 error only so existing callers that back
// off on "rate limited" keep working; `http429` tells the two apart.
export class CompaniesHouseQuotaDeferredError extends CompaniesHouseRateLimitError {
  readonly http429 = false;
  constructor(retryAfterMs: number, public reason: DenyReason, public snapshot: QuotaSnapshot) {
    super(retryAfterMs, `Companies House request deferred by the internal quota gate (${reason}); next slot in ${retryAfterMs}ms. Not an HTTP 429`);
  }
}
export class CompaniesHouseNotFoundError extends Error {}
// A persistent circuit breaker is open: the request was NOT sent. Systemic,
// never the fault of the individual company being processed.
export class CompaniesHouseBreakerOpenError extends Error {
  constructor(public breaker: "auth" | "outage", public retryAt: Date | null, public reason: string) {
    super(`Companies House ${breaker} circuit breaker open: ${reason}`);
  }
}
export class CompaniesHouseApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
// The requested stream timepoint is older than Companies House still keeps.
export class StreamOutOfRangeError extends Error {}

function getRestKey(): string {
  const key = process.env.COMPANIES_HOUSE_API_KEY;
  if (!key) throw new CompaniesHouseConfigError("COMPANIES_HOUSE_API_KEY is not configured");
  return key;
}

export function getStreamKey(): string {
  const key = process.env.COMPANIES_HOUSE_STREAM_KEY;
  if (!key) throw new CompaniesHouseConfigError("COMPANIES_HOUSE_STREAM_KEY is not configured");
  return key;
}

export function isRestConfigured(): boolean {
  return !!process.env.COMPANIES_HOUSE_API_KEY;
}

export function isStreamConfigured(): boolean {
  return !!process.env.COMPANIES_HOUSE_STREAM_KEY;
}

function basicAuthHeader(key: string): string {
  return "Basic " + Buffer.from(`${key}:`).toString("base64");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RestRequestOptions {
  params?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  maxAttempts?: number;
  // Which share of the shared quota this request is charged to (default
  // "user": the safe, highest-priority class for interactive callers).
  quotaClass?: QuotaClass;
  // How long this request may wait for quota before giving up with a
  // CompaniesHouseRateLimitError. Background classes default to 0 (never
  // block: the caller backs off and tries again later).
  maxQuotaWaitMs?: number;
}

const DEFAULT_QUOTA_WAIT_MS: Record<QuotaClass, number> = { user: 30_000, filing: 60_000, stream: 60_000, refresh: 0, backfill: 0 };

// Last X-Ratelimit-Remain seen by THIS process (diagnostics only; the shared
// gate in quota.ts is what enforces the budget).
let lastRemaining: number | null = null;
export function getLastKnownRateRemaining(): number | null {
  return lastRemaining;
}
// Exposed for tests that need a clean slate.
export function resetRateState() {
  lastRemaining = null;
}

// Waits for a breaker-clear, quota-granted slot. Throws
// CompaniesHouseBreakerOpenError / CompaniesHouseQuotaDeferredError when the
// request must not be sent (nothing has been sent in either case). A granted
// background slot may carry a short pacing delay, which is served here.
async function reserveRequest(cls: QuotaClass, maxWaitMs: number) {
  const breaker = await checkBreakers(isBackgroundClass(cls));
  if (!breaker.allow) throw new CompaniesHouseBreakerOpenError(breaker.breaker, breaker.retryAt, breaker.reason);

  const deadline = Date.now() + maxWaitMs;
  let reported = false;
  for (;;) {
    const decision = await acquireQuota(cls);
    if (decision.granted) {
      if (decision.delayMs > 0) await sleep(decision.delayMs);
      return;
    }
    if (!reported) {
      reported = true;
      void recordQuotaEvent({ kind: "quota_denied", quotaClass: cls, reason: decision.reason, httpStatus: null, waitMs: decision.waitMs, snapshot: decision.snapshot });
    }
    // The tail of a window is waited out in place by background work (a few
    // seconds), so a window boundary never turns into a hand-back; a cooldown
    // or a long wait is still handed back to the caller.
    const inline = isBackgroundClass(cls) && (decision.reason === "quota" || decision.reason === "paced") && decision.waitMs <= INLINE_BACKGROUND_WAIT_MS;
    if (!inline && Date.now() + decision.waitMs > deadline) throw new CompaniesHouseQuotaDeferredError(decision.waitMs, decision.reason, decision.snapshot);
    await sleep(decision.waitMs + 50);
  }
}

async function afterResponse(cls: QuotaClass, status: number, res?: Response) {
  const remainHeader = res?.headers.get("X-Ratelimit-Remain") ?? null;
  const resetHeader = res?.headers.get("X-Ratelimit-Reset") ?? null;
  const remaining = remainHeader !== null && Number.isFinite(Number(remainHeader)) ? Number(remainHeader) : null;
  const reset = resetHeader !== null && Number.isFinite(Number(resetHeader)) ? Number(resetHeader) : null;
  if (remaining !== null) lastRemaining = remaining;
  const [state] = await Promise.all([
    recordQuotaResponse({ status, remaining, resetEpochSeconds: reset }).catch(() => null),
    recordBreakerOutcome(status),
    recordRequestStat(cls, outcomeFromStatus(status)),
  ]);
  if (status === 429) {
    const until = state?.cooldownUntil ? state.cooldownUntil.getTime() - Date.now() : null;
    await recordQuotaEvent({ kind: "http_429", quotaClass: cls, reason: "http_429", httpStatus: 429, waitMs: until, snapshot: state ? snapshotFromState(state, cls) : null });
  }
}

export async function chRestGetWithRateInfo<T>(path: string, options: RestRequestOptions = {}): Promise<T> {
  const key = getRestKey();
  const url = new URL(REST_BASE_URL + path);
  for (const [k, v] of Object.entries(options.params ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const cls = options.quotaClass ?? "user";
  const maxWait = options.maxQuotaWaitMs ?? DEFAULT_QUOTA_WAIT_MS[cls];
  const maxAttempts = options.maxAttempts ?? 4;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await reserveRequest(cls, maxWait);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    try {
      const res = await fetch(url, { headers: { Authorization: basicAuthHeader(key) }, signal: controller.signal });
      await afterResponse(cls, res.status, res);

      if (res.status === 404) throw new CompaniesHouseNotFoundError(path);
      if (res.status === 401 || res.status === 403) {
        throw new CompaniesHouseApiError(`Companies House ${path} -> HTTP ${res.status} (check the API key)`, res.status);
      }

      if (res.status === 429) {
        // The shared gate now holds a global cooldown until the advertised
        // reset. Waiting out a whole window inside a request would hang the
        // caller; only retry in place when the wait is short.
        const resetHeader = Number(res.headers.get("X-Ratelimit-Reset"));
        const waitMs = Number.isFinite(resetHeader) && resetHeader > 0 ? resetHeader * 1000 - Date.now() : 30_000;
        const err = new CompaniesHouseRateLimitError(Math.max(1000, waitMs));
        if (attempt < maxAttempts && err.retryAfterMs <= 60_000 && maxWait > 0) {
          lastError = err;
          continue; // reserveRequest waits for the cooldown
        }
        throw err;
      }

      if (res.status >= 500) {
        lastError = new CompaniesHouseApiError(`Companies House ${path} -> HTTP ${res.status}`, res.status);
        if (attempt < maxAttempts) {
          await sleep(Math.min(30_000, 1000 * 2 ** attempt));
          continue;
        }
        throw lastError;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new CompaniesHouseApiError(`Companies House ${path} -> HTTP ${res.status}: ${body.slice(0, 300)}`, res.status);
      }

      return (await res.json()) as T;
    } catch (err) {
      if (
        err instanceof CompaniesHouseNotFoundError ||
        err instanceof CompaniesHouseApiError ||
        err instanceof CompaniesHouseRateLimitError ||
        err instanceof CompaniesHouseBreakerOpenError ||
        err instanceof CompaniesHouseConfigError
      ) {
        throw err;
      }
      // Network failure / timeout: retry with backoff.
      await afterResponse(cls, 0);
      lastError = err;
      if (attempt < maxAttempts) {
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Companies House request failed");
}

// Kept for callers that used the original name.
export const chRestGet = chRestGetWithRateInfo;

export interface StreamEnvelope {
  event: unknown; // the parsed JSON line, untouched
  timepoint: number | null; // event.timepoint from the stream envelope
}

// Opens a persistent connection to the filing stream and yields parsed JSON
// lines. If `timepoint` is given the stream replays from that position
// (Companies House keeps a limited backlog), which is how a restarted worker
// resumes without losing events. The connection is aborted and an error
// thrown if nothing (not even the heartbeat newline) arrives for
// `idleTimeoutMs`, so a silently dead connection cannot stall forever.
export async function* streamFilings(
  options: { signal?: AbortSignal; timepoint?: number | null; idleTimeoutMs?: number } = {}
): AsyncGenerator<StreamEnvelope> {
  const key = getStreamKey();
  const url = new URL(STREAM_URL);
  if (options.timepoint != null) url.searchParams.set("timepoint", String(options.timepoint));

  const connection = new AbortController();
  const onAbort = () => connection.abort();
  options.signal?.addEventListener("abort", onAbort);
  const idleMs = options.idleTimeoutMs ?? 90_000;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idled = false;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idled = true;
      connection.abort();
    }, idleMs);
  };

  try {
    armIdle();
    const res = await fetch(url, { headers: { Authorization: basicAuthHeader(key) }, signal: connection.signal });

    if (res.status === 416) throw new StreamOutOfRangeError(`Stream timepoint ${options.timepoint} is no longer available`);
    if (res.status === 429) throw new CompaniesHouseRateLimitError(60_000);
    if (!res.ok || !res.body) {
      throw new CompaniesHouseApiError(`Streaming connection failed: HTTP ${res.status}`, res.status);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        armIdle();
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) continue; // heartbeat
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            // Malformed line: skip it (logged by the caller via the count of
            // unparseable lines is not needed - it carries no usable data).
            continue;
          }
          const tp = (parsed as { event?: { timepoint?: unknown } })?.event?.timepoint;
          yield { event: parsed, timepoint: typeof tp === "number" ? tp : null };
        }
      }
    } finally {
      reader.releaseLock();
    }
  } catch (err) {
    if (idled) throw new Error(`Stream idle for more than ${Math.round(idleMs / 1000)}s - connection presumed dead`);
    throw err;
  } finally {
    clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onAbort);
    connection.abort();
  }
}
