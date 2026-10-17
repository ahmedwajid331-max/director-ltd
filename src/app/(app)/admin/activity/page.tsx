import type { Metadata } from "next";
import Link from "next/link";
import { Activity, BarChart3, Briefcase, Clock, Download, FileText, PhoneCall, Radio, Users } from "lucide-react";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth/guard";
import { userScopeWhere } from "@/lib/staff/scope";
import { appTimezone, resolvePeriod } from "@/lib/staff/periods";
import { MAX_PEOPLE, SCREEN_ROWS, loadStaffReport, type Totals } from "@/lib/staff/report";
import { formatDuration } from "@/lib/staff/sessions";
import { MetricTile, PageHero, SectionCard, EmptyPanel } from "@/components/admin/AdminUi";
import { AdminTabs } from "@/components/admin/AdminTabs";
import { PresenceBadge } from "@/components/staff/PresenceBadge";
import { PeriodControls } from "@/components/staff/PeriodControls";
import { DailyChart } from "@/components/staff/DailyChart";

export const metadata: Metadata = { title: "Staff activity and reports" };

type SP = { period?: string; anchor?: string; from?: string; to?: string; staff?: string; role?: string; team?: string };

// "+12 vs previous" style comparison. A percentage is shown only when the previous figure is above zero; against zero a
// percentage is meaningless, so the previous value is stated plainly instead.
function delta(now: number, before: number | undefined, label: string) {
  if (before === undefined) return label;
  if (before === 0) return `${label} · previous period: 0`;
  const pct = Math.round(((now - before) / before) * 100);
  return `${label} · ${pct >= 0 ? "+" : ""}${pct}% vs ${before.toLocaleString()}`;
}

