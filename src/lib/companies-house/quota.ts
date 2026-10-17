import { db } from "@/lib/db";

// Shared Companies House REST quota gate.
//
// Companies House allows 600 requests / 5 minutes per API key. The web app
// (detail pages), the stream worker, the daily job and the officer worker are
// separate processes, so a per-process counter cannot honour that budget.
// Every REST call reserves a request here first; the state lives in one
// PostgreSQL row (id "rest") that is read-modify-written under a row lock.
//
// Classes, highest priority first. A class may always spend as long as the
// requests still unspent by HIGHER-priority classes' reservations stay
// available - so the officer backfill is the first workload to yield, and an
// interactive user request is never starved by background work.
//   user      company detail pages (interactive)
//   filing    DS01 / filing enrichment, daily reconcile
//   stream    REST lookups triggered by stream events
//   refresh   officer refreshes of already-confirmed companies
//   backfill  officer backfill / background crawl / report-driven fetches
//
// The reservations are POLICY, not a promise: they are env-configurable and
// the X-Ratelimit-* response headers are authoritative whenever present.
//
// DEMAND-AWARE reservations. A higher class only holds its FULL per-window
// reservation back from lower classes while it is ACTIVE (it asked for quota
// within `demandHorizonMs`). An idle class holds just a small floor, so the
// background crawl can use otherwise idle capacity, and the moment a higher
// class shows demand its full reservation is protected again. The background
// classes are additionally PACED evenly across the window (see decideAcquire)
// instead of burning their share in a burst and then sitting idle.

export const QUOTA_CLASSES = ["user", "filing", "stream", "refresh", "backfill"] as const;
export type QuotaClass = (typeof QUOTA_CLASSES)[number];

export const BACKGROUND_CLASSES: readonly QuotaClass[] = ["refresh", "backfill"];
export const isBackgroundClass = (c: QuotaClass) => BACKGROUND_CLASSES.includes(c);

