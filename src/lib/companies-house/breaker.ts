import { db } from "@/lib/db";

// Persistent circuit breakers for the Companies House REST API. State lives
// in the database so every process (web app, stream worker, officer worker)
// sees the same breaker and a restart never forgets it.
//
//   auth   - repeated 401/403 means the API key (or its IP allow-list) is
//            wrong. ALL REST traffic stops: hammering Companies House with a
//            broken key helps nobody. Recovery: manual reset, or ONE
//            half-open probe request after a cool-off; a successful probe
//            closes the breaker, a failed one re-opens it.
//   outage - a run of 5xx / network failures. Pauses BACKGROUND work
//            (refresh / backfill) only, so the queue is preserved while
//            interactive pages keep trying. Backoff grows with each trip.

export type BreakerName = "auth" | "outage";
export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerData {
  state: BreakerState;
  consecutiveFailures: number;
  trips: number;
  openedAt: Date | null;
  openUntil: Date | null;
  reason: string | null;
  lastStatus: number | null;
  windowTotal: number;
  windowFailures: number;
  probeStartedAt: Date | null;
}

export interface BreakerPolicy {
  authThreshold: number; // consecutive 401/403 that open the auth breaker
  authProbeAfterMs: number; // cool-off before one half-open probe
  probeStaleMs: number; // a half-open probe that never reported back is retried after this
  outageWindow: number; // calls evaluated per tumbling window
  outageFailureRatio: number; // opens when failures / window exceeds this
  outageBaseBackoffMs: number;
  outageMaxBackoffMs: number;
}

export function loadBreakerPolicy(env: NodeJS.ProcessEnv = process.env): BreakerPolicy {
  const n = (name: string, d: number) => (Number.isFinite(Number(env[name])) && Number(env[name]) > 0 ? Number(env[name]) : d);
  return {
    authThreshold: n("CH_AUTH_BREAKER_THRESHOLD", 2),
    authProbeAfterMs: n("CH_AUTH_PROBE_MINUTES", 60) * 60_000,
    probeStaleMs: 2 * 60_000,
    outageWindow: n("CH_OUTAGE_WINDOW", 20),
    outageFailureRatio: 0.5,
    outageBaseBackoffMs: n("CH_OUTAGE_BACKOFF_MINUTES", 5) * 60_000,
    outageMaxBackoffMs: 60 * 60_000,
  };
}

export const closedBreaker = (): BreakerData => ({
  state: "closed",
  consecutiveFailures: 0,
  trips: 0,
  openedAt: null,
  openUntil: null,
  reason: null,
  lastStatus: null,
  windowTotal: 0,
  windowFailures: 0,
  probeStartedAt: null,
});

export type BreakerCheck = { allow: true; probe: boolean } | { allow: false; retryAt: Date | null; reason: string };

// ---- auth ------------------------------------------------------------------
export function checkAuth(b: BreakerData, now: Date, p: BreakerPolicy): { check: BreakerCheck; data: BreakerData } {
  if (b.state === "closed") return { check: { allow: true, probe: false }, data: b };
  const probeFresh = b.probeStartedAt !== null && now.getTime() - b.probeStartedAt.getTime() < p.probeStaleMs;
  const probeDue = b.state === "half_open" || (b.openUntil !== null && now >= b.openUntil);
  if (probeDue && !probeFresh) {
    return { check: { allow: true, probe: true }, data: { ...b, state: "half_open", probeStartedAt: now } };
  }
  return {
    check: { allow: false, retryAt: b.openUntil, reason: b.reason ?? "Companies House rejected the API key (HTTP 401/403)" },
    data: b,
  };
}

