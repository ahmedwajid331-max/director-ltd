import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { MEANINGFUL_ACTIONS } from "./actions";
import { REACHED_OUTCOMES } from "./contact";
import { dayKey } from "./periods";
import { SESSION_STATUS_LABEL, sessionStatus, sessionTimeInWindow, type SessionStatus } from "./sessions";

// Aggregations for the staff dashboards. Everything here is a bounded query over indexed staff-activity tables
// (ActivityLog by user + time, UserSession, ContactLog, Assignment) - never the Company table - and every figure is a
// count of RECORDED events. Nothing is estimated.

// "createdAt" columns are timestamp WITHOUT time zone holding UTC. A bare Date parameter would be compared using the
// database session's time zone, which silently shifts every boundary on a non-UTC server. Casting the parameter to a UTC
// wall-clock timestamp makes the comparison independent of server settings.
export const utcTs = (d: Date) => Prisma.sql`(${d}::timestamptz AT TIME ZONE 'UTC')`;

export interface UserPeriodStats {
  userId: string;
  sessions: number;
  sessionMs: number; // recorded session time (merged, clipped to the period) - NOT verified working time
  meaningfulActions: number;
  searches: number;
  companiesWorked: number; // distinct companies with at least one meaningful recorded action
  contactsLogged: number; // contact log entries (attempts included)
  contactsReached: number; // entries whose outcome means a person was reached
  followUpsCreated: number;
  followUpsDone: number;
  reportsCreated: number;
  exports: number;
  notesAdded: number;
  assignmentsCompleted: number; // completed inside the period
  failedLogins: number;
}

const zero = (userId: string): UserPeriodStats => ({
  userId,
  sessions: 0,
  sessionMs: 0,
  meaningfulActions: 0,
  searches: 0,
  companiesWorked: 0,
  contactsLogged: 0,
  contactsReached: 0,
  followUpsCreated: 0,
  followUpsDone: 0,
  reportsCreated: 0,
  exports: 0,
  notesAdded: 0,
  assignmentsCompleted: 0,
  failedLogins: 0,
});

export async function getPeriodStats(userIds: string[], from: Date, to: Date): Promise<Map<string, UserPeriodStats>> {
  const out = new Map(userIds.map((id) => [id, zero(id)]));
  if (userIds.length === 0) return out;
  const inWindow = { gte: from, lt: to };

  const [byAction, companies, contacts, sessions, completed] = await Promise.all([
    db.activityLog.groupBy({ by: ["userId", "action"], where: { userId: { in: userIds }, createdAt: inWindow }, _count: { _all: true } }),
    db.$queryRaw<{ userId: string; n: number }[]>(
      Prisma.sql`SELECT "userId", COUNT(DISTINCT "companyId")::int AS n FROM "ActivityLog"
        WHERE "userId" IN (${Prisma.join(userIds)}) AND "createdAt" >= ${utcTs(from)} AND "createdAt" < ${utcTs(to)}
          AND "companyId" IS NOT NULL AND "action" IN (${Prisma.join(MEANINGFUL_ACTIONS)})
        GROUP BY "userId"`
    ),
    db.contactLog.groupBy({ by: ["userId", "outcome"], where: { userId: { in: userIds }, createdAt: inWindow }, _count: { _all: true } }),
    db.userSession.findMany({
      where: { userId: { in: userIds }, startedAt: { lt: to }, OR: [{ endedAt: { gte: from } }, { endedAt: null, lastActivityAt: { gte: from } }] },
      select: { userId: true, startedAt: true, lastActivityAt: true, endedAt: true, endReason: true },
    }),
    db.assignment.groupBy({ by: ["assigneeId"], where: { assigneeId: { in: userIds }, status: "done", completedAt: inWindow }, _count: { _all: true } }),
  ]);

  const meaningful = new Set(MEANINGFUL_ACTIONS);
  for (const r of byAction) {
    const s = out.get(r.userId)!;
    const n = r._count._all;
    if (meaningful.has(r.action)) s.meaningfulActions += n;
    if (r.action === "search") s.searches += n;
    if (r.action === "followup_created") s.followUpsCreated += n;
    if (r.action === "followup_done") s.followUpsDone += n;
    if (r.action === "report_created") s.reportsCreated += n;
    if (r.action === "export_csv" || r.action === "export_pdf" || r.action === "export_docx") s.exports += n;
    if (r.action === "note_added") s.notesAdded += n;
    if (r.action === "login_failed") s.failedLogins += n;
  }
  for (const r of companies) out.get(r.userId)!.companiesWorked = r.n;
  for (const r of contacts) {
    const s = out.get(r.userId)!;
    s.contactsLogged += r._count._all;
    if ((REACHED_OUTCOMES as string[]).includes(r.outcome)) s.contactsReached += r._count._all;
  }
  const byUser = new Map<string, typeof sessions>();
  for (const s of sessions) (byUser.get(s.userId) ?? byUser.set(s.userId, []).get(s.userId)!).push(s);
  for (const [id, list] of byUser) {
    const s = out.get(id)!;
    s.sessions = list.length;
    s.sessionMs = sessionTimeInWindow(list, from, to);
  }
  for (const r of completed) out.get(r.assigneeId)!.assignmentsCompleted = r._count._all;
  return out;
}

export interface DailyPoint {
  day: string; // YYYY-MM-DD in the app timezone
  meaningfulActions: number;
  sessionMs: number;
}

