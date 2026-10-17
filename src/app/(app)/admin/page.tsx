import type { Metadata } from "next";
import Link from "next/link";
import { Users, UserCheck, FileSearch, Activity, ShieldCheck, Database, Plug, Workflow, FileText, History } from "lucide-react";
import { cn } from "@/lib/cn";
import { PageHero, HeroChip, MetricTile, SectionCard, Panel, StatRow, StatusPill } from "@/components/admin/AdminUi";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth/guard";
import { Badge } from "@/components/ui/Badge";
import { formatDate } from "@/lib/data/format";
import { RUN_KIND_LABELS, RUN_KINDS, loadLatestRuns } from "@/lib/jobs/display";
import { isRestConfigured, isStreamConfigured } from "@/lib/companies-house/client";
import { loadOfficerPipelineStatus } from "@/lib/companies-house/officerStatus";
import { OfficerPipelinePanel } from "@/components/admin/OfficerPipelinePanel";
import { AdminTabs } from "@/components/admin/AdminTabs";
import { describeAction } from "@/lib/staff/actions";


export const metadata: Metadata = { title: "Super Admin" };

export default async function SuperAdminPage() {
  await requireRole("SUPER_ADMIN");
  const officerStatus = await loadOfficerPipelineStatus();

  const [
    userCount,
    activeUserCount,
    reportCount,
    companiesCount,
    allReports,
    recentActivity,
    sourceBreakdown,
    latestRuns,
    calendarConnections,
  ] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { active: true } }),
    db.report.count(),
    db.company.count(),
    db.report.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { owner: { select: { name: true, email: true } } },
    }),
    db.activityLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 25,
      include: { user: { select: { name: true } } },
    }),
    db.company.groupBy({ by: ["source"], _count: { _all: true } }),
    loadLatestRuns(),
    db.calendarConnection.findMany({ where: { provider: { not: "INTERNAL" } } }),
  ]);

  const realCompanies = sourceBreakdown.filter((r) => r.source !== "seed").reduce((s, r) => s + r._count._all, 0);
  const connectedCalendars = calendarConnections.filter((c) => c.status === "CONNECTED").length;
  const erroredCalendars = calendarConnections.filter((c) => c.status === "ERROR").length;

  const restOk = isRestConfigured();
  const streamOk = isStreamConfigured();
  const failedRuns = latestRuns.filter((v) => v.tone === "red");

  return (
    <div className="space-y-6">
      <AdminTabs active="overview" />
      <PageHero icon={ShieldCheck} eyebrow="Super Admin" title="System-wide oversight" description="Every user's searches, reports, exports and CRM activity, in one place.">
        <HeroChip label="Pipeline" value={failedRuns.length === 0 ? "No failed jobs" : `${failedRuns.length} failed job${failedRuns.length === 1 ? "" : "s"}`} dot={failedRuns.length === 0 ? "green" : "red"} />
        <HeroChip label="Officer data" value={officerStatus.healthy ? "Healthy" : "Needs attention"} dot={officerStatus.healthy ? "green" : "amber"} />
        <HeroChip label="Companies House" value={restOk && streamOk ? "Configured" : "Not fully configured"} dot={restOk && streamOk ? "green" : "amber"} />
      </PageHero>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="Total users" value={userCount.toLocaleString()} icon={Users} tone="blue" />
        <MetricTile label="Active users" value={activeUserCount.toLocaleString()} icon={UserCheck} tone="emerald" />
        <MetricTile label="Reports created" value={reportCount.toLocaleString()} icon={FileSearch} tone="amber" />
        <MetricTile label="Companies stored" value={companiesCount.toLocaleString()} icon={Database} tone="violet" />
      </div>

      <SectionCard
        icon={Activity}
        tone="blue"
        title="Companies House pipeline health"
        description="Connection status and the latest run of each ingestion job."
        action={failedRuns.length > 0 ? <StatusPill tone="red">{failedRuns.length} failed</StatusPill> : <StatusPill tone="green">All jobs OK</StatusPill>}
      >
        <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Panel icon={Plug} tone="blue" title="Connections">
            <StatRow label="REST API">
              <StatusPill tone={restOk ? "green" : "amber"}>{restOk ? "Configured" : "Not configured"}</StatusPill>
            </StatRow>
            <StatRow label="Filing stream">
              <StatusPill tone={streamOk ? "green" : "amber"}>{streamOk ? "Configured" : "Not configured"}</StatusPill>
            </StatRow>
            <StatRow label="Real Companies House companies">{realCompanies.toLocaleString()}</StatRow>
            <StatRow label="Calendars connected">
              {connectedCalendars}
              {erroredCalendars > 0 && <span className="ml-1 text-red-600">({erroredCalendars} in error)</span>}
            </StatRow>
          </Panel>
          <Panel icon={Workflow} tone="indigo" title="Latest job runs">
            <div className="space-y-1.5">
              {latestRuns.map((v, i) => (
                <div
                  key={RUN_KINDS[i]}
                  className={cn(
                    "flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm",
                    v.tone === "red" ? "border-red-200 bg-red-50/70" : "border-slate-200 bg-white"
                  )}
                >
                  <span className="font-medium text-slate-700">{RUN_KIND_LABELS[RUN_KINDS[i]]}</span>
                  {v.run ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={v.tone}>{v.status}</StatusPill>
                      {v.detail && <span className="text-xs text-slate-500">{v.detail}</span>}
                      <span className="text-xs text-slate-400">{formatDate(v.run.finishedAt ?? v.run.startedAt)}</span>
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">Never run</span>
                  )}
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </SectionCard>

      <OfficerPipelinePanel status={officerStatus} />

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard icon={FileText} tone="amber" title="All saved reports" description="Most recent 20 across all users.">
          <ul className="max-h-[420px] divide-y divide-slate-100 overflow-y-auto">
            {allReports.map((r) => (
              <li key={r.id} className="px-5 py-3 transition-colors hover:bg-indigo-50/40">
                <div className="flex items-center justify-between">
                  <Link href={`/reports/${r.id}`} className="text-sm font-medium text-slate-900 hover:text-indigo-600">
                    {r.name}
                  </Link>
                  <Badge tone="slate">{r.resultCount} results</Badge>
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  {r.owner.name} ({r.owner.email}) · {formatDate(r.createdAt)}
                </p>
              </li>
            ))}
            {allReports.length === 0 && <li className="px-5 py-4 text-sm text-slate-400">No reports yet.</li>}
          </ul>
        </SectionCard>

        <SectionCard icon={History} tone="slate" title="Activity across all users" description="Latest 25 events.">
          <ul className="max-h-[420px] divide-y divide-slate-100 overflow-y-auto">
            {recentActivity.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm transition-colors hover:bg-slate-50">
                <span className="text-slate-700">
                  <span className="font-medium">{entry.user.name}</span> — {describeAction(entry.action, entry.meta)}
                </span>
                <span className="text-xs text-slate-400">{formatDate(entry.createdAt)}</span>
              </li>
            ))}
            {recentActivity.length === 0 && <li className="px-5 py-4 text-sm text-slate-400">No activity yet.</li>}
          </ul>
        </SectionCard>
      </div>
    </div>
  );
}
