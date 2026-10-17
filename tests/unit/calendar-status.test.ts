import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarStatus } from "../../src/lib/calendar/status";
import { appTimezone, dayKey } from "../../src/lib/staff/periods";

test("a due date before today is overdue, today and later are upcoming, completed is always done", () => {
  const today = "2026-10-12";
  assert.equal(calendarStatus({ dueDate: "2026-10-11T00:00:00.000Z", done: false }, today), "overdue");
  assert.equal(calendarStatus({ dueDate: "2026-10-12T00:00:00.000Z", done: false }, today), "upcoming", "due today is not overdue yet");
  assert.equal(calendarStatus({ dueDate: "2026-10-13", done: false }, today), "upcoming");
  assert.equal(calendarStatus({ dueDate: "2020-01-01T00:00:00.000Z", done: true }, today), "done", "completed beats overdue");
  assert.equal(calendarStatus({ dueDate: "2099-01-01", done: true }, today), "done");
});

test("month and year boundaries compare as dates, not as text with different widths", () => {
  assert.equal(calendarStatus({ dueDate: "2026-09-30", done: false }, "2026-10-01"), "overdue");
  assert.equal(calendarStatus({ dueDate: "2025-12-31", done: false }, "2026-01-01"), "overdue");
  assert.equal(calendarStatus({ dueDate: "2026-01-01", done: false }, "2025-12-31"), "upcoming");
});

test("'today' is the application-time-zone day: just after UK midnight in summer it is already the next day", () => {
  const tz = "Europe/London";
  const justAfterMidnightBst = new Date("2026-07-01T23:30:00Z"); // 00:30 on 2 July in London
  assert.equal(dayKey(justAfterMidnightBst, tz), "2026-07-02");
  // a follow-up due 1 July is overdue then; a server using the UTC day (1 July) would have wrongly called it upcoming
  assert.equal(calendarStatus({ dueDate: "2026-07-01", done: false }, dayKey(justAfterMidnightBst, tz)), "overdue");
  assert.equal(calendarStatus({ dueDate: "2026-07-01", done: false }, justAfterMidnightBst.toISOString().slice(0, 10)), "upcoming");
  assert.ok(appTimezone().length > 0);
});
