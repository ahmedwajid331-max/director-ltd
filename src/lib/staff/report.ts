import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { SessionPayload } from "@/lib/auth/session";
import { userScopeWhere } from "./scope";
import { getDailySeries, getPeriodStats, getPresence, type DailyPoint, type Presence, type UserPeriodStats } from "./stats";
import { startOfDay, type ResolvedPeriod } from "./periods";

// One loader behind both the Activity & reports page and its CSV download, so the screen and the file can never disagree
// and both apply the same scope (a supervisor only ever gets their own team).

export interface StaffReportRow {
  user: { id: string; name: string; email: string; role: string; active: boolean };
  stats: UserPeriodStats;
  presence: Presence;
}

export type Totals = Omit<UserPeriodStats, "userId">;

export interface StaffReport {
  rows: StaffReportRow[];
  totals: Totals;
  previousTotals: Totals | null;
  series: DailyPoint[];
  signedInNow: number;
  truncated: boolean; // true only when the scope exceeds MAX_PEOPLE
}

// Totals, the chart and the CSV always cover EVERYONE in scope, up to MAX_PEOPLE; beyond that the report is refused rather
// than silently covering only some people. The screen lists the SCREEN_ROWS most active people and says how many there are.
export const SCREEN_ROWS = 200;
export const MAX_PEOPLE = 5_000;
const KEYS: (keyof Totals)[] = [
  "sessions", "sessionMs", "meaningfulActions", "searches", "companiesWorked", "contactsLogged", "contactsReached", "followUpsCreated", "followUpsDone", "reportsCreated", "exports", "notesAdded", "assignmentsCompleted", "failedLogins",
];

export function sumStats(list: UserPeriodStats[]): Totals {
  const t = Object.fromEntries(KEYS.map((k) => [k, 0])) as Totals;
  for (const s of list) for (const k of KEYS) t[k] += s[k];
  return t;
}

export async function loadStaffReport(
  session: SessionPayload,
  period: ResolvedPeriod,
  filter: { staffId?: string; role?: string; teamId?: string } = {}
): Promise<StaffReport> {
  const where: Prisma.UserWhereInput = {
    AND: [
      userScopeWhere(session),
      ...(filter.staffId ? [{ id: filter.staffId }] : []),
      ...(filter.role ? [{ role: filter.role }] : []),
      ...(filter.teamId ? [{ managerId: filter.teamId }] : []),
    ],
  };
  const found = await db.user.findMany({ where, orderBy: { name: "asc" }, take: MAX_PEOPLE + 1, select: { id: true, name: true, email: true, role: true, active: true } });
  const users = found.slice(0, MAX_PEOPLE);
  const ids = users.map((u) => u.id);

  const [stats, prev, presence, series] = await Promise.all([
    getPeriodStats(ids, period.from, period.to),
    period.previous ? getPeriodStats(ids, period.previous.from, period.previous.to) : null,
    getPresence(ids),
    getDailySeries(ids, period.days, period.from, period.to, period.tz, (d) => startOfDay(d, period.tz)),
  ]);

  const rows = users.map((user) => ({ user, stats: stats.get(user.id)!, presence: presence.get(user.id)! }));
  rows.sort((a, b) => b.stats.meaningfulActions - a.stats.meaningfulActions || a.user.name.localeCompare(b.user.name));
  return {
    rows,
    totals: sumStats(rows.map((r) => r.stats)),
    previousTotals: prev ? sumStats([...prev.values()]) : null,
    series,
    signedInNow: rows.filter((r) => r.user.active && (r.presence.status === "active" || r.presence.status === "idle")).length,
    truncated: found.length > MAX_PEOPLE, // more people than the hard cap
  };
}
