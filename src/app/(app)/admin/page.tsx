import type { Metadata } from "next";
import Link from "next/link";
import { Users, FileSearch, Activity, ShieldCheck } from "lucide-react";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth/guard";
import { StatCard } from "@/components/ui/StatCard";
import { Badge } from "@/components/ui/Badge";
import { formatDate } from "@/lib/data/format";
import { isRestConfigured, isStreamConfigured } from "@/lib/companies-house/client";

const RUN_KINDS = ["bulk_csv", "stream_backfill", "officer_backfill", "daily_update"] as const;
const RUN_KIND_LABELS: Record<string, string> = {
  bulk_csv: "Bulk / search ingestion",
  stream_backfill: "Filing stream",
  officer_backfill: "Officer backfill",
  daily_update: "Daily update",
};

export const metadata: Metadata = { title: "Super Admin" };

function describeAction(action: string, meta: string | null): string {
  const data = meta ? JSON.parse(meta) : {};
  switch (action) {
    case "login":
      return "Signed in";
    case "report_created":
      return `Created report "${data.name}"`;
    case "company_follow_toggle":
      return `${data.followed ? "Followed" : "Unfollowed"} ${data.companyName}`;
    case "company_trash_toggle":
      return `${data.trashed ? "Sent to trash" : "Restored"} ${data.companyName}`;
    case "director_contact_added":
      return `Added contact "${data.name}"`;
    default:
      return action;
  }
}

export default async function SuperAdminPage() {
  await requireRole("SUPER_ADMIN");

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
    Promise.all(RUN_KINDS.map((kind) => db.ingestionRun.findFirst({ where: { kind }, orderBy: { startedAt: "desc" } }))),
    db.calendarConnection.findMany({ where: { provider: { not: "INTERNAL" } } }),
  ]);

  const realCompanies = sourceBreakdown.filter((r) => r.source !== "seed").reduce((s, r) => s + r._count._all, 0);
  const connectedCalendars = calendarConnections.filter((c) => c.status === "CONNECTED").length;
  const erroredCalendars = calendarConnections.filter((c) => c.status === "ERROR").length;

  return (
    <div className="space-y-6">
      <div>
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-indigo-600">
          <ShieldCheck className="h-3.5 w-3.5" /> Super Admin
        </p>
        <h2 className="text-lg font-semibold text-slate-900">System-wide oversight</h2>
        <p className="text-sm text-slate-500">Every user&apos;s searches, reports and activity, in one place.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total users" value={userCount.toLocaleString()} icon={Users} accent="indigo" />
        <StatCard label="Active users" value={activeUserCount.toLocaleString()} icon={Users} accent="emerald" />
        <StatCard label="Reports created" value={reportCount.toLocaleString()} icon={FileSearch} accent="amber" />
        <StatCard label="Companies stored" value={companiesCount.toLocaleString()} icon={Activity} accent="slate" />
      </div>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-900">Companies House pipeline health</h3>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600">REST API</span>
              <Badge tone={isRestConfigured() ? "green" : "amber"}>
                {isRestConfigured() ? "Configured" : "Not configured"}
              </Badge>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600">Filing stream</span>
              <Badge tone={isStreamConfigured() ? "green" : "amber"}>
                {isStreamConfigured() ? "Configured" : "Not configured"}
              </Badge>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600">Real (non-seed) companies</span>
              <span className="font-medium text-slate-900">{realCompanies.toLocaleString()}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600">Calendars connected</span>
              <span className="font-medium text-slate-900">
                {connectedCalendars}
                {erroredCalendars > 0 && <span className="ml-1 text-red-600">({erroredCalendars} in error)</span>}
              </span>
            </div>
          </div>
          <div className="space-y-1.5">
            {latestRuns.map((run, i) => (
              <div key={RUN_KINDS[i]} className="flex items-center justify-between text-sm">
                <span className="text-slate-600">{RUN_KIND_LABELS[RUN_KINDS[i]]}</span>
                {run ? (
                  <span className="flex items-center gap-2">
                    <Badge
                      tone={
                        run.status === "success"
                          ? "green"
                          : run.status === "running"
                            ? "blue"
                            : run.status === "partial"
                              ? "amber"
                              : "red"
                      }
                    >
                      {run.status}
                    </Badge>
                    <span className="text-xs text-slate-400">{formatDate(run.finishedAt ?? run.startedAt)}</span>
                  </span>
                ) : (
                  <span className="text-xs text-slate-400">Never run</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-5 py-3">
            <h3 className="text-sm font-semibold text-slate-900">All saved reports</h3>
          </div>
          <ul className="max-h-[420px] divide-y divide-slate-100 overflow-y-auto">
            {allReports.map((r) => (
              <li key={r.id} className="px-5 py-3">
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
        </section>

        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-5 py-3">
            <h3 className="text-sm font-semibold text-slate-900">Activity across all users</h3>
          </div>
          <ul className="max-h-[420px] divide-y divide-slate-100 overflow-y-auto">
            {recentActivity.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between px-5 py-3 text-sm">
                <span className="text-slate-700">
                  <span className="font-medium">{entry.user.name}</span> — {describeAction(entry.action, entry.meta)}
                </span>
                <span className="text-xs text-slate-400">{formatDate(entry.createdAt)}</span>
              </li>
            ))}
            {recentActivity.length === 0 && <li className="px-5 py-4 text-sm text-slate-400">No activity yet.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
