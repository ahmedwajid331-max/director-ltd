/* eslint-disable @typescript-eslint/no-explicit-any -- filter fixtures are loosely typed */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePeriod, startOfDay, dayKey, addDays } from "../../src/lib/staff/periods";
import { payAmountMinor, parseRateToMinor, formatMoney } from "../../src/lib/staff/money";
import { sessionStatus, sessionDurationMs, sessionTimeInWindow, formatDuration } from "../../src/lib/staff/sessions";
import { resolvePermissions, validatePermissionList, NEW_ACCOUNT_DEFAULT, can, LEGACY_USER_PERMISSIONS } from "../../src/lib/auth/permissions";
import { usesAdvancedLogic, filterAccessProblem, redactDirectorFields } from "../../src/lib/auth/access";
import { describeAction, isMeaningful, actionCategory } from "../../src/lib/staff/actions";

const TZ = "Europe/London";
const d = (s: string) => new Date(s);

test("periods: week is Monday-Sunday in the app timezone and half-open", () => {
  const r = resolvePeriod({ kind: "week", anchor: "2026-10-10" }, d("2026-10-10T12:00:00Z"), TZ); // Saturday
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.period.fromDay, "2026-10-05");
  assert.equal(r.period.toDay, "2026-10-11");
  assert.equal(r.period.days.length, 7);
  assert.equal(r.period.previous?.from.toISOString(), startOfDay("2026-09-28", TZ).toISOString());
});

test("periods: day boundaries follow the timezone, including the clock change", () => {
  // BST (UTC+1) in summer: local midnight is 23:00 UTC the day before.
  assert.equal(startOfDay("2026-07-01", TZ).toISOString(), "2026-06-30T23:00:00.000Z");
  assert.equal(startOfDay("2026-12-01", TZ).toISOString(), "2026-12-01T00:00:00.000Z");
  // 2026-10-25 is the day the clocks go back: 25 hours long.
  const day = resolvePeriod({ kind: "day", anchor: "2026-10-25" }, d("2026-10-30T00:00:00Z"), TZ);
  assert.ok(day.ok);
  if (day.ok) assert.equal((day.period.to.getTime() - day.period.from.getTime()) / 3_600_000, 25);
  // An event at 23:30 UTC on 30 Jun is already 1 July locally.
  assert.equal(dayKey(d("2026-06-30T23:30:00Z"), TZ), "2026-07-01");
  assert.equal(dayKey(d("2026-06-30T22:59:00Z"), TZ), "2026-06-30");
});

