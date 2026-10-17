import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeBackoffMs,
  loadOfficerConfig,
  OFFICER_PRIORITY,
  planFailure,
  quotaClassForPriority,
  retryCapForBatch,
} from "../../src/lib/companies-house/officerQueue";
import { INCORPORATION_FILING_TYPES, isOfficerChangeFiling, OFFICER_CHANGE_FILING_TYPES } from "../../src/lib/companies-house/officerFreshness";

const cfg = loadOfficerConfig({} as NodeJS.ProcessEnv);
const NOW = new Date("2026-10-01T00:00:00Z");
const MIN = 60_000;

// ---- priorities ----------------------------------------------------------------------------------
test("priority levels are ordered P0 (viewing) .. P5 (crawl); lower number runs first", () => {
  assert.deepEqual(
    [OFFICER_PRIORITY.VIEWING, OFFICER_PRIORITY.REPORT, OFFICER_PRIORITY.FOLLOWED, OFFICER_PRIORITY.FILTER, OFFICER_PRIORITY.REFRESH, OFFICER_PRIORITY.CRAWL],
    [0, 1, 2, 3, 4, 5]
  );
});

test("quota class by priority: viewing=user, refresh=refresh, everything else background=backfill", () => {
  assert.equal(quotaClassForPriority(0), "user");
  assert.equal(quotaClassForPriority(4), "refresh");
  for (const p of [1, 2, 3, 5]) assert.equal(quotaClassForPriority(p), "backfill");
});

// ---- retry planning --------------------------------------------------------------------------------
test("backoff grows exponentially (5m, 30m, 2h, 8h, 24h, 72h) with +/-20% jitter", () => {
  const mid = () => 0.5; // no jitter
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => computeBackoffMs(n, cfg, mid)), [5 * MIN, 30 * MIN, 120 * MIN, 480 * MIN, 1440 * MIN, 4320 * MIN]);
  assert.equal(computeBackoffMs(99, cfg, mid), 4320 * MIN, "the last step repeats");
  assert.equal(computeBackoffMs(1, cfg, () => 0), 4 * MIN);
  assert.equal(computeBackoffMs(1, cfg, () => 1), 6 * MIN);
});

test("a failing company retries with back-off, then is PARKED at the retry cap", () => {
  const mid = () => 0.5;
  let attempts = 0;
  for (let i = 1; i < cfg.maxAttempts; i++) {
    const plan = planFailure(attempts, NOW, cfg, mid);
    assert.equal(plan.status, "retry", `failure ${i}`);
    assert.equal(plan.attempts, i);
    assert.ok(plan.nextAttemptAt.getTime() > NOW.getTime(), "next attempt is in the future (it leaves the head of the queue)");
    assert.equal(plan.parkedAt, null);
    attempts = plan.attempts;
  }
  const last = planFailure(attempts, NOW, cfg, mid);
  assert.equal(last.status, "parked");
  assert.equal(last.attempts, cfg.maxAttempts);
  assert.deepEqual(last.parkedAt, NOW);
});

test("retries can fill at most 10% of a batch (never starve new work)", () => {
  assert.equal(retryCapForBatch(25, cfg), 3);
  assert.equal(retryCapForBatch(100, cfg), 10);
  assert.equal(retryCapForBatch(1, cfg), 1);
});

test("config defaults: 5 minute lease, 6 attempts, enqueue cap, thresholds are env-overridable", () => {
  assert.equal(cfg.leaseMs, 5 * MIN);
  assert.equal(cfg.maxAttempts, 6);
  assert.equal(cfg.enqueueCap, 2000);
  assert.equal(cfg.staleAfterDays, 180);
  const o = loadOfficerConfig({ OFFICER_ENQUEUE_CAP: "50", OFFICER_MAX_ATTEMPTS: "3", OFFICER_STALE_AFTER_DAYS: "30" } as unknown as NodeJS.ProcessEnv);
  assert.equal(o.enqueueCap, 50);
  assert.equal(o.maxAttempts, 3);
  assert.equal(o.staleAfterDays, 30);
});

// ---- freshness: which filings mark officer data dirty -----------------------------------------------
test("only count-changing officer filings (and incorporation) trigger a refresh", () => {
  for (const t of ["AP01", "AP02", "TM01", "LLAP01", "LLAP02", "LLTM01", "NEWINC", "LLIN01"]) assert.ok(isOfficerChangeFiling(t), t);
  // details-only changes, secretaries and unrelated filings leave the count alone
  for (const t of ["CH01", "CH02", "LLCH01", "AP03", "AP04", "TM02", "CS01", "AA", "DS01"]) assert.equal(isOfficerChangeFiling(t), false, t);
  assert.ok(OFFICER_CHANGE_FILING_TYPES.size >= 6 && INCORPORATION_FILING_TYPES.has("NEWINC"));
});
