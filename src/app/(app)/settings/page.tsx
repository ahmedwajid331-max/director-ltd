import type { Metadata } from "next";
import { Suspense } from "react";
import { requireSession } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { Badge } from "@/components/ui/Badge";
import { CardHeader } from "@/components/ui/Card";
import { formatDate } from "@/lib/data/format";
import { RUN_KIND_LABELS, RUN_KINDS, coverageLabel, loadLatestRuns } from "@/lib/jobs/display";
import { isRestConfigured, isStreamConfigured } from "@/lib/companies-house/client";
import { isGoogleCalendarConfigured } from "@/lib/calendar/providers/google";
import { seedDataVisible } from "@/lib/data/scope";
import { CalendarSettingsClient } from "./CalendarSettingsClient";

export const metadata: Metadata = { title: "Settings" };


export default async function SettingsPage() {
  const session = await requireSession();
  const restConfigured = isRestConfigured();
  const streamConfigured = isStreamConfigured();
  const googleConfigured = isGoogleCalendarConfigured();

  const [sourceBreakdown, officerStats, latestRuns, calendarConnections] = await Promise.all([
    db.company.groupBy({ by: ["source"], _count: { _all: true } }),
    db.company.aggregate({
      _count: { _all: true },
      where: { source: { not: "seed" } },
    }),
    loadLatestRuns(),
    db.calendarConnection.findMany({ where: { userId: session.userId } }),
  ]);

  const officersFull = await db.company.count({ where: { source: { not: "seed" }, officersCoverage: "full" } });
  const realCompanies = officerStats._count._all;
  const officerCoveragePct = realCompanies === 0 ? null : Math.round((officersFull / realCompanies) * 100);

  const totalCompanies = sourceBreakdown.reduce((sum, row) => sum + row._count._all, 0);

  return (
    <div className="max-w-3xl space-y-6">
      <div className="rounded-xl border border-slate-200 bg-white">
        <CardHeader title="Your profile" description="Account details for this session." />
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Name</p>
            <p className="mt-1 text-sm text-slate-800">{session.name}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Email</p>
            <p className="mt-1 text-sm text-slate-800">{session.email}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Role</p>
            <p className="mt-1">
              <Badge tone="indigo">{session.role.replace("_", " ")}</Badge>
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white">
        <CardHeader
          title="Companies House data pipeline"
          description="Real connection and ingestion status — not a hardcoded claim."
        />
        <div className="space-y-3 px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5">
              <p className="text-sm font-medium text-slate-800">REST API</p>
              <Badge tone={restConfigured ? "green" : "amber"}>{restConfigured ? "Configured" : "Not configured"}</Badge>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5">
              <p className="text-sm font-medium text-slate-800">Filing stream</p>
              <Badge tone={streamConfigured ? "green" : "amber"}>
                {streamConfigured ? "Configured" : "Not configured"}
              </Badge>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 px-3 py-2.5">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
              Companies stored ({totalCompanies.toLocaleString()} total)
            </p>
            <p className="mb-2 text-sm text-slate-700">Real data coverage: {coverageLabel(realCompanies)}</p>
            <p className="mb-2 text-xs text-slate-500">
              {seedDataVisible()
                ? "Development (synthetic) data is currently visible in search and reports."
                : "Development (synthetic) data is hidden from search, reports and exports."}
            </p>
            <div className="space-y-1">
              {sourceBreakdown.map((row) => (
                <div key={row.source} className="flex items-center justify-between text-sm">
                  <span className="text-slate-600">
                    {row.source === "seed" ? "Development (synthetic) data - not Companies House" : row.source}
                  </span>
                  <span className="font-medium text-slate-900">{row._count._all.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 px-3 py-2.5">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Director data coverage (real companies only)
            </p>
            <p className="mt-1 text-sm text-slate-700">
              {officerCoveragePct === null
                ? "No real companies ingested yet"
                : `${officersFull.toLocaleString()} of ${realCompanies.toLocaleString()} (${officerCoveragePct}%) have fetched officer data`}
            </p>
          </div>

          <div className="rounded-lg border border-slate-200">
            <p className="border-b border-slate-100 px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-400">
              Pipeline runs
            </p>
            <div className="divide-y divide-slate-100">
              {latestRuns.map((v, i) => (
                <div key={RUN_KINDS[i]} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-slate-600">{RUN_KIND_LABELS[RUN_KINDS[i]]}</span>
                  {v.run ? (
                    <span className="flex items-center gap-2">
                      <Badge tone={v.tone}>{v.status}</Badge>
                      {v.detail && <span className="text-xs text-slate-400">{v.detail}</span>}
                      <span className="text-xs text-slate-400">{formatDate(v.run.finishedAt ?? v.run.startedAt)}</span>
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">Never run</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          <p className="text-xs text-slate-500">
            Run <code className="rounded bg-slate-100 px-1 py-0.5">npm run ch:bulk-ingest</code>,{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5">npm run ch:stream</code> or{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5">npm run ch:daily-update</code> to run the pipeline
            locally.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white">
        <CardHeader title="Calendar" description="Not locked to one provider — connect or disconnect at any time." />
        <Suspense>
          <CalendarSettingsClient
            googleConfigured={googleConfigured}
            initialConnections={calendarConnections.map((c) => ({
              provider: c.provider,
              status: c.status,
              accountEmail: c.accountEmail,
              lastSyncAt: c.lastSyncAt ? c.lastSyncAt.toISOString() : null,
              lastSyncError: c.lastSyncError,
            }))}
          />
        </Suspense>
      </div>
    </div>
  );
}
