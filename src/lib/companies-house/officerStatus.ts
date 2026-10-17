import { db } from "@/lib/db";
import { effectiveStatus } from "@/lib/jobs/runs";
import { loadOfficerConfig } from "./officerQueue";
import { readQuotaState, QUOTA_CLASSES } from "./quota";
import { readBreaker, type BreakerData } from "./breaker";

// Read-only health snapshot of the officer coverage pipeline for Settings /
// Super Admin. Contains counts and timestamps only - never API keys.

export interface OfficerPipelineStatus {
  coverage: { none: number; full: number; unavailable: number; staleOrDirty: number; dirty: number; total: number };
  queue: { queued: number; retry: number; leased: number; parked: number; depth: number; byPriority: Record<string, number> };
  worker: {
    status: string; // running | success | partial | failed | stalled | never
    runningNow: boolean; // a worker is alive right now (not merely "its last run succeeded")
    enabledByConfig: boolean; // OFFICER_WORKER_ENABLED: the scheduler will keep a worker running (only says what is configured)
    crawlEnabledByConfig: boolean; // OFFICER_CRAWL_ENABLED: the worker also walks the background crawl
    idleWithBacklog: boolean; // jobs are waiting, nothing is running, and the last run was more than a day ago
    lastRunAt: Date | null;
    lastSuccessAt: Date | null;
    lastError: string | null;
    lastStopReason: string | null;
    companiesPerMinute: number | null;
    last24hProcessed: number;
    last24hCompaniesPerHour: number | null;
  };
  quota: {
    windowEndsAt: Date | null;
    used: Record<string, number> | null;
    headerRemaining: number | null;
    cooldownUntil: Date | null;
    backgroundPausedUntil: Date | null;
    limit: number;
    headroom: number;
    reserve: Record<string, number>;
    idleFloor: Record<string, number>;
    activeClasses: string[]; // classes with recent demand (they keep their full reservation)
    pacing: boolean;
  };
  // Internal quota denials and real HTTP 429s, kept apart.
  quotaEvents24h: { internalDenials: number; http429: number; byReason: Record<string, number> };
  recentQuotaEvents: { at: Date; kind: string; quotaClass: string; reason: string; internal: boolean; httpStatus: number | null; waitMs: number | null; usedTotal: number | null; usedClass: number | null; headerRemaining: number | null }[];
  breakers: { auth: BreakerView; outage: BreakerView };
  requests24h: { requests: number; ok: number; status404: number; status429: number; statusAuth: number; status5xx: number; networkErrors: number };
  recentErrors: { companyId: string; companyNumber: string | null; status: string; attempts: number; lastHttpStatus: number | null; lastError: string | null; updatedAt: Date }[];
  healthy: boolean;
}

export interface BreakerView {
  state: string;
  reason: string | null;
  openedAt: Date | null;
  openUntil: Date | null;
  trips: number;
  lastStatus: number | null;
}

const view = (b: BreakerData): BreakerView => ({ state: b.state, reason: b.reason, openedAt: b.openedAt, openUntil: b.openUntil, trips: b.trips, lastStatus: b.lastStatus });

// Work is waiting, nobody is running it, and the last run was over a day ago (or never): a healthy-looking "last run
// succeeded" must not hide that. Pure so it can be tested without a database.
export function isIdleWithBacklog(queueDepth: number, runningNow: boolean, lastRunAt: Date | null, now: Date): boolean {
  return queueDepth > 0 && !runningNow && (!lastRunAt || now.getTime() - lastRunAt.getTime() > 24 * 3_600_000);
}