test("periods: month, year, custom, and invalid input", () => {
  const m = resolvePeriod({ kind: "month", anchor: "2026-02-14" }, d("2026-10-10T00:00:00Z"), TZ);
  assert.ok(m.ok);
  if (m.ok) {
    assert.equal(m.period.days.length, 28);
    assert.equal(m.period.previous && m.period.previous.to.getTime(), m.period.from.getTime());
  }
  const y = resolvePeriod({ kind: "year", anchor: "2028-05-01" }, d("2026-10-10T00:00:00Z"), TZ);
  assert.ok(y.ok);
  if (y.ok) assert.equal(y.period.days.length, 366); // leap year
  const c = resolvePeriod({ kind: "custom", from: "2026-10-01", to: "2026-10-03" }, d("2026-10-10T00:00:00Z"), TZ);
  assert.ok(c.ok);
  if (c.ok) {
    assert.equal(c.period.days.length, 3);
    assert.equal(c.period.previous?.to.getTime(), c.period.from.getTime());
  }
  assert.equal(resolvePeriod({ kind: "custom", from: "2026-10-05", to: "2026-10-01" }).ok, false);
  assert.equal(resolvePeriod({ kind: "custom", from: "2024-01-01", to: "2026-10-01" }).ok, false);
  assert.equal(resolvePeriod({ kind: "day", anchor: "2026-02-30" }).ok, false);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("money: integer pay maths and rate parsing", () => {
  assert.equal(payAmountMinor(600, 2000), 20000); // 10 h at 20.00 = 200.00
  assert.equal(payAmountMinor(90, 2000), 3000);
  assert.equal(payAmountMinor(1, 2000), 33); // 0.3333 -> 33p
  assert.equal(payAmountMinor(0, 2000), 0);
  assert.throws(() => payAmountMinor(1.5, 2000));
  assert.equal(parseRateToMinor("20"), 2000);
  assert.equal(parseRateToMinor("20.5"), 2050);
  assert.equal(parseRateToMinor("20.05"), 2005);
  assert.equal(parseRateToMinor("20.555"), null);
  assert.equal(parseRateToMinor("-3"), null);
  assert.equal(parseRateToMinor("abc"), null);
  assert.equal(formatMoney(2050, "GBP"), "£20.50");
});

test("sessions: status, duration and missing-logout handling", () => {
  const t = { activeMs: 5 * 60_000, idleMs: 30 * 60_000 };
  const start = d("2026-10-10T09:00:00Z");
  const now = d("2026-10-10T12:00:00Z");
  assert.equal(sessionStatus({ startedAt: start, lastActivityAt: d("2026-10-10T11:58:00Z"), endedAt: null }, now, t), "active");
  assert.equal(sessionStatus({ startedAt: start, lastActivityAt: d("2026-10-10T11:40:00Z"), endedAt: null }, now, t), "idle");
  assert.equal(sessionStatus({ startedAt: start, lastActivityAt: d("2026-10-10T10:00:00Z"), endedAt: null }, now, t), "unresolved");
  assert.equal(sessionStatus({ startedAt: start, lastActivityAt: d("2026-10-10T10:00:00Z"), endedAt: d("2026-10-10T10:05:00Z") }, now, t), "ended");
  assert.equal(sessionStatus({ startedAt: d("2026-09-01T09:00:00Z"), lastActivityAt: d("2026-09-01T09:10:00Z"), endedAt: null }, now, t), "expired");
  // No logout: duration stops at the last activity - it is never extended to "now".
  assert.equal(sessionDurationMs({ startedAt: start, lastActivityAt: d("2026-10-10T10:00:00Z"), endedAt: null }), 3_600_000);
  assert.equal(sessionDurationMs({ startedAt: start, lastActivityAt: d("2026-10-10T10:00:00Z"), endedAt: d("2026-10-10T10:30:00Z") }), 5_400_000);
  assert.equal(sessionDurationMs({ startedAt: start, lastActivityAt: d("2026-10-10T08:00:00Z"), endedAt: null }), 0);
  assert.equal(formatDuration(3_600_000 + 5 * 60_000), "1h 05m");
  assert.equal(formatDuration(10_000), "< 1 min");
});

test("sessions: window clipping splits across midnight and merges overlapping sessions", () => {
  const day1 = [d("2026-10-10T00:00:00Z"), d("2026-10-11T00:00:00Z")] as const;
  const day2 = [d("2026-10-11T00:00:00Z"), d("2026-10-12T00:00:00Z")] as const;
  const overnight = { startedAt: d("2026-10-10T23:00:00Z"), lastActivityAt: d("2026-10-11T01:00:00Z"), endedAt: d("2026-10-11T01:00:00Z") };
  assert.equal(sessionTimeInWindow([overnight], ...day1), 3_600_000);
  assert.equal(sessionTimeInWindow([overnight], ...day2), 3_600_000);
  const a = { startedAt: d("2026-10-10T09:00:00Z"), lastActivityAt: d("2026-10-10T11:00:00Z"), endedAt: null };
  const b = { startedAt: d("2026-10-10T10:00:00Z"), lastActivityAt: d("2026-10-10T12:00:00Z"), endedAt: null };
  assert.equal(sessionTimeInWindow([a, b], ...day1), 3 * 3_600_000, "two browsers at once are not double counted");
  assert.equal(sessionTimeInWindow([], ...day1), 0);
});

test("permissions: defaults, legacy behaviour, implications and validation", () => {
  assert.deepEqual(resolvePermissions("USER", null), LEGACY_USER_PERMISSIONS);
  assert.ok(!resolvePermissions("USER", null).includes("reports.viewOthers"));
  assert.ok(resolvePermissions("ADMIN", null).includes("staff.view"));
  assert.equal(resolvePermissions("SUPER_ADMIN", JSON.stringify([])).length > 15, true, "super admin cannot be restricted");
  const p = resolvePermissions("USER", JSON.stringify(["reports.exportCsv"]));
  assert.deepEqual(p, ["reports.viewOwn", "reports.exportCsv"], "export implies being able to view reports");
  assert.deepEqual(resolvePermissions("USER", "not json"), LEGACY_USER_PERMISSIONS, "unreadable value falls back safely");
  assert.ok(!NEW_ACCOUNT_DEFAULT.includes("reports.exportCsv" as never) && !NEW_ACCOUNT_DEFAULT.includes("companies.directors" as never), "new accounts are least-privilege");
  assert.equal(validatePermissionList(["nope"], "USER").ok, false);
  assert.equal(validatePermissionList(["staff.manage"], "USER").ok, false);
  assert.equal(validatePermissionList(["staff.manage"], "ADMIN").ok, true);
  assert.equal(validatePermissionList("x", "USER").ok, false);
  assert.equal(can({ role: "USER", permissions: ["companies.view"] }, "companies.view"), true);
  assert.equal(can({ role: "USER", permissions: [] }, "companies.view"), false);
  assert.equal(can(null, "companies.view"), false);
});

test("access: advanced-logic detection, director gating and redaction", () => {
  const status = (v: string): any => ({ id: "r" + v, kind: "rule", field: "status", operator: "equals", value: v });
  const dormant: any = { id: "d", kind: "rule", field: "dormant", operator: "isTrue" };
  const directors: any = { id: "n", kind: "rule", field: "directorCount", operator: "gte", value: 2 };
  const grp = (combinator: "AND" | "OR", ...children: any[]): any => ({ id: "g", kind: "group", combinator, children });
  assert.equal(usesAdvancedLogic(grp("AND", status("active"), dormant)), false);
  assert.equal(usesAdvancedLogic(grp("AND", grp("OR", status("active"), status("dissolved")), dormant)), false, "one field multi-select is basic");
  assert.equal(usesAdvancedLogic(grp("OR", status("active"), dormant)), true, "ANY across conditions");
  assert.equal(usesAdvancedLogic(grp("OR", status("active"))), false, "ANY with one condition is the same as ALL");
  assert.equal(usesAdvancedLogic(grp("AND", grp("OR", status("active"), dormant))), true);
  assert.equal(usesAdvancedLogic(grp("AND", grp("AND", grp("OR", status("active"), status("dissolved"))))), true);
  const basic = { role: "USER" as const, permissions: ["companies.view"] };
  assert.equal(filterAccessProblem(basic, grp("OR", status("active"), dormant))?.permission, "companies.advancedSearch");
  assert.equal(filterAccessProblem(basic, grp("AND", directors))?.permission, "companies.directors");
  assert.equal(filterAccessProblem(basic, grp("AND", status("active"), dormant)), null);
  assert.equal(filterAccessProblem(basic, grp("AND", status("not-a-status"))), null, "invalid filters are left to the query builder to reject");
  assert.equal(filterAccessProblem({ role: "SUPER_ADMIN", permissions: [] }, grp("OR", status("active"), dormant)), null);
  const red = redactDirectorFields({ id: "1", name: "A", directorCount: 3, singleDirector: true, officersCoverage: "full", officerFreshness: "fresh" });
  assert.deepEqual(red, { id: "1", name: "A", directorCount: null, singleDirector: null, officersCoverage: "none", officerFreshness: "none" });
});

test("actions: feed labels are readable and meaningful-work flags exclude sign-ins", () => {
  assert.equal(describeAction("export_pdf", JSON.stringify({ rows: 12 })), "Downloaded a PDF report (12 companies)");
  assert.equal(describeAction("contact_logged", JSON.stringify({ channel: "call", outcome: "no_answer" })), "Logged a call (no answer)");
  assert.equal(describeAction("something_new", null), "something new");
  assert.equal(describeAction("note_added", "{broken"), "Added a note");
  assert.equal(isMeaningful("login"), false);
  assert.equal(isMeaningful("note_added"), true);
  assert.equal(actionCategory("logout"), "security");
});

// ---------------------------------------------------------------- session timing (the "Abid" case) and payroll
import { quietBeforeSignOutMs, sessionEvidenceEnd } from "../../src/lib/staff/sessions";
import { evidenceWarnings, payLines, totalsByCurrency, canResubmit } from "../../src/lib/staff/timesheet";

test("sessions: a session left open for hours reads as elapsed time with a visible silent gap (Abid, 11 Oct)", () => {
  // Real dev-DB shape: signed in 05:26:53Z, last request 05:30:18Z (report viewed), explicit sign-out 09:46:01Z.
  const s = { startedAt: d("2026-10-11T05:26:53Z"), lastActivityAt: d("2026-10-11T05:30:18Z"), endedAt: d("2026-10-11T09:46:01Z"), endReason: "logout" };
  assert.equal(formatDuration(sessionDurationMs(s)), "4h 19m", "elapsed session time reproduces the 4h 19m shown");
  assert.equal(formatDuration(quietBeforeSignOutMs(s)!), "4h 16m", "...of which 4h 16m had nothing recorded");
  assert.equal(sessionEvidenceEnd(s).toISOString(), "2026-10-11T09:46:01.000Z");
});

test("sessions: an administrator revoking an abandoned session does not add the hours since the person left", () => {
  const s = { startedAt: d("2026-10-11T09:00:00Z"), lastActivityAt: d("2026-10-11T09:20:00Z"), endedAt: d("2026-10-11T15:00:00Z"), endReason: "admin_ended" };
  assert.equal(sessionDurationMs(s), 20 * 60_000);
  assert.equal(quietBeforeSignOutMs(s), null);
  assert.equal(sessionTimeInWindow([s], d("2026-10-11T00:00:00Z"), d("2026-10-12T00:00:00Z")), 20 * 60_000);
  // An open session never gets an invented end.
  const open = { startedAt: d("2026-10-11T09:00:00Z"), lastActivityAt: d("2026-10-11T09:20:00Z"), endedAt: null };
  assert.equal(sessionEvidenceEnd(open).toISOString(), "2026-10-11T09:20:00.000Z");
  assert.equal(quietBeforeSignOutMs(open), null);
  // Legacy rows with no end reason are treated as the person's own sign-out.
  assert.equal(sessionDurationMs({ startedAt: d("2026-10-11T09:00:00Z"), lastActivityAt: d("2026-10-11T09:20:00Z"), endedAt: d("2026-10-11T10:00:00Z") }), 3_600_000);
});

test("payroll: only approved hours are priced; GBP 20 x 10h = GBP 200", () => {
  const lines = payLines([
    { userId: "a", status: "approved", approvedMinutes: 600, rateMinorAtApproval: 2000, rateCurrencyAtApproval: "GBP" },
    { userId: "a", status: "submitted", approvedMinutes: null, rateMinorAtApproval: null, rateCurrencyAtApproval: null },
    { userId: "a", status: "rejected", approvedMinutes: 480, rateMinorAtApproval: 2000, rateCurrencyAtApproval: "GBP" },
    { userId: "a", status: "returned", approvedMinutes: 480, rateMinorAtApproval: 2000, rateCurrencyAtApproval: "GBP" },
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].approvedMinutes, 600);
  assert.equal(lines[0].amountMinor, 20000);
  assert.equal(formatMoney(lines[0].amountMinor!, "GBP"), "£200.00");
});

test("payroll: zero hours, fractional hours, rate change, mixed currencies and unrated hours", () => {
  assert.deepEqual(payLines([]), []);
  assert.deepEqual(totalsByCurrency([]), { byCurrency: [], unratedMinutes: 0 });
  const approved = (userId: string, m: number, rate: number | null, cur: string | null) => ({ userId, status: "approved", approvedMinutes: m, rateMinorAtApproval: rate, rateCurrencyAtApproval: cur });
  // 1.5 hours at 20.00 = 30.00; a mid-period rise to 25.00 prices only the later hours at the new rate.
  const lines = payLines([approved("a", 90, 2000, "GBP"), approved("a", 60, 2500, "GBP"), approved("a", 30, 2000, "GBP"), approved("b", 120, 1500, "USD"), approved("c", 60, null, null)]);
  const a = lines.filter((l) => l.userId === "a");
  assert.equal(a.length, 2);
  assert.equal(a.find((l) => l.rateMinor === 2000)!.approvedMinutes, 120);
  assert.equal(a.find((l) => l.rateMinor === 2000)!.amountMinor, 4000);
  assert.equal(a.find((l) => l.rateMinor === 2500)!.amountMinor, 2500);
  const t = totalsByCurrency(lines);
  assert.deepEqual(t.byCurrency, [
    { currency: "GBP", approvedMinutes: 180, amountMinor: 6500 },
    { currency: "USD", approvedMinutes: 120, amountMinor: 3000 },
  ]);
  assert.equal(t.unratedMinutes, 60, "approved hours with no rate are reported, not priced at zero");
  assert.equal(payAmountMinor(0, 2000), 0);
  assert.equal(payAmountMinor(7, 2000), 233, "no floating-point drift: 7 min at 20.00 = 2.33");
});

test("timesheets: evidence warnings flag disagreement without deciding anything; resubmission rules", () => {
  assert.deepEqual(evidenceWarnings({ claimedMinutes: 480, sessionMs: 8 * 3_600_000, recordedActions: 12 }), []);
  assert.deepEqual(evidenceWarnings({ claimedMinutes: 480, sessionMs: 0, recordedActions: 0 }), ["No session recorded that day", "No recorded actions that day"]);
  assert.deepEqual(evidenceWarnings({ claimedMinutes: 480, sessionMs: 3_600_000, recordedActions: 3 }), ["Session time is well below the claim"]);
  assert.ok(canResubmit("rejected") && canResubmit("returned") && canResubmit("submitted"));
  assert.ok(!canResubmit("approved"));
});

// ---------------------------------------------------------------- company data states (status detail, stream events)
import { statusDetailState } from "../../src/lib/columns/cellRules";
import { parseFilingEvent } from "../../src/lib/companies-house/filingEvents";

test("status detail: an empty value means 'not fetched' unless the profile was fetched from Companies House", () => {
  assert.equal(statusDetailState("bulk_import"), "not_fetched");
  assert.equal(statusDetailState("advanced_search"), "not_fetched");
  assert.equal(statusDetailState("seed"), "not_fetched");
  assert.equal(statusDetailState(null), "not_fetched");
  assert.equal(statusDetailState("stream"), "none_recorded");
  assert.equal(statusDetailState("rest_enrichment"), "none_recorded");
});

test("stream events: a non-integer timepoint is treated as absent instead of crashing storage", () => {
  const ev = (timepoint: unknown) => ({ resource_uri: "/company/01234567/filing-history/tx1", data: { transaction_id: "tx1", type: "DS01" }, event: { timepoint } });
  assert.equal(parseFilingEvent(ev(123))!.timepoint, 123);
  assert.equal(parseFilingEvent(ev(1.5))!.timepoint, null);
  assert.equal(parseFilingEvent(ev(Number.NaN))!.timepoint, null);
  assert.equal(parseFilingEvent(ev(1e300))!.timepoint, null);
  assert.equal(parseFilingEvent(ev("7"))!.timepoint, null);
});

import { profileFetchedAt, accountsState } from "../../src/lib/columns/cellRules";

test("profile fetched: the bulk import date is never shown as a profile fetch", () => {
  const t = new Date("2026-10-06T17:00:00Z");
  assert.equal(profileFetchedAt("bulk_import", t), null);
  assert.equal(profileFetchedAt("seed", t), null);
  assert.equal(profileFetchedAt(null, t), null);
  assert.equal(profileFetchedAt("stream", t), t);
  assert.equal(profileFetchedAt("rest_enrichment", t), t);
  assert.equal(profileFetchedAt("advanced_search", t), t);
  assert.equal(profileFetchedAt("stream", null), null);
});

test("accounts: nothing filed is a known state; filed-without-a-type is a genuine gap", () => {
  assert.equal(accountsState("micro-entity", "2025-03-31"), "has_type");
  assert.equal(accountsState(null, null), "no_accounts");
  assert.equal(accountsState(null, "2025-03-31"), "type_missing");
});

import { restartDelayMs } from "../../src/lib/companies-house/officerWorker";

test("officer worker supervision: an idle or failing worker is not restarted every minute", () => {
  assert.equal(restartDelayMs("runtime"), 0, "time limit with work left: carry straight on");
  assert.equal(restartDelayMs("limit"), 0);
  assert.ok(restartDelayMs("idle") >= 10 * 60_000, "nothing to do: wait out the freshness interval");
  assert.ok(restartDelayMs("auth_breaker") >= 15 * 60_000, "rejected key: do not hammer Companies House");
  assert.ok(restartDelayMs("no_credentials") >= 15 * 60_000);
  assert.ok(restartDelayMs("error") >= 5 * 60_000);
  assert.ok(restartDelayMs("already_running") > 0);
});

import { isIdleWithBacklog } from "../../src/lib/companies-house/officerStatus";

test("pipeline health: waiting work with no worker is not 'healthy' just because the last run succeeded", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const old = new Date("2026-10-05T13:34:00Z");
  assert.equal(isIdleWithBacklog(15, false, old, now), true, "15 queued, nothing running, last run 6 days ago");
  assert.equal(isIdleWithBacklog(0, false, old, now), false, "nothing waiting");
  assert.equal(isIdleWithBacklog(15, true, old, now), false, "a worker is running now");
  assert.equal(isIdleWithBacklog(15, false, new Date("2026-10-11T08:00:00Z"), now), false, "ran a few hours ago");
  assert.equal(isIdleWithBacklog(15, false, null, now), true, "never ran");
});
