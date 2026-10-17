import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveStatus, RECONCILED_MESSAGE } from "../../src/lib/jobs/runs";

const now = new Date("2026-10-07T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

test("a run reconciled as failed but heartbeating since is shown as running", () => {
  const run = { kind: "stream", status: "failed", errorMessage: RECONCILED_MESSAGE, finishedAt: ago(3_600_000), heartbeatAt: ago(20_000) };
  assert.equal(effectiveStatus(run, now), "running");
});

test("a reconciled run whose heartbeat has stopped stays failed", () => {
  const run = { kind: "stream", status: "failed", errorMessage: RECONCILED_MESSAGE, finishedAt: ago(3_600_000), heartbeatAt: ago(3_700_000) };
  assert.equal(effectiveStatus(run, now), "failed");
  const stale = { kind: "stream", status: "failed", errorMessage: RECONCILED_MESSAGE, finishedAt: ago(7_200_000), heartbeatAt: ago(3_600_000) };
  assert.equal(effectiveStatus(stale, now), "failed");
});

test("a genuine failure (different error) is never reinterpreted", () => {
  const run = { kind: "stream", status: "failed", errorMessage: "ECONNREFUSED", finishedAt: ago(60_000), heartbeatAt: ago(10_000) };
  assert.equal(effectiveStatus(run, now), "failed");
});