export async function loadOfficerPipelineStatus(now: Date = new Date()): Promise<OfficerPipelineStatus> {
  const config = loadOfficerConfig();
  const staleCutoff = new Date(now.getTime() - config.staleAfterDays * 86_400_000);
  const since24h = new Date(now.getTime() - 24 * 3_600_000);

  const real = { source: { not: "seed" } } as const;
  const [none, full, unavailable, dirty, staleOrDirty, jobGroups, priorityGroups, lastRun, lastSuccess, stats24, errors, quota, auth, outage, eventGroups, recentEvents] = await Promise.all([
    db.company.count({ where: { ...real, officersCoverage: "none" } }),
    db.company.count({ where: { ...real, officersCoverage: "full" } }),
    db.company.count({ where: { ...real, officersCoverage: "unavailable" } }),
    db.company.count({ where: { ...real, officersCoverage: "full", officersDirtyAt: { not: null } } }),
    db.company.count({
      where: { ...real, officersCoverage: "full", OR: [{ officersDirtyAt: { not: null } }, { officersFetchedAt: { lt: staleCutoff } }] },
    }),
    db.officerSyncJob.groupBy({ by: ["status"], _count: { _all: true } }),
    db.officerSyncJob.groupBy({ by: ["priority"], where: { status: { in: ["queued", "retry", "leased"] } }, _count: { _all: true } }),
    db.ingestionRun.findFirst({ where: { kind: "officer_backfill" }, orderBy: { startedAt: "desc" } }),
    db.ingestionRun.findFirst({ where: { kind: "officer_backfill", status: { in: ["success", "partial"] } }, orderBy: { finishedAt: "desc" } }),
    db.chRequestStat.aggregate({
      where: { bucketStart: { gte: new Date(since24h.getTime() - 3_600_000) } },
      _sum: { requests: true, ok: true, status404: true, status429: true, statusAuth: true, status5xx: true, networkErrors: true },
    }),
    db.officerSyncJob.findMany({
      where: { OR: [{ status: "parked" }, { lastError: { not: null } }] },
      orderBy: { updatedAt: "desc" },
      take: 10,
      include: { company: { select: { companyNumber: true } } },
    }),
    readQuotaState(),
    readBreaker("auth"),
    readBreaker("outage"),
    db.chQuotaEvent.groupBy({ by: ["kind", "reason"], where: { at: { gte: since24h } }, _count: { _all: true } }),
    db.chQuotaEvent.findMany({ orderBy: { at: "desc" }, take: 10 }),
  ]);

  const count = (s: string) => jobGroups.find((g) => g.status === s)?._count._all ?? 0;
  const runs24 = await db.ingestionRun.findMany({ where: { kind: "officer_backfill", startedAt: { gte: since24h } }, select: { rowsRead: true, startedAt: true, finishedAt: true, heartbeatAt: true } });
  const processed24 = runs24.reduce((sum, r) => sum + r.rowsRead, 0);
  const activeMs = runs24.reduce((sum, r) => sum + Math.max(0, (r.finishedAt ?? r.heartbeatAt).getTime() - r.startedAt.getTime()), 0);
  let lastStats: { companiesPerMinute?: number; stopReason?: string } = {};
  try {
    lastStats = lastRun?.statsJson ? JSON.parse(lastRun.statsJson) : {};
  } catch {
    /* ignore */
  }

  const q = quota.state;
  const status: OfficerPipelineStatus = {
    coverage: { none, full, unavailable, staleOrDirty, dirty, total: none + full + unavailable },
    queue: {
      queued: count("queued"),
      retry: count("retry"),
      leased: count("leased"),
      parked: count("parked"),
      depth: count("queued") + count("retry") + count("leased"),
      byPriority: Object.fromEntries(priorityGroups.map((g) => [`P${g.priority}`, g._count._all])),
    },
    worker: {
      status: lastRun ? effectiveStatus(lastRun) : "never",
      runningNow: lastRun ? effectiveStatus(lastRun) === "running" : false,
      enabledByConfig: process.env.OFFICER_WORKER_ENABLED === "1",
      crawlEnabledByConfig: process.env.OFFICER_CRAWL_ENABLED === "1",
      idleWithBacklog: false,
      lastRunAt: lastRun?.startedAt ?? null,
      lastSuccessAt: lastSuccess?.finishedAt ?? null,
      lastError: lastRun?.errorMessage ?? null,
      lastStopReason: lastStats.stopReason ?? null,
      companiesPerMinute: lastStats.companiesPerMinute ?? null,
      last24hProcessed: processed24,
      last24hCompaniesPerHour: activeMs > 0 ? Math.round((processed24 / (activeMs / 3_600_000)) * 10) / 10 : null,
    },
    quota: {
      windowEndsAt: q?.windowEndsAt ?? null,
      used: q ? { ...q.used } : null,
      headerRemaining: q?.headerRemaining ?? null,
      cooldownUntil: q?.cooldownUntil && q.cooldownUntil > now ? q.cooldownUntil : null,
      backgroundPausedUntil: q?.backgroundPausedUntil && q.backgroundPausedUntil > now ? q.backgroundPausedUntil : null,
      limit: quota.policy.limit,
      headroom: quota.policy.headroom,
      reserve: Object.fromEntries(QUOTA_CLASSES.map((c) => [c, quota.policy.reserve[c]])),
      idleFloor: Object.fromEntries(QUOTA_CLASSES.map((c) => [c, quota.policy.idleFloor[c]])),
      activeClasses: q ? QUOTA_CLASSES.filter((c) => q.lastDemandAt[c] && now.getTime() - q.lastDemandAt[c]!.getTime() <= quota.policy.demandHorizonMs) : [],
      pacing: quota.policy.pacing,
    },
    quotaEvents24h: {
      internalDenials: eventGroups.filter((g) => g.kind === "quota_denied").reduce((n, g) => n + g._count._all, 0),
      http429: eventGroups.filter((g) => g.kind === "http_429").reduce((n, g) => n + g._count._all, 0),
      byReason: Object.fromEntries(eventGroups.map((g) => [`${g.kind}:${g.reason}`, g._count._all])),
    },
    recentQuotaEvents: recentEvents.map((e) => ({
      at: e.at, kind: e.kind, quotaClass: e.quotaClass, reason: e.reason, internal: e.internal, httpStatus: e.httpStatus,
      waitMs: e.waitMs, usedTotal: e.usedTotal, usedClass: e.usedClass, headerRemaining: e.headerRemaining,
    })),
    breakers: { auth: view(auth), outage: view(outage) },
    requests24h: {
      requests: stats24._sum.requests ?? 0,
      ok: stats24._sum.ok ?? 0,
      status404: stats24._sum.status404 ?? 0,
      status429: stats24._sum.status429 ?? 0,
      statusAuth: stats24._sum.statusAuth ?? 0,
      status5xx: stats24._sum.status5xx ?? 0,
      networkErrors: stats24._sum.networkErrors ?? 0,
    },
    recentErrors: errors.map((e) => ({
      companyId: e.companyId,
      companyNumber: e.company?.companyNumber ?? null,
      status: e.status,
      attempts: e.attempts,
      lastHttpStatus: e.lastHttpStatus,
      lastError: e.lastError,
      updatedAt: e.updatedAt,
    })),
    healthy: true,
  };
  status.worker.idleWithBacklog = isIdleWithBacklog(status.queue.depth, status.worker.runningNow, lastRun?.startedAt ?? null, now);
  status.healthy = auth.state === "closed" && !status.worker.idleWithBacklog && status.worker.status !== "stalled" && status.queue.parked === 0;
  return status;
}