// status: HTTP status of a response that actually came back from Companies House.
export function recordAuth(b: BreakerData, status: number, now: Date, p: BreakerPolicy): BreakerData {
  const auth = status === 401 || status === 403;
  if (auth) {
    const consecutiveFailures = b.consecutiveFailures + 1;
    if (b.state === "half_open" || consecutiveFailures >= p.authThreshold) {
      return {
        ...b,
        state: "open",
        consecutiveFailures,
        trips: b.trips + 1,
        openedAt: now,
        openUntil: new Date(now.getTime() + p.authProbeAfterMs),
        reason: `Companies House returned HTTP ${status}: check COMPANIES_HOUSE_API_KEY and its IP allow-list`,
        lastStatus: status,
        probeStartedAt: null,
      };
    }
    return { ...b, consecutiveFailures, lastStatus: status };
  }
  // A real 2xx/404 proves the key works; 429/5xx/other say nothing about it.
  if ((status >= 200 && status < 300) || status === 404) {
    return b.state === "closed" && b.consecutiveFailures === 0
      ? b
      : { ...closedBreaker(), trips: 0 };
  }
  return b;
}

// ---- outage ----------------------------------------------------------------
export function checkOutage(b: BreakerData, now: Date): BreakerCheck {
  if (b.state === "open" && b.openUntil && now < b.openUntil) {
    return { allow: false, retryAt: b.openUntil, reason: b.reason ?? "Companies House outage breaker is open" };
  }
  return { allow: true, probe: false };
}

// failed = 5xx or network failure. Everything else counts as a healthy call.
export function recordOutage(b: BreakerData, failed: boolean, now: Date, p: BreakerPolicy): BreakerData {
  let next: BreakerData = { ...b, windowTotal: b.windowTotal + 1, windowFailures: b.windowFailures + (failed ? 1 : 0) };

  // A healthy call after the back-off elapsed closes the breaker.
  if (!failed && next.state === "open" && next.openUntil && now >= next.openUntil) {
    next = { ...next, state: "closed", openUntil: null, reason: null, windowTotal: 1, windowFailures: 0 };
  }

  const tooManyFailures = next.windowFailures > p.outageWindow * p.outageFailureRatio;
  if (tooManyFailures) {
    const trips = b.trips + 1;
    const backoff = Math.min(p.outageMaxBackoffMs, p.outageBaseBackoffMs * 2 ** (trips - 1));
    return {
      ...next,
      state: "open",
      trips,
      openedAt: now,
      openUntil: new Date(now.getTime() + backoff),
      reason: `Companies House outage: ${next.windowFailures} of the last ${next.windowTotal} requests failed (5xx/network)`,
      lastStatus: failed ? 5 : next.lastStatus,
      windowTotal: 0,
      windowFailures: 0,
    };
  }
  if (next.windowTotal >= p.outageWindow) {
    // A full healthy window: forget the history.
    return { ...next, trips: 0, windowTotal: 0, windowFailures: 0 };
  }
  return next;
}

// ---- persistence -----------------------------------------------------------
interface BreakerRow {
  state: string;
  consecutiveFailures: number;
  trips: number;
  openedAt: Date | null;
  openUntil: Date | null;
  reason: string | null;
  lastStatus: number | null;
  windowTotal: number;
  windowFailures: number;
  probeStartedAt: Date | null;
}

const toData = (r: BreakerRow): BreakerData => ({ ...r, state: r.state as BreakerState });

export interface BreakerStore {
  update<T>(name: BreakerName, fn: (b: BreakerData) => { data: BreakerData; result: T }): Promise<T>;
  read(name: BreakerName): Promise<BreakerData>;
  reset(name: BreakerName): Promise<void>;
}

export class MemoryBreakerStore implements BreakerStore {
  private data = new Map<BreakerName, BreakerData>();
  async update<T>(name: BreakerName, fn: (b: BreakerData) => { data: BreakerData; result: T }): Promise<T> {
    const { data, result } = fn(this.data.get(name) ?? closedBreaker());
    this.data.set(name, data);
    return result;
  }
  async read(name: BreakerName) {
    return this.data.get(name) ?? closedBreaker();
  }
  async reset(name: BreakerName) {
    this.data.set(name, closedBreaker());
  }
}

export class DbBreakerStore implements BreakerStore {
  // The row is created once per process; if it is later removed (manual reset,
  // tests) the transaction below recreates it, so no per-call "ensure" query.
  private ensured = new Set<BreakerName>();