export interface QuotaPolicy {
  windowMs: number;
  limit: number; // documented API ceiling known to the application
  headroom: number; // requests never spent, left for other callers sharing the key
  reserve: Record<QuotaClass, number>; // per-window guarantee while the class is ACTIVE (soft; see header comment)
  idleFloor: Record<QuotaClass, number>; // what an IDLE class still holds back from lower classes
  demandHorizonMs: number; // a class is "active" for this long after its last request attempt
  pacing: boolean; // spread refresh/backfill evenly across the window
  paceBurst: number; // requests a background class may send immediately at the start of a window
  paceMaxInlineMs: number; // longest pacing delay absorbed inside the call; longer is deferred to the caller
  cooldownFallbackMs: number; // 429 without a usable reset header
  backgroundPauseAfter429Ms: number; // refresh/backfill stay paused this long after a cooldown ends
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// Defaults: 600 / 5 min, 30 headroom, reservations summing to the 570 that is
// actually spendable (120 + 60 + 60 + 80 + 250). While every higher class is
// idle the backfill may spend 570 - (40 + 15 + 15 + 20) = 480 per window
// (~96/min, about 15% of the spendable budget stays on standby); with all
// classes active it gets its reserved 250 exactly as before.
export function loadQuotaPolicy(env: NodeJS.ProcessEnv = process.env): QuotaPolicy {
  return {
    windowMs: envInt(env, "CH_QUOTA_WINDOW_SECONDS", 300) * 1000,
    limit: envInt(env, "CH_QUOTA_LIMIT", 600),
    headroom: envInt(env, "CH_QUOTA_HEADROOM", 30),
    reserve: {
      user: envInt(env, "CH_QUOTA_RESERVE_USER", 120),
      filing: envInt(env, "CH_QUOTA_RESERVE_FILING", 60),
      stream: envInt(env, "CH_QUOTA_RESERVE_STREAM", 60),
      refresh: envInt(env, "CH_QUOTA_RESERVE_REFRESH", 80),
      backfill: envInt(env, "CH_QUOTA_RESERVE_BACKFILL", 250),
    },
    idleFloor: {
      user: envInt(env, "CH_QUOTA_FLOOR_USER", 40),
      filing: envInt(env, "CH_QUOTA_FLOOR_FILING", 15),
      stream: envInt(env, "CH_QUOTA_FLOOR_STREAM", 15),
      refresh: envInt(env, "CH_QUOTA_FLOOR_REFRESH", 20),
      backfill: 0,
    },
    demandHorizonMs: envInt(env, "CH_QUOTA_DEMAND_HORIZON_SECONDS", 120) * 1000,
    pacing: env.CH_QUOTA_PACING !== "0",
    paceBurst: envInt(env, "CH_QUOTA_PACE_BURST", 10),
    paceMaxInlineMs: envInt(env, "CH_QUOTA_PACE_MAX_INLINE_SECONDS", 10) * 1000,
    cooldownFallbackMs: 30_000,
    backgroundPauseAfter429Ms: 60_000,
  };
}

export interface QuotaStateData {
  windowStartedAt: Date;
  windowEndsAt: Date;
  used: Record<QuotaClass, number>;
  headerRemaining: number | null;
  headerResetAt: Date | null;
  cooldownUntil: Date | null;
  backgroundPausedUntil: Date | null;
  last429At: Date | null;
  lastDemandAt: Record<QuotaClass, Date | null>; // last request attempt per class (backfill is never held for, so never read)
}

const noDemand = (): Record<QuotaClass, Date | null> => ({ user: null, filing: null, stream: null, refresh: null, backfill: null });
const zeroUsed = (): Record<QuotaClass, number> => ({ user: 0, filing: 0, stream: 0, refresh: 0, backfill: 0 });

export function freshQuotaState(now: Date, policy: QuotaPolicy): QuotaStateData {
  return {
    windowStartedAt: now,
    windowEndsAt: new Date(now.getTime() + policy.windowMs),
    used: zeroUsed(),
    headerRemaining: null,
    headerResetAt: null,
    cooldownUntil: null,
    backgroundPausedUntil: null,
    last429At: null,
    lastDemandAt: noDemand(),
  };
}

// A new accounting window starts once the local window - or the window the
// API itself last reported - has ended. Cooldown / pause timestamps survive.
export function rollWindow(state: QuotaStateData, now: Date, policy: QuotaPolicy): QuotaStateData {
  const ended = now >= state.windowEndsAt || (state.headerResetAt !== null && now >= state.headerResetAt);
  if (!ended) return state;
  return {
    ...state,
    windowStartedAt: now,
    windowEndsAt: new Date(now.getTime() + policy.windowMs),
    used: zeroUsed(),
    headerRemaining: null,
    headerResetAt: null,
  };
}

// A background request whose quota/pacing slot is at most this far away waits
// for it in place (the tail of a window) instead of being handed back.
export const INLINE_BACKGROUND_WAIT_MS = 15_000;

export type DenyReason = "cooldown" | "background_paused" | "quota" | "paced";

// Why the gate decided what it did. Always internal bookkeeping: none of this
// comes from Companies House except `headerRemaining` / `headerResetAt`.
export interface QuotaSnapshot {
  usedTotal: number;
  usedClass: number;
  headerRemaining: number | null;
  windowStartedAt: Date;
  windowEndsAt: Date;
  headerResetAt: Date | null;
  heldForHigher: number;
  available: number;
}

export type AcquireDecision =
  // delayMs > 0: the slot is counted now but the caller must wait that long
  // before sending (even pacing of the background classes).
  | { granted: true; delayMs: number }
  | { granted: false; waitMs: number; reason: DenyReason; snapshot: QuotaSnapshot };

const isActive = (state: QuotaStateData, c: QuotaClass, now: Date, policy: QuotaPolicy) => {
  const at = state.lastDemandAt[c];
  return at !== null && now.getTime() - at.getTime() <= policy.demandHorizonMs;
};

// Requests the HIGHER-priority classes still hold back from `cls`: the full
// reservation of a class with recent demand, only the idle floor otherwise.
// Whatever a class already spent this window counts towards its guarantee.
export function heldForHigherClasses(state: QuotaStateData, cls: QuotaClass, now: Date, policy: QuotaPolicy): number {
  const myRank = QUOTA_CLASSES.indexOf(cls);
  let held = 0;
  for (const higher of QUOTA_CLASSES.slice(0, myRank)) {
    const target = isActive(state, higher, now, policy) ? policy.reserve[higher] : Math.min(policy.reserve[higher], policy.idleFloor[higher]);
    held += Math.max(0, target - state.used[higher]);
  }
  return held;
}

// Pure decision. Returns the new state (with the request counted) when granted.
// The attempt itself is recorded as demand for the class, granted or not.
export function decideAcquire(
  input: QuotaStateData,
  cls: QuotaClass,
  now: Date,
  policy: QuotaPolicy
): { decision: AcquireDecision; state: QuotaStateData } {
  const rolled = rollWindow(input, now, policy);
  // Nothing ranks below the backfill, so only the other classes' demand matters.
  const state: QuotaStateData = cls === "backfill" ? rolled : { ...rolled, lastDemandAt: { ...rolled.lastDemandAt, [cls]: now } };

  const usedTotal = QUOTA_CLASSES.reduce((sum, c) => sum + state.used[c], 0);
  const availableLocal = policy.limit - policy.headroom - usedTotal;
  const availableHeader = state.headerRemaining === null ? Infinity : state.headerRemaining - policy.headroom;
  const available = Math.min(availableLocal, availableHeader);
  const heldForHigher = heldForHigherClasses(state, cls, now, policy);
  const windowEndMs = Math.min(state.windowEndsAt.getTime(), state.headerResetAt?.getTime() ?? Infinity);

  const snapshot: QuotaSnapshot = {
    usedTotal,
    usedClass: state.used[cls],
    headerRemaining: state.headerRemaining,
    windowStartedAt: state.windowStartedAt,
    windowEndsAt: state.windowEndsAt,
    headerResetAt: state.headerResetAt,
    heldForHigher,
    available,
  };
  const deny = (waitMs: number, reason: DenyReason) => ({
    decision: { granted: false as const, waitMs: Math.max(250, Math.ceil(waitMs)), reason, snapshot },
    state,
  });

  if (state.cooldownUntil && state.cooldownUntil > now) return deny(state.cooldownUntil.getTime() - now.getTime(), "cooldown");
  if (isBackgroundClass(cls) && state.backgroundPausedUntil && state.backgroundPausedUntil > now) {
    return deny(state.backgroundPausedUntil.getTime() - now.getTime(), "background_paused");
  }

  // Requests a higher-priority class holds back are off limits to this class.
  if (available - 1 < heldForHigher) return deny(windowEndMs - now.getTime(), "quota");

  // Even pacing of the background classes: the share this class may spend in
  // this window (what it already spent + what is still grantable) is released
  // evenly over the window, after a small initial burst, instead of all at
  // once. A request whose slot is a little in the future is granted now with a
  // delay (so the slot is counted immediately and several processes cannot
  // book the same one); a slot further away than paceMaxInlineMs is deferred.
  let delayMs = 0;
  if (policy.pacing && isBackgroundClass(cls)) {
    const cap = state.used[cls] + (available - heldForHigher);
    const durationMs = Math.max(1000, windowEndMs - state.windowStartedAt.getTime());
    const k = state.used[cls] + 1;
    const slotAt = state.windowStartedAt.getTime() + (Math.max(0, k - policy.paceBurst) / cap) * durationMs;
    delayMs = Math.max(0, Math.ceil(slotAt - now.getTime()));
    if (delayMs > policy.paceMaxInlineMs) return deny(delayMs, "paced");
  }

  return {
    decision: { granted: true, delayMs },
    state: {
      ...state,
      used: { ...state.used, [cls]: state.used[cls] + 1 },
      headerRemaining: state.headerRemaining === null ? null : Math.max(0, state.headerRemaining - 1),
    },
  };
}

export interface ResponseInfo {
  status: number; // 0 = network failure / timeout
  remaining: number | null; // X-Ratelimit-Remain
  resetEpochSeconds: number | null; // X-Ratelimit-Reset
}

// Folds a response into the shared state. Header values are authoritative.
// A 429 opens a GLOBAL cooldown (every process, every class waits) and keeps
// background classes paused a little longer so interactive traffic resumes
// first.
export function applyResponse(input: QuotaStateData, info: ResponseInfo, now: Date, policy: QuotaPolicy): QuotaStateData {
  const state = rollWindow(input, now, policy);
  const next: QuotaStateData = { ...state };
  const resetAt = info.resetEpochSeconds !== null ? new Date(info.resetEpochSeconds * 1000) : null;

  if (info.remaining !== null) {
    next.headerRemaining = info.remaining;
    if (resetAt && resetAt > now) next.headerResetAt = resetAt;
  }

  if (info.status === 429) {
    const until = resetAt && resetAt > now ? resetAt : new Date(now.getTime() + policy.cooldownFallbackMs);
    if (!next.cooldownUntil || until > next.cooldownUntil) next.cooldownUntil = until;
    next.backgroundPausedUntil = new Date(next.cooldownUntil.getTime() + policy.backgroundPauseAfter429Ms);
    next.last429At = now;
    next.headerRemaining = 0;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------
export interface QuotaStore {
  update<T>(fn: (state: QuotaStateData) => { state: QuotaStateData; result: T }): Promise<T>;
  read(): Promise<QuotaStateData | null>;
}

export class MemoryQuotaStore implements QuotaStore {
  private state: QuotaStateData | null = null;
  constructor(private policy: QuotaPolicy = loadQuotaPolicy()) {}
  async update<T>(fn: (state: QuotaStateData) => { state: QuotaStateData; result: T }): Promise<T> {
    const { state, result } = fn(this.state ?? freshQuotaState(new Date(), this.policy));
    this.state = state;
    return result;
  }
  async read() {
    return this.state;
  }
}

interface QuotaRow {
  windowStartedAt: Date;
  windowEndsAt: Date;
  usedUser: number;
  usedFiling: number;
  usedStream: number;
  usedRefresh: number;
  usedBackfill: number;
  headerRemaining: number | null;
  headerResetAt: Date | null;
  cooldownUntil: Date | null;
  backgroundPausedUntil: Date | null;
  last429At: Date | null;
  demandUserAt: Date | null;
  demandFilingAt: Date | null;
  demandStreamAt: Date | null;
  demandRefreshAt: Date | null;
}

const rowToState = (r: QuotaRow): QuotaStateData => ({
  windowStartedAt: r.windowStartedAt,
  windowEndsAt: r.windowEndsAt,
  used: { user: r.usedUser, filing: r.usedFiling, stream: r.usedStream, refresh: r.usedRefresh, backfill: r.usedBackfill },
  headerRemaining: r.headerRemaining,
  headerResetAt: r.headerResetAt,
  cooldownUntil: r.cooldownUntil,
  backgroundPausedUntil: r.backgroundPausedUntil,
  last429At: r.last429At,
  lastDemandAt: { user: r.demandUserAt ?? null, filing: r.demandFilingAt ?? null, stream: r.demandStreamAt ?? null, refresh: r.demandRefreshAt ?? null, backfill: null },
});

const stateToRow = (s: QuotaStateData) => ({
  windowStartedAt: s.windowStartedAt,
  windowEndsAt: s.windowEndsAt,
  usedUser: s.used.user,
  usedFiling: s.used.filing,
  usedStream: s.used.stream,
  usedRefresh: s.used.refresh,
  usedBackfill: s.used.backfill,
  headerRemaining: s.headerRemaining,
  headerResetAt: s.headerResetAt,
  cooldownUntil: s.cooldownUntil,
  backgroundPausedUntil: s.backgroundPausedUntil,
  last429At: s.last429At,
  demandUserAt: s.lastDemandAt.user,
  demandFilingAt: s.lastDemandAt.filing,
  demandStreamAt: s.lastDemandAt.stream,
  demandRefreshAt: s.lastDemandAt.refresh,
});

const STATE_ID = "rest";

export class DbQuotaStore implements QuotaStore {
  private ensured = false;
  constructor(private policy: QuotaPolicy = loadQuotaPolicy()) {}

  private async ensureRow() {
    if (this.ensured) return;
    const fresh = stateToRow(freshQuotaState(new Date(), this.policy));
    await db.chQuotaState.createMany({ data: [{ id: STATE_ID, ...fresh }], skipDuplicates: true });
    this.ensured = true;
  }

  async update<T>(fn: (state: QuotaStateData) => { state: QuotaStateData; result: T }): Promise<T> {
    await this.ensureRow();
    return db.$transaction(
      async (tx) => {
        let rows = await tx.$queryRaw<QuotaRow[]>`SELECT * FROM "ChQuotaState" WHERE "id" = ${STATE_ID} FOR UPDATE`;
        if (rows.length === 0) {
          // The row was removed (manual reset): recreate it and lock it.
          await tx.chQuotaState.createMany({ data: [{ id: STATE_ID, ...stateToRow(freshQuotaState(new Date(), this.policy)) }], skipDuplicates: true });
          rows = await tx.$queryRaw<QuotaRow[]>`SELECT * FROM "ChQuotaState" WHERE "id" = ${STATE_ID} FOR UPDATE`;
        }
        const { state, result } = fn(rowToState(rows[0]));
        await tx.chQuotaState.update({ where: { id: STATE_ID }, data: stateToRow(state) });
        return result;
      },
      { timeout: 5000 }
    );
  }

  async read() {
    const row = await db.chQuotaState.findUnique({ where: { id: STATE_ID } });
    return row ? rowToState(row) : null;
  }
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------
let primaryStore: QuotaStore | null = null;
let fallbackStore: MemoryQuotaStore | null = null;
let warnedFallback = false;
let policyOverride: QuotaPolicy | null = null;

const policy = () => policyOverride ?? loadQuotaPolicy();

// Tests inject stores / policy; production uses the database store.
// Clears the shared quota row (tests / manual recovery).
export async function resetSharedQuotaState(): Promise<void> {
  await db.chQuotaState.deleteMany({ where: { id: STATE_ID } });
}

export function configureQuotaGate(opts: { store?: QuotaStore | null; policy?: QuotaPolicy | null } = {}) {
  primaryStore = opts.store ?? null;
  policyOverride = opts.policy ?? null;
  fallbackStore = null;
  warnedFallback = false;
}

function stores(): { primary: QuotaStore; fallback: MemoryQuotaStore } {
  primaryStore ??= new DbQuotaStore(policy());
  // Used only when the database cannot be reached: a conservative in-process
  // budget (half the ceiling) because other processes may also be spending.
  fallbackStore ??= new MemoryQuotaStore(policy());
  return { primary: primaryStore, fallback: fallbackStore };
}

async function withStore<T>(run: (store: QuotaStore, p: QuotaPolicy) => Promise<T>): Promise<T> {
  const { primary, fallback } = stores();
  try {
    return await run(primary, policy());
  } catch (err) {
    if (!warnedFallback) {
      warnedFallback = true;
      console.warn(`[ch-quota] shared quota store unavailable (${err instanceof Error ? err.message : err}); using a conservative in-process budget`);
    }
    const p = policy();
    return run(fallback, { ...p, limit: Math.floor(p.limit / 2) });
  }
}

export async function acquireQuota(cls: QuotaClass, now: Date = new Date()): Promise<AcquireDecision> {
  return withStore((store, p) =>
    store.update((state) => {
      const { decision, state: next } = decideAcquire(state, cls, now, p);
      return { state: next, result: decision };
    })
  );
}

// Returns the shared state after the response was folded in (for diagnostics).
export async function recordQuotaResponse(info: ResponseInfo, now: Date = new Date()): Promise<QuotaStateData> {
  return withStore((store, p) =>
    store.update((state) => {
      const next = applyResponse(state, info, now, p);
      return { state: next, result: next };
    })
  );
}

export async function readQuotaState(): Promise<{ state: QuotaStateData | null; policy: QuotaPolicy }> {
  const p = policy();
  const { primary } = stores();
  return { state: await primary.read(), policy: p };
}

// ---------------------------------------------------------------------------
// Hourly request statistics (admin observability). Never allowed to break a
// Companies House call.
// ---------------------------------------------------------------------------
export type RequestOutcome = "ok" | "404" | "429" | "auth" | "5xx" | "network";

export function outcomeFromStatus(status: number): RequestOutcome {
  if (status === 0) return "network";
  if (status === 429) return "429";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "404";
  if (status >= 500) return "5xx";
  return "ok"; // 2xx (other 4xx are counted as ok responses; they are not quota/health signals)
}

export async function recordRequestStat(cls: QuotaClass, outcome: RequestOutcome, now: Date = new Date()): Promise<void> {
  const bucket = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
  const col = { ok: "ok", "404": "status404", "429": "status429", auth: "statusAuth", "5xx": "status5xx", network: "networkErrors" }[outcome];
  try {
    // Column name comes from the fixed map above, never from input.
    await db.$executeRawUnsafe(
      `INSERT INTO "ChRequestStat" ("bucketStart","quotaClass","requests","${col}") VALUES ($1::timestamp,$2,1,1)
       ON CONFLICT ("bucketStart","quotaClass") DO UPDATE SET "requests" = "ChRequestStat"."requests" + 1, "${col}" = "ChRequestStat"."${col}" + 1`,
      bucket.toISOString(),
      cls
    );
  } catch {
    /* observability only */
  }
}

// ---------------------------------------------------------------------------
// Quota diagnostics. One row per internal denial or real HTTP 429 (never per
// granted request), so "our own gate said wait" and "Companies House said 429"
// can be told apart afterwards. Best effort: never allowed to break a call.
// ---------------------------------------------------------------------------
export type QuotaEventKind = "quota_denied" | "http_429";

export interface QuotaEventInput {
  kind: QuotaEventKind;
  quotaClass: QuotaClass;
  reason: DenyReason | "http_429";
  httpStatus: number | null; // actual HTTP status of a Companies House response; null for internal denials
  waitMs: number | null;
  snapshot: Pick<QuotaSnapshot, "usedTotal" | "usedClass" | "headerRemaining" | "windowStartedAt" | "windowEndsAt" | "headerResetAt"> | null;
}

const EVENT_RETENTION_MS = 14 * 24 * 3_600_000;

export function snapshotFromState(state: QuotaStateData, cls: QuotaClass): NonNullable<QuotaEventInput["snapshot"]> {
  return {
    usedTotal: QUOTA_CLASSES.reduce((sum, c) => sum + state.used[c], 0),
    usedClass: state.used[cls],
    headerRemaining: state.headerRemaining,
    windowStartedAt: state.windowStartedAt,
    windowEndsAt: state.windowEndsAt,
    headerResetAt: state.headerResetAt,
  };
}

export async function recordQuotaEvent(event: QuotaEventInput, now: Date = new Date()): Promise<void> {
  try {
    await db.chQuotaEvent.create({
      data: {
        at: now,
        kind: event.kind,
        quotaClass: event.quotaClass,
        reason: event.reason,
        internal: event.kind === "quota_denied",
        httpStatus: event.httpStatus,
        waitMs: event.waitMs === null ? null : Math.round(event.waitMs),
        usedTotal: event.snapshot?.usedTotal ?? null,
        usedClass: event.snapshot?.usedClass ?? null,
        headerRemaining: event.snapshot?.headerRemaining ?? null,
        windowStartedAt: event.snapshot?.windowStartedAt ?? null,
        windowEndsAt: event.snapshot?.windowEndsAt ?? null,
        headerResetAt: event.snapshot?.headerResetAt ?? null,
      },
    });
    if (Math.random() < 0.01) await db.chQuotaEvent.deleteMany({ where: { at: { lt: new Date(now.getTime() - EVENT_RETENTION_MS) } } });
  } catch {
    /* diagnostics only */
  }
}
