// Session status and duration rules. Pure functions, unit-tested.
//
// What is and is NOT claimed:
//  - "ended" only when an explicit logout (or admin action) wrote endedAt. We never invent a logout time.
//  - A browser closed without logging out leaves endedAt NULL; once the user has been quiet longer than the idle window
//    the session is "unresolved": signed in as far as the cookie goes, but no evidence anyone is there.
//  - A session is "expired" once the cookie's lifetime has passed.
//  - Duration is the span the evidence supports: to the person's own logout if there was one, otherwise to the last recorded
//    activity (including when an administrator revoked the session).
//    It is session time, NOT verified working time.

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // cookie lifetime
export const SESSION_TOUCH_INTERVAL_MS = 60_000; // lastActivityAt is written at most once a minute

function minutes(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface SessionThresholds {
  activeMs: number; // seen within this long: "Recently active"
  idleMs: number; // seen within this long: "Idle"; beyond it: "Unresolved"
}

// Configurable (SESSION_ACTIVE_MINUTES / SESSION_IDLE_MINUTES); defaults 5 and 30 minutes.
export function sessionThresholds(): SessionThresholds {
  return { activeMs: minutes("SESSION_ACTIVE_MINUTES", 5) * 60_000, idleMs: minutes("SESSION_IDLE_MINUTES", 30) * 60_000 };
}

export type SessionStatus = "active" | "idle" | "unresolved" | "ended" | "expired";

export interface SessionTimes {
  startedAt: Date;
  lastActivityAt: Date;
  endedAt: Date | null;
  // Why endedAt was written. "logout" (or legacy null) = the person signed out. "admin_ended" / "deactivated" = an
  // administrator or system revoked the session: endedAt is when it was revoked, NOT when the person stopped.
  endReason?: string | null;
}

// A sign-out the person made themselves is the only end time that says anything about when they left.
const isSelfSignOut = (s: SessionTimes) => !s.endReason || s.endReason === "logout";

// The last instant the evidence supports for this session: the person's own sign-out, else the last time they were seen.
// A session revoked by an administrator is measured to its last-seen time, so revoking an abandoned session hours later
// does not add those hours.
export function sessionEvidenceEnd(s: SessionTimes): Date {
  return s.endedAt && isSelfSignOut(s) ? s.endedAt : s.lastActivityAt;
}

// Time between the last recorded contact and a self-made sign-out: how long the session sat open with nothing recorded.
// Null when it is not knowable (no sign-out, or the end was an administrator's action).
export function quietBeforeSignOutMs(s: SessionTimes): number | null {
  if (!s.endedAt || !isSelfSignOut(s)) return null;
  return Math.max(0, s.endedAt.getTime() - s.lastActivityAt.getTime());
}

export function sessionStatus(s: SessionTimes, now: Date, t: SessionThresholds = sessionThresholds()): SessionStatus {
  if (s.endedAt) return "ended";
  if (now.getTime() - s.startedAt.getTime() > SESSION_MAX_AGE_SECONDS * 1000) return "expired";
  const quiet = now.getTime() - s.lastActivityAt.getTime();
  if (quiet <= t.activeMs) return "active";
  if (quiet <= t.idleMs) return "idle";
  return "unresolved";
}

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  active: "Recently active",
  idle: "Idle",
  unresolved: "No logout recorded",
  ended: "Signed out",
  expired: "Session expired",
};

// Milliseconds of evidence for this session: start -> logout, else start -> last activity. Never negative.
export function sessionDurationMs(s: SessionTimes): number {
  return Math.max(0, sessionEvidenceEnd(s).getTime() - s.startedAt.getTime());
}

export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return "< 1 min";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

// Sum of session time inside [from, to): each session is clipped to the window so a session spanning midnight is split
// across the two days it touched, and overlapping sessions (two browsers) are merged so time is not counted twice.
export function sessionTimeInWindow(sessions: SessionTimes[], from: Date, to: Date): number {
  const spans = sessions
    .map((s) => {
      const start = Math.max(s.startedAt.getTime(), from.getTime());
      const end = Math.min(sessionEvidenceEnd(s).getTime(), to.getTime());
      return end > start ? ([start, end] as const) : null;
    })
    .filter((x): x is readonly [number, number] => !!x)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [a, b] of spans) {
    if (curEnd < 0 || a > curEnd) {
      if (curEnd >= 0) total += curEnd - curStart;
      curStart = a;
      curEnd = b;
    } else if (b > curEnd) curEnd = b;
  }
  if (curEnd >= 0) total += curEnd - curStart;
  return total;
}