  async update<T>(name: BreakerName, fn: (b: BreakerData) => { data: BreakerData; result: T }): Promise<T> {
    if (!this.ensured.has(name)) {
      await db.chBreaker.createMany({ data: [{ name }], skipDuplicates: true });
      this.ensured.add(name);
    }
    return db.$transaction(
      async (tx) => {
        let rows = await tx.$queryRaw<BreakerRow[]>`SELECT * FROM "ChBreaker" WHERE "name" = ${name} FOR UPDATE`;
        if (rows.length === 0) {
          await tx.chBreaker.createMany({ data: [{ name }], skipDuplicates: true });
          rows = await tx.$queryRaw<BreakerRow[]>`SELECT * FROM "ChBreaker" WHERE "name" = ${name} FOR UPDATE`;
        }
        const { data, result } = fn(toData(rows[0]));
        await tx.chBreaker.update({ where: { name }, data });
        return result;
      },
      { timeout: 5000 }
    );
  }
  async read(name: BreakerName) {
    const row = await db.chBreaker.findUnique({ where: { name } });
    return row ? toData(row) : closedBreaker();
  }
  async reset(name: BreakerName) {
    await db.chBreaker.upsert({ where: { name }, create: { name }, update: closedBreaker() });
  }
}

let store: BreakerStore | null = null;
let policyOverride: BreakerPolicy | null = null;
export function configureBreakers(opts: { store?: BreakerStore | null; policy?: BreakerPolicy | null } = {}) {
  store = opts.store ?? null;
  policyOverride = opts.policy ?? null;
}
const getStore = () => (store ??= new DbBreakerStore());
const policy = () => policyOverride ?? loadBreakerPolicy();

// Called before every REST request. Returns the reason when the request must
// not be sent. A database failure fails OPEN (the request is allowed): the
// breaker is protection, not a dependency that may take the API down.
export async function checkBreakers(background: boolean, now: Date = new Date()): Promise<{ allow: true } | { allow: false; breaker: BreakerName; retryAt: Date | null; reason: string }> {
  try {
    // The common case (breaker closed) is a plain read: checkAuth changes
    // nothing for a closed breaker, so no lock and no write are needed. Only
    // an open / half-open breaker takes the locking path, where exactly one
    // caller wins the half-open probe.
    const current = await getStore().read("auth");
    const authResult =
      current.state === "closed"
        ? ({ allow: true, probe: false } as BreakerCheck)
        : await getStore().update("auth", (b) => {
            const { check, data } = checkAuth(b, now, policy());
            return { data, result: check };
          });
    if (!authResult.allow) return { allow: false, breaker: "auth", retryAt: authResult.retryAt, reason: authResult.reason };
    if (background) {
      const out = checkOutage(await getStore().read("outage"), now);
      if (!out.allow) return { allow: false, breaker: "outage", retryAt: out.retryAt, reason: out.reason };
    }
  } catch {
    /* fail open */
  }
  return { allow: true };
}

// Called after every REST attempt. status 0 = network failure/timeout.
export async function recordBreakerOutcome(status: number, now: Date = new Date()): Promise<void> {
  try {
    const p = policy();
    if (status !== 0) {
      // A healthy answer from a closed breaker with no failure streak changes
      // nothing (recordAuth returns the same object): skip the locking write.
      const current = await getStore().read("auth");
      if (recordAuth(current, status, now, p) !== current) {
        await getStore().update("auth", (b) => ({ data: recordAuth(b, status, now, p), result: undefined }));
      }
    }
    const failed = status === 0 || status >= 500;
    const healthy = status !== 429 && status !== 401 && status !== 403; // throttling/auth errors say nothing about availability
    if (failed || healthy) await getStore().update("outage", (b) => ({ data: recordOutage(b, failed, now, p), result: undefined }));
  } catch {
    /* observability/protection only */
  }
}

export async function readBreaker(name: BreakerName): Promise<BreakerData> {
  return getStore().read(name);
}

export async function resetBreaker(name: BreakerName): Promise<void> {
  await getStore().reset(name);
}
