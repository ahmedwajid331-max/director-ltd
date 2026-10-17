import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { effectiveStatus } from "@/lib/jobs/runs";
import { isRestConfigured, isStreamConfigured } from "@/lib/companies-house/client";
import { getDataFreshness } from "@/lib/data/freshness";

export const dynamic = "force-dynamic";

// Liveness / readiness for load balancers and uptime monitors.
//   - public: { status: "ok" | "degraded" } only - HTTP 503 if the database is unreachable
//   - Super Admin session: adds job health (stream freshness, stalled / failed jobs, pending DS01 events)
// "degraded" means the app is serving but a background job needs attention.
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    return NextResponse.json({ status: "down", db: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  const [streamRun, checkpoint, pendingEvents, runs] = await Promise.all([
    db.ingestionRun.findFirst({ where: { kind: "stream" }, orderBy: { startedAt: "desc" } }),
    db.streamCheckpoint.findUnique({ where: { name: "filings" } }),
    db.filingEvent.count({ where: { applyStatus: "pending", type: { in: ["DS01", "DS02"] } } }),
    db.ingestionRun.findMany({ orderBy: { startedAt: "desc" }, take: 50 }),
  ]);

  const now = Date.now();
  const streamStatus = streamRun ? effectiveStatus(streamRun) : "never";
  const streamConfigured = isStreamConfigured();
  const lastEventAgeSeconds = checkpoint?.lastEventAt ? Math.round((now - checkpoint.lastEventAt.getTime()) / 1000) : null;
  const stalledJobs = runs.filter((r) => effectiveStatus(r) === "stalled").length;

  // New registrations are synchronised daily-ish; more than 3 days behind means that job is failing or not running.
  const freshness = await getDataFreshness();
  const registrationsLagDays = freshness.registrationsThrough ? Math.floor((now - Date.parse(freshness.registrationsThrough + "T00:00:00Z")) / 86_400_000) : null;
  const registrationsStale = isRestConfigured() && registrationsLagDays !== null && registrationsLagDays > 3;

  const degraded =
    registrationsStale ||
    (streamConfigured && streamStatus !== "running") ||
    (streamConfigured && lastEventAgeSeconds !== null && lastEventAgeSeconds > 15 * 60) ||
    stalledJobs > 0 ||
    pendingEvents > 0;

  const session = await getSession();
  const body: Record<string, unknown> = { status: degraded ? "degraded" : "ok", db: true };
  if (session?.role === "SUPER_ADMIN") {
    body.jobs = {
      stream: { configured: streamConfigured, status: streamStatus, lastEventAgeSeconds, checkpoint: checkpoint ? Number(checkpoint.timepoint) : null },
      stalledJobs,
      dataFreshness: { lastUpdated: freshness.lastUpdated, registrationsThrough: freshness.registrationsThrough, registrationsLagDays, bulkSnapshot: freshness.bulkSnapshot },
      pendingDs01Events: pendingEvents,
      latestFailed: runs.filter((r) => r.status === "failed").slice(0, 3).map((r) => ({ kind: r.kind, at: r.startedAt, error: r.errorMessage?.slice(0, 200) ?? null })),
    };
  }
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
