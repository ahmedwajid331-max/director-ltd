import { db } from "@/lib/db";
import { makeLogger } from "@/lib/log";

const log = makeLogger("activity");

// The one place application events are written. Server-side only, called after the action has succeeded.
//  - sessionId / companyId / reportId are stored as indexed columns so "what happened in this session / on this company /
//    in this report" never needs a table scan.
//  - dedupeMs collapses an identical event (same user, action, company and report) repeated inside the window - used for
//    things that can repeat without new work being done (re-opening a company, re-viewing a report, retries).
//  - A logging failure is reported but never fails the user's action.
// Callers must keep `meta` small and free of secrets (no passwords, tokens or whole request bodies).

export interface ActivityActor {
  userId: string;
  sid?: string;
}

export interface ActivityOptions {
  meta?: Record<string, unknown> | null;
  companyId?: string;
  reportId?: string;
  dedupeMs?: number;
  // Only treat as a duplicate when the summary is identical too (e.g. the same search, not a different one).
  dedupeSameMeta?: boolean;
}

export async function logActivity(actor: ActivityActor, action: string, opts: ActivityOptions = {}): Promise<boolean> {
  try {
    const meta = opts.meta ? JSON.stringify(opts.meta).slice(0, 2000) : null;
    if (opts.dedupeMs) {
      const recent = await db.activityLog.findFirst({
        where: {
          userId: actor.userId,
          action,
          companyId: opts.companyId ?? null,
          reportId: opts.reportId ?? null,
          ...(opts.dedupeSameMeta ? { meta } : {}),
          createdAt: { gt: new Date(Date.now() - opts.dedupeMs) },
        },
        select: { id: true },
      });
      if (recent) return false;
    }
    await db.activityLog.create({
      data: { userId: actor.userId, action, meta, sessionId: actor.sid ?? null, companyId: opts.companyId ?? null, reportId: opts.reportId ?? null },
    });
    return true;
  } catch (err) {
    log.error("activity.log_failed", { action, err: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
