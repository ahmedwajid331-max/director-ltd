// Thin, honest wrapper around the real Companies House REST + streaming
// APIs. Endpoints and auth pattern below are confirmed against a
// previously-working prototype (real captured DS01 filings) plus official
// documentation — nothing here is invented.
//
// No `import "server-only"` guard: this module (and the rest of
// src/lib/companies-house + src/lib/calendar) also runs as standalone CLI
// scripts via tsx (npm run ch:*), outside Next's webpack build where that
// guard would unconditionally throw. It's never imported by a "use client"
// component — Node-only APIs used elsewhere in this module tree (crypto,
// streams) would fail a client bundle anyway if that ever changed.
//
// REST auth: HTTP Basic, API key as username, empty password.
// Rate limit: 600 requests / 5 minutes per key, reported via
// X-Ratelimit-* response headers.

const REST_BASE_URL = "https://api.company-information.service.gov.uk";
export const STREAM_URL = "https://stream.companieshouse.gov.uk/filings";
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

interface RestRequestOptions {
  params?: Record<string, string | number | undefined>;
  timeoutMs?: number;
}

// Single REST call with rate-limit awareness. Callers that make many calls
// (backfill, bulk enrichment) should catch CompaniesHouseRateLimitError and
// back off for retryAfterMs rather than hammering the API.
export async function chRestGet<T>(path: string, options: RestRequestOptions = {}): Promise<T> {
  const key = getRestKey();
  const url = new URL(REST_BASE_URL + path);
  for (const [k, v] of Object.entries(options.params ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);

  try {
    const res = await fetch(url, {
      headers: { Authorization: basicAuthHeader(key) },
      signal: controller.signal,
    });

    if (res.status === 404) throw new CompaniesHouseNotFoundError(path);

    if (res.status === 429) {
      const resetHeader = res.headers.get("X-Ratelimit-Reset");
      const resetAt = resetHeader ? Number(resetHeader) * 1000 : Date.now() + 30000;
      throw new CompaniesHouseRateLimitError(Math.max(1000, resetAt - Date.now()));
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new CompaniesHouseApiError(`Companies House ${path} -> HTTP ${res.status}: ${body.slice(0, 300)}`, res.status);
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

// Remaining requests in the current 5-minute window, if the last response
// told us (used by batch jobs to self-throttle instead of relying purely on
// reactive 429 handling).
let lastKnownRemaining: number | null = null;
export function getLastKnownRateRemaining(): number | null {
  return lastKnownRemaining;
}

export async function chRestGetWithRateInfo<T>(path: string, options: RestRequestOptions = {}): Promise<T> {
  const key = getRestKey();
  const url = new URL(REST_BASE_URL + path);
  for (const [k, v] of Object.entries(options.params ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, { headers: { Authorization: basicAuthHeader(key) } });
  const remain = res.headers.get("X-Ratelimit-Remain");
  if (remain !== null) lastKnownRemaining = Number(remain);

  if (res.status === 404) throw new CompaniesHouseNotFoundError(path);
  if (res.status === 429) {
    const resetHeader = res.headers.get("X-Ratelimit-Reset");
    const resetAt = resetHeader ? Number(resetHeader) * 1000 : Date.now() + 30000;
    throw new CompaniesHouseRateLimitError(Math.max(1000, resetAt - Date.now()));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CompaniesHouseApiError(`Companies House ${path} -> HTTP ${res.status}: ${body.slice(0, 300)}`, res.status);
  }
  return (await res.json()) as T;
}

// Opens a persistent connection to the filing stream. Caller iterates the
// returned async generator of parsed JSON lines; the underlying HTTP
// response stream stays open until the caller stops iterating or the
// connection drops (matches the proven prototype pattern).
export async function* streamFilings(signal?: AbortSignal): AsyncGenerator<unknown> {
  const key = getStreamKey();
  const res = await fetch(STREAM_URL, {
    headers: { Authorization: basicAuthHeader(key) },
    signal,
  });

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
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch {
          // Malformed line — skip, matches prototype behaviour.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
