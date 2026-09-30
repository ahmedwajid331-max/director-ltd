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
// chRestGetWithRateInfo, which (a) self-throttles when the remaining quota
// is nearly exhausted, (b) retries 429 after the advertised reset, and
// (c) retries transient 5xx/network failures with exponential backoff.

const REST_BASE_URL = process.env.COMPANIES_HOUSE_REST_BASE_URL ?? "https://api.company-information.service.gov.uk";
export const STREAM_URL = process.env.COMPANIES_HOUSE_STREAM_URL ?? "https://stream.companieshouse.gov.uk/filings";
export const PUBLIC_COMPANY_URL = "https://find-and-update.company-information.service.gov.uk/company";

export class CompaniesHouseConfigError extends Error {}
export class CompaniesHouseRateLimitError extends Error {
  constructor(public retryAfterMs: number) {
    super(`Companies House rate limit hit, retry after ${retryAfterMs}ms`);
  }
}
export class CompaniesHouseNotFoundError extends Error {}
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

interface RestRequestOptions {
  params?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  maxAttempts?: number;
}

// Rate state from the most recent response. Shared by all callers in this
// process so batch jobs throttle against the real remaining quota.
let rateRemaining: number | null = null;
let rateResetAtMs: number | null = null;
export function getLastKnownRateRemaining(): number | null {
  return rateRemaining;
}

const RATE_FLOOR = 15; // leave headroom for other callers sharing the key

async function waitForQuota() {
  if (rateRemaining !== null && rateRemaining <= RATE_FLOOR && rateResetAtMs !== null) {
    const wait = rateResetAtMs - Date.now();
    if (wait > 0 && wait < 6 * 60 * 1000) await sleep(wait + 500);
    rateRemaining = null;
  }
}

function recordRate(res: Response) {
  const remain = res.headers.get("X-Ratelimit-Remain");
  const reset = res.headers.get("X-Ratelimit-Reset");
  if (remain !== null && Number.isFinite(Number(remain))) rateRemaining = Number(remain);
  if (reset !== null && Number.isFinite(Number(reset))) rateResetAtMs = Number(reset) * 1000;
}

// Exposed for tests that need a clean slate.
export function resetRateState() {
  rateRemaining = null;
  rateResetAtMs = null;
}

export async function chRestGetWithRateInfo<T>(path: string, options: RestRequestOptions = {}): Promise<T> {
  const key = getRestKey();
  const url = new URL(REST_BASE_URL + path);
  for (const [k, v] of Object.entries(options.params ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const maxAttempts = options.maxAttempts ?? 4;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await waitForQuota();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    try {
      const res = await fetch(url, { headers: { Authorization: basicAuthHeader(key) }, signal: controller.signal });
      recordRate(res);

      if (res.status === 404) throw new CompaniesHouseNotFoundError(path);
      if (res.status === 401 || res.status === 403) {
        throw new CompaniesHouseApiError(`Companies House ${path} -> HTTP ${res.status} (check the API key)`, res.status);
      }

      if (res.status === 429) {
        const resetAt = rateResetAtMs ?? Date.now() + 30_000;
        const err = new CompaniesHouseRateLimitError(Math.max(1000, resetAt - Date.now()));
        // Waiting out a whole window inside a request would hang the caller;
        // only retry in place when the wait is short, otherwise surface it.
        if (attempt < maxAttempts && err.retryAfterMs <= 60_000) {
          lastError = err;
          await sleep(err.retryAfterMs + 500);
          continue;
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
        err instanceof CompaniesHouseConfigError
      ) {
        throw err;
      }
      // Network failure / timeout: retry with backoff.
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