export default async function ActivityReportPage({ searchParams }: { searchParams: Promise<SP> }) {
  const session = await requirePermission("staff.activity");
  const sp = await searchParams;
  const tz = appTimezone();
  const now = new Date();

  const resolved = resolvePeriod({ kind: sp.period ?? "week", anchor: sp.anchor || undefined, from: sp.from, to: sp.to }, now, tz);
  const fallback = resolvePeriod({ kind: "week" }, now, tz);
  const period = (resolved.ok ? resolved : fallback.ok ? fallback : null)!.period;
  const periodError = resolved.ok ? null : resolved.error;

  // Selectors only offer people inside the viewer's scope; a forged id outside it simply matches nobody.
  const people = await db.user.findMany({ where: userScopeWhere(session), orderBy: { name: "asc" }, select: { id: true, name: true } });
  const teams = session.role === "SUPER_ADMIN" ? await db.user.findMany({ where: { role: { in: ["ADMIN", "SUPER_ADMIN"] }, team: { some: {} } }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : [];
  const staffId = people.some((p) => p.id === sp.staff) ? sp.staff : undefined;
  const role = sp.role === "USER" || sp.role === "ADMIN" || sp.role === "SUPER_ADMIN" ? sp.role : "";
  const teamId = teams.some((t) => t.id === sp.team) ? sp.team : undefined;

  const report = await loadStaffReport(session, period, { staffId, role: role || undefined, teamId });
  const t = report.totals;
  const prev: Partial<Totals> | null = report.previousTotals;
  const carried = new URLSearchParams({ period: period.kind, ...(period.kind === "custom" ? { from: period.fromDay, to: period.toDay } : { anchor: period.fromDay }), ...(staffId ? { staff: staffId } : {}), ...(role ? { role } : {}), ...(teamId ? { team: teamId } : {}) });
  const profileQuery = new URLSearchParams({ period: period.kind, ...(period.kind === "custom" ? { from: period.fromDay, to: period.toDay } : { anchor: period.fromDay }) });

  return (
    <div className="space-y-6">
      <AdminTabs active="activity" viewer={session} />
      <PageHero icon={BarChart3} eyebrow={session.role === "SUPER_ADMIN" ? "Super Admin" : "Team"} title="Staff activity and reports" description="What each person actually did in DIRECTOR.LTD, from recorded events. Nothing here is estimated." compact />

      <PeriodControls basePath="/admin/activity" period={period} staff={people} staffId={staffId} roleFilter={role} teams={teams} teamId={teamId} />
      {periodError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{periodError} Showing the current week instead.</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="Staff in view" value={report.rows.length.toLocaleString()} icon={Users} tone="blue" hint={`${report.rows.filter((r) => r.user.active).length} active accounts`} />
        <MetricTile label="Signed in now" value={report.signedInNow.toLocaleString()} icon={Radio} tone="emerald" hint="recently active or idle · now, not for the period" />
        <MetricTile label="Recorded actions" value={t.meaningfulActions.toLocaleString()} icon={Activity} tone="violet" hint={delta(t.meaningfulActions, prev?.meaningfulActions, "searches, CRM, reports, exports")} />
        <MetricTile label="Session time" value={formatDuration(t.sessionMs)} icon={Clock} tone="amber" hint={`${t.sessions} sessions · not working time`} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="Companies worked" value={t.companiesWorked.toLocaleString()} icon={Briefcase} tone="indigo" hint={delta(t.companiesWorked, prev?.companiesWorked, "summed per person")} />
        <MetricTile label="Contacts logged" value={t.contactsLogged.toLocaleString()} icon={PhoneCall} tone="emerald" hint={`${t.contactsReached} reached a person`} />
        <MetricTile label="Reports created" value={t.reportsCreated.toLocaleString()} icon={FileText} tone="amber" hint={delta(t.reportsCreated, prev?.reportsCreated, `${t.exports} exports`)} />
        <MetricTile label="Assigned work done" value={t.assignmentsCompleted.toLocaleString()} icon={Briefcase} tone="slate" hint={`${t.followUpsDone} of ${t.followUpsCreated} follow-ups done`} />
      </div>

      <SectionCard icon={BarChart3} tone="blue" title="Recorded actions per day" description={`${period.label} · ${period.tz}${period.previous ? ` · previous period: ${period.previous.label}` : ""}`}>
        <div className="p-5">
          <DailyChart points={report.series} label={`Recorded actions per day, ${period.label}`} />
        </div>
      </SectionCard>

      {report.truncated && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          This view covers more than {MAX_PEOPLE.toLocaleString()} people, so only the first {MAX_PEOPLE.toLocaleString()} (by name) are included in the totals and the table. Narrow by team or role.
        </p>
      )}
      {report.rows.length > SCREEN_ROWS && (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Listing the {SCREEN_ROWS} most active of {report.rows.length.toLocaleString()} people. The totals and chart above cover all {report.rows.length.toLocaleString()}; the CSV lists everyone.
        </p>
      )}
      <SectionCard
        icon={Users}
        tone="indigo"
        title="Staff comparison"
        description="Click a name to see their sessions, timeline and companies for the same period."
        action={
          <Link href={`/api/staff/report?${carried}`} className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
            <Download className="h-3.5 w-3.5" /> Download CSV
          </Link>
        }
      >
        {report.rows.length === 0 ? (
          <div className="p-5">
            <EmptyPanel icon={Users} title="No staff match these filters" description="Choose a different person, team or role." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2.5 font-semibold">Staff member</th>
                  <th className="px-3 py-2.5 font-semibold">Session now</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Sessions</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Session time</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Actions</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Companies</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Contacts (reached)</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Reports</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Exports</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Work done</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Failed logins</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {report.rows.slice(0, SCREEN_ROWS).map((r) => (
                  <tr key={r.user.id} className="hover:bg-indigo-50/40">
                    <td className="px-5 py-2.5">
                      <Link href={`/admin/staff/${r.user.id}?${profileQuery}`} className="font-medium text-slate-900 hover:text-indigo-600">
                        {r.user.name}
                      </Link>
                      {!r.user.active && <span className="ml-1.5 text-[11px] text-slate-400">inactive</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <PresenceBadge status={r.presence.status} />
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.stats.sessions}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatDuration(r.stats.sessionMs)}</td>
                    <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-900">{r.stats.meaningfulActions}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.stats.companiesWorked}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {r.stats.contactsLogged} <span className="text-slate-400">({r.stats.contactsReached})</span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.stats.reportsCreated}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.stats.exports}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.stats.assignmentsCompleted}</td>
                    <td className={`px-3 py-2.5 text-right tabular-nums ${r.stats.failedLogins > 0 ? "font-semibold text-red-600" : ""}`}>{r.stats.failedLogins}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <div className="space-y-1 text-xs text-slate-500">
        <p>
          <strong className="font-medium text-slate-600">How to read this.</strong> &ldquo;Recorded actions&rdquo; counts events the application wrote down (searches, opening companies, CRM changes, notes, follow-ups, contacts, reports, exports). &ldquo;Session time&rdquo; is the span between sign-in and sign-out, or to the last request when there was no sign-out; it is not verified working time.
        </p>
        <p>
          &ldquo;Contacts&rdquo; counts only entries staff logged in the contact log; &ldquo;reached&rdquo; counts the ones where a person was actually spoken to. Sign-in tracking began when this feature was introduced, so earlier days have no session figures.
        </p>
      </div>
    </div>
  );
}
