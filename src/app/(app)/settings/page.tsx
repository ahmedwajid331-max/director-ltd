import type { Metadata } from "next";
import { Suspense } from "react";
import { requireSession } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { Badge } from "@/components/ui/Badge";
import { Settings as SettingsIcon, Database, Plug, Users, Workflow, User as UserIcon, Mail, ShieldCheck, CalendarDays } from "lucide-react";
import { cn } from "@/lib/cn";
import { PageHero, SectionCard, Panel, StatRow, StatusPill } from "@/components/admin/AdminUi";
import { formatDate } from "@/lib/data/format";
import { RUN_KIND_LABELS, RUN_KINDS, coverageLabel, loadLatestRuns } from "@/lib/jobs/display";
import { isRestConfigured, isStreamConfigured } from "@/lib/companies-house/client";
import { isGoogleCalendarConfigured } from "@/lib/calendar/providers/google";
import { seedDataVisible } from "@/lib/data/scope";
import { CalendarSettingsClient } from "./CalendarSettingsClient";
import { ColumnPicker } from "@/components/columns/ColumnPicker";
import { MonitoringNotice } from "@/components/staff/MonitoringNotice";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { avatarUrl, findAvatar } from "@/lib/avatar";
import { Avatar } from "@/components/profile/Avatar";
import { ProfilePictureEditor } from "@/components/profile/ProfilePictureEditor";

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
  const officersUnavailable = await db.company.count({ where: { source: { not: "seed" }, officersCoverage: "unavailable" } });
  const realCompanies = officerStats._count._all;
  const officerCoveragePct = realCompanies === 0 ? null : Math.round((officersFull / realCompanies) * 100);

  const totalCompanies = sourceBreakdown.reduce((sum, row) => sum + row._count._all, 0);

  const initials = session.name.slice(0, 2).toUpperCase();
  const found = await findAvatar(session.userId);
  const picture = found ? avatarUrl(session.userId, found.mtimeMs) : null;
  const failedRuns = latestRuns.filter((v) => v.tone === "red").length;
  const codeCls = "rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]";

  return (
    <div className="space-y-6">
      <PageHero
        icon={SettingsIcon}
        eyebrow="Account & configuration"
        title="Settings"
        description="Your profile, the Companies House data pipeline and calendar connections."
        aside={
          <div className="flex items-center gap-3 rounded-2xl bg-white/10 px-4 py-3 ring-1 ring-white/15">
            <Avatar src={picture} initials={initials} className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-base font-bold text-indigo-700" />
            <div className="leading-tight">
              <p className="text-sm font-semibold">{session.name}</p>
              <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-200">{session.role.replace("_", " ")}</p>
            </div>
          </div>
        }
      />

      <MonitoringNotice />

      <section id="profile-picture" className="scroll-mt-24">
        <SectionCard icon={UserIcon} tone="indigo" title="Profile picture" description="Shown in the header next to your name. Only you can change it.">
          <ProfilePictureEditor currentSrc={picture} initials={initials} />
        </SectionCard>
      </section>

      <SectionCard icon={ShieldCheck} tone="violet" title="What you can do" description={session.role === "SUPER_ADMIN" ? "A Super Admin has every permission." : "Set by a Super Admin. Ask them if you need more."}>
        <ul className="grid gap-x-6 gap-y-1.5 p-5 text-sm sm:grid-cols-2">
          {PERMISSIONS.filter((p) => p.group !== "Administration" || session.permissions.includes(p.key)).map((p) => {
            const on = session.role === "SUPER_ADMIN" || session.permissions.includes(p.key);
            return (
              <li key={p.key} className={on ? "text-slate-800" : "text-slate-400 line-through decoration-slate-300"}>
                <span aria-hidden className={on ? "mr-1.5 text-emerald-600" : "mr-1.5"}>{on ? "✓" : "–"}</span>
                {p.label}
                <span className="sr-only">{on ? " (allowed)" : " (not allowed)"}</span>
              </li>
            );
          })}
        </ul>
      </SectionCard>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="space-y-6">
          <SectionCard
            icon={Database}
            tone="blue"
            title="Companies House data pipeline"
            description="Real connection and ingestion status — not a hardcoded claim."
            action={failedRuns > 0 ? <StatusPill tone="red">{failedRuns} failed</StatusPill> : undefined}
          >
            <div className="space-y-4 p-5">
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  ["REST API", restConfigured],
                  ["Filing stream", streamConfigured],
                ].map(([label, ok]) => (
                  <div key={String(label)} className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                    <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                      <Plug className="h-4 w-4 text-slate-400" /> {label}
                    </span>
                    <StatusPill tone={ok ? "green" : "amber"}>{ok ? "Configured" : "Not configured"}</StatusPill>
                  </div>
                ))}
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <Panel icon={Database} tone="blue" title={`Companies stored (${totalCompanies.toLocaleString()} total)`}>
                  <p className="mb-1 text-sm text-slate-700">Real data coverage: {coverageLabel(realCompanies)}</p>
                  <p className="mb-2 text-xs text-slate-500">
                    {seedDataVisible()
                      ? "Development (synthetic) data is currently visible in search and reports."
                      : "Development (synthetic) data is hidden from search, reports and exports."}
                  </p>
                  {sourceBreakdown.map((row) => (
                    <StatRow key={row.source} label={row.source === "seed" ? "Development (synthetic) data - not Companies House" : row.source}>
                      {row._count._all.toLocaleString()}
                    </StatRow>
                  ))}
                </Panel>

                <Panel icon={Users} tone="violet" title="Director data coverage (real companies only)">
                  {officerCoveragePct !== null && (
                    <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-violet-100" role="img" aria-label={`${officerCoveragePct}% confirmed`}>
                      <div className="h-full rounded-full bg-violet-500" style={{ width: `${Math.max(officerCoveragePct, officersFull > 0 ? 1 : 0)}%` }} />
                    </div>
                  )}
                  <p className="text-sm text-slate-700">
                    {officerCoveragePct === null
                      ? "No real companies ingested yet"
                      : `${officersFull.toLocaleString()} of ${realCompanies.toLocaleString()} (${officerCoveragePct}%) have confirmed officer data${officersUnavailable ? ` · ${officersUnavailable.toLocaleString()} unavailable from Companies House` : ""}`}
                  </p>
                </Panel>
              </div>

              <Panel icon={Workflow} tone="indigo" title="Pipeline runs">
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

              <p className="text-xs leading-relaxed text-slate-500">
                Run <code className={codeCls}>npm run ch:bulk-ingest</code>, <code className={codeCls}>npm run ch:stream</code>,{" "}
                <code className={codeCls}>npm run ch:daily-update</code> or <code className={codeCls}>npm run ch:officer-worker</code> to run the pipeline locally. Officer queue, quota
                and circuit-breaker health is on the Super Admin page.
              </p>
            </div>
          </SectionCard>
        </div>

        <div className="space-y-6">
          <SectionCard icon={UserIcon} tone="indigo" title="Your profile" description="Account details for this session.">
            <dl className="space-y-4 p-5">
              <div>
                <dt className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  <UserIcon className="h-3.5 w-3.5" /> Name
                </dt>
                <dd className="mt-1 text-sm font-medium text-slate-900">{session.name}</dd>
              </div>
              <div>
                <dt className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  <Mail className="h-3.5 w-3.5" /> Email
                </dt>
                <dd className="mt-1 break-all text-sm font-medium text-slate-900">{session.email}</dd>
              </div>
              <div>
                <dt className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  <ShieldCheck className="h-3.5 w-3.5" /> Role
                </dt>
                <dd className="mt-1">
                  <Badge tone="indigo">{session.role.replace("_", " ")}</Badge>
                </dd>
              </div>
            </dl>
          </SectionCard>

          <SectionCard icon={CalendarDays} tone="emerald" title="Calendar" description="Not locked to one provider — connect or disconnect at any time.">
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
          </SectionCard>
        </div>
      </div>

      <ColumnPicker variant="card" />
    </div>
  );
}
