import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  acquireQuota,
  applyResponse,
  configureQuotaGate,
  decideAcquire,
  freshQuotaState,
  INLINE_BACKGROUND_WAIT_MS,
  loadQuotaPolicy,
  MemoryQuotaStore,
  outcomeFromStatus,
  recordQuotaResponse,
  type QuotaClass,
  type QuotaPolicy,
  type QuotaStateData,
} from "../../src/lib/companies-house/quota";
import {
  checkAuth,
  checkBreakers,
  checkOutage,
  closedBreaker,
  configureBreakers,
  loadBreakerPolicy,
  MemoryBreakerStore,
  readBreaker,
  recordAuth,
  recordBreakerOutcome,
  recordOutage,
  resetBreaker,
} from "../../src/lib/companies-house/breaker";

const policy: QuotaPolicy = loadQuotaPolicy({} as NodeJS.ProcessEnv);
// Budget arithmetic at a single instant: pacing is tested separately (it spreads a window over time).
const flat: QuotaPolicy = { ...policy, pacing: false };
const NOW = new Date("2026-10-01T12:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);

afterEach(() => {
  configureQuotaGate({});
  configureBreakers({});
});

// Spends `n` requests of a class against a state; returns how many were granted.
function spend(state: QuotaStateData, cls: QuotaClass, n: number, now = NOW, p = flat) {
  let granted = 0;
  let s = state;
  for (let i = 0; i < n; i++) {
    const r = decideAcquire(s, cls, now, p);
    s = r.state;
    if (r.decision.granted) granted++;
  }
  return { granted, state: s };
}

// ---- quota gate -----------------------------------------------------------------------------------
test("defaults: 600 requests / 5 minutes, 30 headroom, reservations sum to what is spendable", () => {
  assert.equal(policy.limit, 600);
  assert.equal(policy.windowMs, 300_000);
  assert.equal(policy.headroom, 30);
  const sum = Object.values(policy.reserve).reduce((a, b) => a + b, 0);
  assert.equal(sum, policy.limit - policy.headroom);
  // policy values are configurable, not hard-coded
  const p = loadQuotaPolicy({ CH_QUOTA_LIMIT: "100", CH_QUOTA_RESERVE_USER: "7", CH_QUOTA_HEADROOM: "5" } as unknown as NodeJS.ProcessEnv);
  assert.equal(p.limit, 100);
  assert.equal(p.reserve.user, 7);
  assert.equal(p.headroom, 5);
});

test("the whole window never exceeds limit - headroom, whatever the mix", () => {
  const { granted } = spend(freshQuotaState(NOW, flat), "user", 5000);
  assert.equal(granted, policy.limit - policy.headroom);
});

test("backfill yields first: it can never eat what the other classes hold back (idle floors while they are idle)", () => {
  const { granted, state } = spend(freshQuotaState(NOW, flat), "backfill", 5000);
  const floors = flat.idleFloor.user + flat.idleFloor.filing + flat.idleFloor.stream + flat.idleFloor.refresh;
  assert.equal(granted, flat.limit - flat.headroom - floors, "idle capacity is usable by the backfill");
  assert.ok(granted > flat.reserve.backfill, "far more than the old static 250");
  // ...so interactive / filing / stream requests are still granted after the backfill is exhausted
  for (const cls of ["user", "filing", "stream", "refresh"] as QuotaClass[]) {
    assert.equal(decideAcquire(state, cls, NOW, flat).decision.granted, true, `${cls} still gets its floor`);
  }
  assert.equal(decideAcquire(state, "backfill", NOW, flat).decision.granted, false);
});

test("higher-priority traffic reclaims its FULL reservation the moment it shows demand", () => {
  // The backfill has only spent half of what it could; then a user request arrives.
  let s = spend(freshQuotaState(NOW, flat), "backfill", 100).state;
  const user = decideAcquire(s, "user", NOW, flat);
  assert.equal(user.decision.granted, true, "a user request is granted immediately");
  s = user.state;
  // user is now ACTIVE: its whole reservation (120, minus the 1 spent) is held back from the backfill
  const { granted } = spend(s, "backfill", 5000);
  const heldNow = flat.reserve.user - 1 + flat.idleFloor.filing + flat.idleFloor.stream + flat.idleFloor.refresh;
  assert.equal(granted, flat.limit - flat.headroom - 100 - 1 - heldNow);
  // all four higher classes active -> exactly the old static split (250 for the backfill)
  let all = freshQuotaState(NOW, flat);
  for (const c of ["user", "filing", "stream", "refresh"] as QuotaClass[]) all = decideAcquire(all, c, NOW, flat).state;
  const used = 4;
  const heldAll = flat.reserve.user + flat.reserve.filing + flat.reserve.stream + flat.reserve.refresh - used;
  assert.equal(spend(all, "backfill", 5000).granted, flat.limit - flat.headroom - used - heldAll);
});

test("demand expires: an idle class falls back to its floor after the horizon", () => {
  const s = decideAcquire(freshQuotaState(NOW, flat), "user", NOW, flat).state;
  const during = spend({ ...s, used: { ...s.used, user: 0 } }, "backfill", 5000, at(30_000)).granted;
  // a rolled window is needed for the later comparison: same window, later clock
  const later = spend({ ...s, used: { ...s.used, user: 0 } }, "backfill", 5000, at(flat.demandHorizonMs + 1000)).granted;
  assert.ok(later > during, "after the horizon the user stops holding its full reservation");
});

test("no overspending, whatever the mix: total never exceeds limit - headroom", () => {
  let s = freshQuotaState(NOW, flat);
  const order: QuotaClass[] = ["backfill", "user", "refresh", "stream", "filing", "backfill", "user"];
  let total = 0;
  for (let i = 0; i < 4000; i++) {
    const r = decideAcquire(s, order[i % order.length], NOW, flat);
    s = r.state;
    if (r.decision.granted) total++;
  }
  assert.ok(total <= flat.limit - flat.headroom, `granted ${total}`);
  assert.equal(total, flat.limit - flat.headroom);
});

test("a user can burst into everyone else's unused quota; priority order is user > filing > stream > refresh > backfill", () => {
  const afterUser = spend(freshQuotaState(NOW, flat), "user", 5000);
  assert.equal(afterUser.granted, policy.limit - policy.headroom, "user may use the whole spendable budget");
  // refresh yields to the unspent reservations of user/filing/stream, backfill additionally to refresh
  const fresh = freshQuotaState(NOW, flat);
  const refresh = spend(fresh, "refresh", 5000).granted;
  const backfill = spend(fresh, "backfill", 5000).granted;
  assert.ok(refresh > backfill);
});

test("a denied request says how long to wait; the next window starts clean", () => {
  const full = spend(freshQuotaState(NOW, flat), "user", 5000).state;
  const denied = decideAcquire(full, "user", at(1000), policy);
  assert.equal(denied.decision.granted, false);
  if (!denied.decision.granted) {
    assert.equal(denied.decision.reason, "quota");
    assert.ok(denied.decision.waitMs > 0 && denied.decision.waitMs <= policy.windowMs);
  }
  assert.equal(decideAcquire(full, "user", at(policy.windowMs + 1), policy).decision.granted, true, "window rolled over");
});

test("response headers are authoritative: X-Ratelimit-Remain lower than our own count throttles everyone", () => {
  let s = freshQuotaState(NOW, policy);
  s = applyResponse(s, { status: 200, remaining: 40, resetEpochSeconds: Math.floor(NOW.getTime() / 1000) + 120 }, NOW, policy);
  const { granted } = spend(s, "user", 1000);
  assert.equal(granted, 40 - policy.headroom, "only (remaining - headroom) more requests are allowed");
});

test("HTTP 429 opens a GLOBAL cooldown until the advertised reset, and background work stays paused longer", () => {
  const reset = Math.floor(NOW.getTime() / 1000) + 30;
  const s = applyResponse(freshQuotaState(NOW, policy), { status: 429, remaining: 0, resetEpochSeconds: reset }, NOW, policy);
  for (const cls of ["user", "filing", "stream", "refresh", "backfill"] as QuotaClass[]) {
    const d = decideAcquire(s, cls, at(1000), policy).decision;
    assert.equal(d.granted, false, `${cls} waits during the cooldown`);
    if (!d.granted) assert.equal(d.reason, "cooldown");
  }
  // after the cooldown: interactive classes resume, background classes stay paused
  const afterCooldown = at(31_000);
  const s2 = { ...s, headerRemaining: null, headerResetAt: null }; // the API window has moved on
  assert.equal(decideAcquire(s2, "user", afterCooldown, policy).decision.granted, true);
  const bg = decideAcquire(s2, "backfill", afterCooldown, policy).decision;
  assert.equal(bg.granted, false);
  if (!bg.granted) assert.equal(bg.reason, "background_paused");
  assert.equal(decideAcquire(s2, "backfill", at(31_000 + policy.backgroundPauseAfter429Ms + 1000), policy).decision.granted, true);
});

test("429 without a usable reset header falls back to a fixed cooldown", () => {
  const s = applyResponse(freshQuotaState(NOW, policy), { status: 429, remaining: null, resetEpochSeconds: null }, NOW, policy);
  assert.equal(s.cooldownUntil?.getTime(), NOW.getTime() + policy.cooldownFallbackMs);
});

test("the shared gate (injected store) serialises acquires and records responses", async () => {
  configureQuotaGate({ store: new MemoryQuotaStore(policy), policy });
  assert.equal((await acquireQuota("user", NOW)).granted, true);
  await recordQuotaResponse({ status: 429, remaining: 0, resetEpochSeconds: Math.floor(NOW.getTime() / 1000) + 10 }, NOW);
  const denied = await acquireQuota("user", at(1000));
  assert.equal(denied.granted, false, "a 429 recorded by one caller is visible to the next caller");
});

test("status -> outcome classification for request stats", () => {
  assert.deepEqual([200, 404, 429, 401, 403, 500, 503, 0].map(outcomeFromStatus), ["ok", "404", "429", "auth", "auth", "5xx", "5xx", "network"]);
});

// ---- auth circuit breaker (401 / 403) -------------------------------------------------------------
const bp = loadBreakerPolicy({} as NodeJS.ProcessEnv);

test("401 breaker: two consecutive 401s open it; a 404/200 in between proves the key works", () => {
  let b = closedBreaker();
  b = recordAuth(b, 401, NOW, bp);
  assert.equal(b.state, "closed", "one 401 is not enough");
  b = recordAuth(b, 200, NOW, bp);
  assert.equal(b.consecutiveFailures, 0, "a good response resets the count");
  b = recordAuth(recordAuth(b, 401, NOW, bp), 401, NOW, bp);
  assert.equal(b.state, "open");
  assert.match(b.reason ?? "", /401/);
  assert.equal(checkAuth(b, at(1000), bp).check.allow, false, "no requests while open");
});

test("403 opens the breaker the same way", () => {
  const b = recordAuth(recordAuth(closedBreaker(), 403, NOW, bp), 403, NOW, bp);
  assert.equal(b.state, "open");
  assert.match(b.reason ?? "", /403/);
});

test("half-open probe: after the cool-off exactly ONE probe is allowed; success closes, failure re-opens", () => {
  const open = recordAuth(recordAuth(closedBreaker(), 401, NOW, bp), 401, NOW, bp);
  const due = at(bp.authProbeAfterMs + 1000);
  const first = checkAuth(open, due, bp);
  assert.deepEqual(first.check, { allow: true, probe: true });
  assert.equal(first.data.state, "half_open");
  // a second caller while the probe is in flight is refused (no request burst)
  assert.equal(checkAuth(first.data, at(bp.authProbeAfterMs + 2000), bp).check.allow, false);
  // probe fails -> open again, with a new cool-off
  const failed = recordAuth(first.data, 401, due, bp);
  assert.equal(failed.state, "open");
  assert.ok(failed.openUntil && failed.openUntil > due);
  // probe succeeds -> closed
  const ok = recordAuth(first.data, 200, due, bp);
  assert.equal(ok.state, "closed");
  assert.equal(ok.consecutiveFailures, 0);
});

test("a broken key cannot burn hundreds of requests: after it opens, every further check is refused", async () => {
  configureBreakers({ store: new MemoryBreakerStore(), policy: bp });
  let sent = 0;
  for (let i = 0; i < 200; i++) {
    const gate = await checkBreakers(true, at(i));
    if (!gate.allow) continue;
    sent++;
    await recordBreakerOutcome(401, at(i));
  }
  assert.equal(sent, bp.authThreshold, "only the threshold number of requests ever reached Companies House");
  assert.equal((await readBreaker("auth")).state, "open");
  await resetBreaker("auth");
  assert.equal((await checkBreakers(false, at(500))).allow, true, "manual reset closes it");
});

// ---- outage breaker (5xx / network) ---------------------------------------------------------------
test("5xx/network outage breaker: opens on a failure wave, back-off grows, background only", () => {
  let b = closedBreaker();
  for (let i = 0; i < 10; i++) b = recordOutage(b, true, NOW, bp);
  assert.equal(b.state, "closed", "10 of 20 is not yet more than half");
  b = recordOutage(b, true, NOW, bp);
  assert.equal(b.state, "open");
  assert.equal(b.openUntil!.getTime() - NOW.getTime(), bp.outageBaseBackoffMs);
  assert.equal(checkOutage(b, at(1000)).allow, false);
  assert.equal(checkOutage(b, at(bp.outageBaseBackoffMs + 1)).allow, true, "after the back-off background work may try again");
  // failing again after the back-off doubles it
  let again = b;
  const later = at(bp.outageBaseBackoffMs + 2000);
  for (let i = 0; i < 11; i++) again = recordOutage(again, true, later, bp);
  assert.equal(again.openUntil!.getTime() - later.getTime(), bp.outageBaseBackoffMs * 2);
});

test("a healthy window after the back-off closes the outage breaker; 429s do not count as an outage", async () => {
  configureBreakers({ store: new MemoryBreakerStore(), policy: bp });
  for (let i = 0; i < 11; i++) await recordBreakerOutcome(503, at(i));
  assert.equal((await readBreaker("outage")).state, "open");
  assert.equal((await checkBreakers(true, at(1000))).allow, false, "background work is paused");
  assert.equal((await checkBreakers(false, at(1000))).allow, true, "interactive work still tries");
  await recordBreakerOutcome(200, at(bp.outageBaseBackoffMs + 5000));
  assert.equal((await readBreaker("outage")).state, "closed");

  configureBreakers({ store: new MemoryBreakerStore(), policy: bp });
  for (let i = 0; i < 50; i++) await recordBreakerOutcome(429, at(i));
  assert.equal((await readBreaker("outage")).state, "closed", "rate limiting is not an outage");
});

// ---- demand-aware policy, pacing and diagnostics ----------------------------------------------------
test("defaults keep the old reservations as the ACTIVE guarantee and add small idle floors", () => {
  for (const c of ["user", "filing", "stream", "refresh"] as QuotaClass[]) assert.ok(policy.idleFloor[c] <= policy.reserve[c], c);
  const floors = policy.idleFloor.user + policy.idleFloor.filing + policy.idleFloor.stream + policy.idleFloor.refresh;
  assert.equal(floors, 90);
  assert.equal(policy.limit - policy.headroom - floors, 480, "backfill capacity per window while everyone else is idle");
  assert.equal(policy.pacing, true);
  assert.equal(loadQuotaPolicy({ CH_QUOTA_PACING: "0" } as unknown as NodeJS.ProcessEnv).pacing, false);
});

// One worker, one request in flight, `latencyMs` per request, virtual clock.
function simulate(minutes: number, latencyMs: number, p: QuotaPolicy, interactiveEverySec = 0) {
  let state = freshQuotaState(NOW, p);
  let t = NOW.getTime();
  const end = t + minutes * 60_000;
  let sent = 0;
  let deferred = 0;
  let nextUser = t + interactiveEverySec * 1000;
  const perWindow = new Map<number, number>();
  while (t < end) {
    if (interactiveEverySec && t >= nextUser) {
      state = decideAcquire(state, "user", new Date(t), p).state;
      nextUser += interactiveEverySec * 1000;
    }
    const r = decideAcquire(state, "backfill", new Date(t), p);
    state = r.state;
    if (r.decision.granted) {
      sent++;
      perWindow.set(state.windowStartedAt.getTime(), (perWindow.get(state.windowStartedAt.getTime()) ?? 0) + 1);
      t += r.decision.delayMs + latencyMs;
    } else if ((r.decision.reason === "quota" || r.decision.reason === "paced") && r.decision.waitMs <= INLINE_BACKGROUND_WAIT_MS) {
      t += r.decision.waitMs + 50; // the client waits out the tail of a window in place
    } else {
      deferred++; // handed back to the worker
      t += r.decision.waitMs;
    }
  }
  return { sent, deferred, perWindow: [...perWindow.values()] };
}

test("pacing: one sequential worker uses the idle capacity smoothly - ~480 per window, no deferral churn", () => {
  const r = simulate(30, 200, policy);
  const full = r.perWindow.slice(1, -1); // ignore the partial first / last window
  assert.ok(full.length >= 4);
  for (const n of full) assert.ok(n >= 470 && n <= 480 + policy.paceBurst, `window sent ${n}`);
  assert.equal(r.deferred, 0, "a steady crawl never hands work back");
  const perMinute = r.sent / 30;
  assert.ok(perMinute > 90 && perMinute < 100, `${perMinute.toFixed(1)} requests/min`);
});

test("pacing: the old behaviour is reproduced when interactive demand is constant (backfill falls back to its reserve)", () => {
  const r = simulate(30, 200, policy, 5); // a user request every 5s keeps every higher class... user active
  const full = r.perWindow.slice(1, -1);
  for (const n of full) assert.ok(n < 470, `backfill yields while the user is active: ${n}`);
  assert.ok(full.every((n) => n > 0), "but is never starved to zero");
});

test("pacing never lets total spend exceed limit - headroom in a window, even with a user burst", () => {
  let state = freshQuotaState(NOW, policy);
  let t = NOW.getTime();
  let granted = 0;
  for (let i = 0; i < 3000; i++) {
    const cls: QuotaClass = i % 3 === 0 ? "user" : "backfill";
    const r = decideAcquire(state, cls, new Date(t), policy);
    state = r.state;
    if (r.decision.granted) granted++;
    t += 50; // 3000 attempts over 150 s: all inside the first window
  }
  assert.ok(granted <= policy.limit - policy.headroom, `granted ${granted}`);
});

test("pacing is bypassed for interactive classes and can be switched off", () => {
  const burst = spend(freshQuotaState(NOW, policy), "user", 100, NOW, policy);
  assert.equal(burst.granted, 100, "user requests are never paced");
  const off = spend(freshQuotaState(NOW, flat), "backfill", 100, NOW, flat);
  assert.equal(off.granted, 100);
  const d = decideAcquire(freshQuotaState(NOW, policy), "backfill", NOW, policy).decision;
  assert.deepEqual(d, { granted: true, delayMs: 0 }, "the first request of a window goes out at once");
});

test("a far-away pacing slot is DEFERRED with reason 'paced', not granted", () => {
  const p: QuotaPolicy = { ...policy, paceMaxInlineMs: 1000 };
  const r = spend(freshQuotaState(NOW, p), "backfill", 1000, NOW, p);
  assert.ok(r.granted < 40);
  const d = decideAcquire(r.state, "backfill", NOW, p).decision;
  assert.equal(d.granted, false);
  if (!d.granted) {
    assert.equal(d.reason, "paced");
    assert.ok(d.waitMs >= 250 && d.waitMs <= p.windowMs);
    assert.equal(typeof d.snapshot.usedTotal, "number");
    assert.equal(d.snapshot.usedClass, r.granted);
  }
});

test("internal quota denial is NOT an HTTP 429: different class, different message, flag, snapshot; callers that back off still catch it", async () => {
  const { CompaniesHouseQuotaDeferredError, CompaniesHouseRateLimitError } = await import("../../src/lib/companies-house/client");
  const full = spend(freshQuotaState(NOW, flat), "backfill", 5000, NOW, flat).state;
  const denied = decideAcquire(full, "backfill", at(1000), flat).decision;
  assert.equal(denied.granted, false);
  if (denied.granted) return;
  const internal = new CompaniesHouseQuotaDeferredError(denied.waitMs, denied.reason, denied.snapshot);
  const real = new CompaniesHouseRateLimitError(30_000);
  assert.equal(internal.http429, false);
  assert.equal(real.http429, true);
  assert.match(internal.message, /internal quota gate/);
  assert.match(internal.message, /Not an HTTP 429/);
  assert.doesNotMatch(internal.message, /rate limit hit/i);
  assert.match(real.message, /HTTP 429/);
  assert.ok(internal instanceof CompaniesHouseRateLimitError, "existing `instanceof CompaniesHouseRateLimitError` back-off paths keep working");
  assert.equal(internal.snapshot.headerRemaining, null);
  assert.equal(internal.reason, "quota");
});

test("a real 429 still opens a global cooldown through the shared gate, and the state is returned for diagnostics", async () => {
  const T = new Date(); // MemoryQuotaStore seeds its window from the real clock
  const later = (ms: number) => new Date(T.getTime() + ms);
  configureQuotaGate({ store: new MemoryQuotaStore(policy), policy });
  assert.equal((await acquireQuota("backfill", T)).granted, true);
  const state = await recordQuotaResponse({ status: 429, remaining: 0, resetEpochSeconds: Math.floor(T.getTime() / 1000) + 45 }, T);
  assert.ok(state.cooldownUntil && state.cooldownUntil.getTime() >= T.getTime() + 44_000);
  assert.equal(state.last429At?.getTime(), T.getTime());
  for (const cls of ["user", "backfill"] as QuotaClass[]) {
    const d = await acquireQuota(cls, later(5000));
    assert.equal(d.granted, false);
    if (!d.granted) assert.equal(d.reason, "cooldown");
  }
});

test("two gate users sharing ONE store (the database row in production) never overspend together", async () => {
  const shared = new MemoryQuotaStore(policy);
  configureQuotaGate({ store: shared, policy });
  let granted = 0;
  // "process A" and "process B" alternate against the same state, same instant
  const T = new Date();
  for (let i = 0; i < 4000; i++) {
    const d = await acquireQuota(i % 2 ? "backfill" : "refresh", T);
    if (d.granted) granted++;
  }
  assert.ok(granted > 0);
  assert.ok(granted <= policy.limit - policy.headroom);
});
