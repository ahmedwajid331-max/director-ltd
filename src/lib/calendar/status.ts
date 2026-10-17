export type CalendarStatus = "done" | "overdue" | "upcoming";

// One rule for every calendar entry (follow-up or assigned work). Entries are date-only, so this compares plain
// "YYYY-MM-DD" strings: a due date earlier than today is overdue, today or later is upcoming, and anything completed is
// done whatever its date. `todayKey` is today's date in the APPLICATION time zone (the same "today" the My work page uses),
// never the viewer's browser clock, so every screen agrees about what is overdue.
export function calendarStatus(item: { dueDate: string; done: boolean }, todayKey: string): CalendarStatus {
  if (item.done) return "done";
  return item.dueDate.slice(0, 10) < todayKey ? "overdue" : "upcoming";
}