// One point per calendar day of the period (zero-filled so a quiet day is visible as zero, not missing).
export async function getDailySeries(userIds: string[], days: string[], from: Date, to: Date, tz: string, startOfDayFn: (d: string) => Date): Promise<DailyPoint[]> {
  if (userIds.length === 0) return days.map((day) => ({ day, meaningfulActions: 0, sessionMs: 0 }));
  const [rows, sessions] = await Promise.all([
    db.$queryRaw<{ day: string; n: number }[]>(
      Prisma.sql`SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n FROM "ActivityLog"
        WHERE "userId" IN (${Prisma.join(userIds)}) AND "createdAt" >= ${utcTs(from)} AND "createdAt" < ${utcTs(to)} AND "action" IN (${Prisma.join(MEANINGFUL_ACTIONS)})
        GROUP BY 1`
    ),
    db.userSession.findMany({
      where: { userId: { in: userIds }, startedAt: { lt: to }, OR: [{ endedAt: { gte: from } }, { endedAt: null, lastActivityAt: { gte: from } }] },
      select: { userId: true, startedAt: true, lastActivityAt: true, endedAt: true, endReason: true },
    }),
  ]);
  const counts = new Map(rows.map((r) => [r.day, r.n]));
  // Session time per day, merged per person (a person on two devices is counted once), then summed across people.
  const perUser = new Map<string, typeof sessions>();
  for (const s of sessions) (perUser.get(s.userId) ?? perUser.set(s.userId, []).get(s.userId)!).push(s);
  return days.map((day, i) => {
    const a = startOfDayFn(day);
    const b = i + 1 < days.length ? startOfDayFn(days[i + 1]) : to;
    let ms = 0;
    for (const list of perUser.values()) ms += sessionTimeInWindow(list, a, b);
    return { day, meaningfulActions: counts.get(day) ?? 0, sessionMs: ms };
  });
}

// "untracked": the person has signed in (User.lastLoginAt is set) but no session was ever recorded for them - they signed in
// before session tracking existed. Distinct from "never", which means no sign-in at all.
export type PresenceStatus = SessionStatus | "never" | "untracked";

export const presenceLabel = (status: PresenceStatus) => (status === "never" ? "Never signed in" : status === "untracked" ? "No session recorded" : SESSION_STATUS_LABEL[status]);

export interface Presence {
  status: PresenceStatus;
  lastSeenAt: Date | null; // last time the session made any authenticated request
  sessionStartedAt: Date | null;
}

// Current standing of each user from their best session: an open one if any (most recently seen), else their latest
// ended one. "Recently active" etc. are derived from timestamps; none of it proves anyone is actually working.
export async function getPresence(userIds: string[], now = new Date()): Promise<Map<string, Presence>> {
  const out = new Map<string, Presence>(userIds.map((id) => [id, { status: "never", lastSeenAt: null, sessionStartedAt: null }]));
  if (userIds.length === 0) return out;
  const rows = await db.$queryRaw<{ userId: string; startedAt: Date; lastActivityAt: Date; endedAt: Date | null; endReason: string | null }[]>(
    Prisma.sql`SELECT DISTINCT ON ("userId") "userId", "startedAt", "lastActivityAt", "endedAt", "endReason" FROM "UserSession"
      WHERE "userId" IN (${Prisma.join(userIds)})
      ORDER BY "userId", ("endedAt" IS NULL) DESC, "lastActivityAt" DESC`
  );
  for (const r of rows) out.set(r.userId, { status: sessionStatus(r, now), lastSeenAt: r.lastActivityAt, sessionStartedAt: r.startedAt });
  const without = userIds.filter((id) => out.get(id)!.status === "never");
  if (without.length) {
    const signedIn = await db.user.findMany({ where: { id: { in: without }, lastLoginAt: { not: null } }, select: { id: true } });
    for (const u of signedIn) out.set(u.id, { status: "untracked", lastSeenAt: null, sessionStartedAt: null });
  }
  return out;
}

export async function getLastRecordedActions(userIds: string[]): Promise<Map<string, Date>> {
  if (userIds.length === 0) return new Map();
  const rows = await db.activityLog.groupBy({ by: ["userId"], where: { userId: { in: userIds }, action: { notIn: ["login", "logout", "login_failed"] } }, _max: { createdAt: true } });
  return new Map(rows.flatMap((r) => (r._max.createdAt ? [[r.userId, r._max.createdAt] as const] : [])));
}

export interface WorkQueueCounts {
  open: number;
  overdue: number; // open and past their due date today (app timezone)
  done: number;
}

export async function getWorkQueueCounts(userIds: string[], tz: string): Promise<Map<string, WorkQueueCounts>> {
  const out = new Map<string, WorkQueueCounts>(userIds.map((id) => [id, { open: 0, overdue: 0, done: 0 }]));
  if (userIds.length === 0) return out;
  const today = new Date(`${dayKey(new Date(), tz)}T00:00:00.000Z`);
  const [grouped, overdue] = await Promise.all([
    db.assignment.groupBy({ by: ["assigneeId", "status"], where: { assigneeId: { in: userIds } }, _count: { _all: true } }),
    db.assignment.groupBy({ by: ["assigneeId"], where: { assigneeId: { in: userIds }, status: "open", dueDate: { lt: today } }, _count: { _all: true } }),
  ]);
  for (const g of grouped) {
    const w = out.get(g.assigneeId)!;
    if (g.status === "open") w.open = g._count._all;
    if (g.status === "done") w.done = g._count._all;
  }
  for (const g of overdue) out.get(g.assigneeId)!.overdue = g._count._all;
  return out;
}
