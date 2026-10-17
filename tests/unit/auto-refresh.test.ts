import { test } from "node:test";
import assert from "node:assert/strict";
import { autoRefreshState, autoRefreshText } from "../../src/lib/reports/autoRefresh";

const fmt = (d: Date | string) => `<${new Date(d).toISOString().slice(0, 10)}>`;

test("auto-refresh state: OFF is never an old date, ON without a record says so, a record shows its own date", () => {
  assert.deepEqual(autoRefreshState({ dailyRefresh: false, lastAutoRefreshAt: null }), { kind: "not_scheduled" });
  assert.deepEqual(autoRefreshState({ dailyRefresh: false, lastAutoRefreshAt: new Date("2026-10-01") }), { kind: "not_scheduled" }, "turned off: the old date is not shown as current");
  assert.deepEqual(autoRefreshState({ dailyRefresh: true, lastAutoRefreshAt: null }), { kind: "not_yet" });
  assert.deepEqual(autoRefreshState({ dailyRefresh: true, lastAutoRefreshAt: undefined }), { kind: "not_yet" });
  const at = new Date("2026-10-07T05:16:57Z");
  assert.deepEqual(autoRefreshState({ dailyRefresh: true, lastAutoRefreshAt: at }), { kind: "at", at });
});

test("auto-refresh text", () => {
  assert.equal(autoRefreshText({ kind: "not_scheduled" }, fmt), "Not scheduled");
  assert.equal(autoRefreshText({ kind: "not_yet" }, fmt), "Not yet updated");
  assert.equal(autoRefreshText({ kind: "at", at: "2026-10-07T05:16:57Z" }, fmt), "<2026-10-07>");
});
