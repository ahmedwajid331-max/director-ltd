import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Prisma } from "@prisma/client";
import { Activity, Briefcase, ChevronLeft, ClipboardList, Clock, FileText, History, LogIn, PhoneCall, ShieldCheck, UserCog } from "lucide-react";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth/guard";
import { can, parsePermissions, resolvePermissions } from "@/lib/auth/permissions";
import { findScopedUser } from "@/lib/staff/scope";
import { appTimezone, dayKey, resolvePeriod, startOfDay, type PeriodResult } from "@/lib/staff/periods";
import { getDailySeries, getPeriodStats, getPresence, utcTs } from "@/lib/staff/stats";
import { ACTION_CATEGORY_KEYS, CATEGORY_LABEL, actionCategory, actionsInCategory, describeAction, MEANINGFUL_ACTIONS, type ActionCategory } from "@/lib/staff/actions";
import { SESSION_STATUS_LABEL, formatDuration, quietBeforeSignOutMs, sessionDurationMs, sessionStatus, sessionThresholds } from "@/lib/staff/sessions";
import { formatHours, formatMoney, payAmountMinor } from "@/lib/staff/money";
import { TIMESHEET_STATUS_LABEL, payLines, totalsByCurrency } from "@/lib/staff/timesheet";
import { OUTCOME_LABEL, CHANNEL_LABEL, type ContactChannel, type ContactOutcome } from "@/lib/staff/contact";
import { MetricTile, PageHero, Panel, SectionCard, StatRow, StatusPill, EmptyPanel } from "@/components/admin/AdminUi";
import { AdminTabs } from "@/components/admin/AdminTabs";
import { PresenceBadge } from "@/components/staff/PresenceBadge";
import { PeriodControls } from "@/components/staff/PeriodControls";
import { DailyChart } from "@/components/staff/DailyChart";
import { StaffAdminControls } from "@/components/staff/StaffAdminControls";
import { AssignWorkForm } from "@/components/staff/AssignWorkForm";
import { Badge } from "@/components/ui/Badge";
import type { UserRole } from "@/lib/types";

export const metadata: Metadata = { title: "Staff profile" };

type SP = { period?: string; anchor?: string; from?: string; to?: string; cat?: string; session?: string; page?: string };
const PAGE_SIZE = 25;
const ROLE_LABEL = { USER: "User", ADMIN: "Admin", SUPER_ADMIN: "Super Admin" } as const;

const fmt = (d: Date | null | undefined, tz: string) =>
  d ? d.toLocaleString("en-GB", { timeZone: tz, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

export default async function StaffProfilePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const session = await requirePermission("staff.view");
  const { id } = await params;
  const sp = await searchParams;
  const tz = appTimezone();
  const now = new Date();

  // Out-of-scope accounts look exactly like missing ones.
  const user = await findScopedUser(session, id, "staff.view", {
    id: true, name: true, email: true, role: true, active: true, createdAt: true, lastLoginAt: true, permissions: true, managerId: true, hourlyRateMinor: true, rateCurrency: true, manager: { select: { name: true } },
  });
  if (!user) notFound();

  const canActivity = can(session, "staff.activity");
  const canAssign = can(session, "team.assign") && user.active;
  const resolved = resolvePeriod({ kind: sp.period ?? "week", anchor: sp.anchor || undefined, from: sp.from, to: sp.to }, now, tz);
  const period = (resolved.ok ? resolved : (resolvePeriod({ kind: "week" }, now, tz) as Extract<PeriodResult, { ok: true }>)).period;
  const periodError = resolved.ok ? null : resolved.error;

  const cat = (ACTION_CATEGORY_KEYS as string[]).includes(sp.cat ?? "") ? (sp.cat as ActionCategory) : null;
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const sessionFilter = sp.session && /^[a-z0-9]{10,40}$/i.test(sp.session) ? sp.session : null;

  const timelineWhere: Prisma.ActivityLogWhereInput = {
    userId: id,
    createdAt: { gte: period.from, lt: period.to },
    ...(cat ? { action: { in: actionsInCategory(cat) } } : {}),
    ...(sessionFilter ? { sessionId: sessionFilter } : {}),
  };

  type SheetRow = { userId: string; status: string; submittedMinutes: number; approvedMinutes: number | null; rateMinorAtApproval: number | null; rateCurrencyAtApproval: string | null };
  const periodSheets: SheetRow[] | null = can(session, "timesheets.approve")
    ? await db.timesheet.findMany({ where: { userId: id, workDate: { gte: new Date(`${period.fromDay}T00:00:00.000Z`), lte: new Date(`${period.toDay}T00:00:00.000Z`) } }, select: { userId: true, status: true, submittedMinutes: true, approvedMinutes: true, rateMinorAtApproval: true, rateCurrencyAtApproval: true } })
    : null;

  const [presenceMap, stats, series, timelineTotal, timeline, sessions, worked, assignments, reports, sheets, contacts, supervisors] = await Promise.all([
    getPresence([id], now),
    canActivity ? getPeriodStats([id], period.from, period.to) : null,
    canActivity ? getDailySeries([id], period.days, period.from, period.to, tz, (d) => startOfDay(d, tz)) : null,
    canActivity ? db.activityLog.count({ where: timelineWhere }) : 0,
    canActivity ? db.activityLog.findMany({ where: timelineWhere, orderBy: { createdAt: "desc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }) : [],
    canActivity ? db.userSession.findMany({ where: { userId: id }, orderBy: { startedAt: "desc" }, take: 15 }) : [],
    canActivity
      ? db.$queryRaw<{ companyId: string; n: number; last: Date }[]>(
          Prisma.sql`SELECT "companyId", COUNT(*)::int AS n, MAX("createdAt") AS last FROM "ActivityLog"
            WHERE "userId" = ${id} AND "createdAt" >= ${utcTs(period.from)} AND "createdAt" < ${utcTs(period.to)} AND "companyId" IS NOT NULL AND "action" IN (${Prisma.join(MEANINGFUL_ACTIONS)})
            GROUP BY "companyId" ORDER BY n DESC, last DESC LIMIT 15`
        )
      : [],
    db.assignment.findMany({ where: { assigneeId: id }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 15, include: { company: { select: { name: true, companyNumber: true } }, assignedBy: { select: { name: true } } } }),
    canActivity ? db.report.findMany({ where: { ownerId: id }, orderBy: { createdAt: "desc" }, take: 8, select: { id: true, name: true, resultCount: true, createdAt: true } }) : [],
    can(session, "timesheets.approve") ? db.timesheet.findMany({ where: { userId: id }, orderBy: { workDate: "desc" }, take: 8 }) : [],
    canActivity ? db.contactLog.findMany({ where: { userId: id, createdAt: { gte: period.from, lt: period.to } }, orderBy: { createdAt: "desc" }, take: 10, include: { company: { select: { id: true, name: true } } } }) : [],
    session.role === "SUPER_ADMIN" ? db.user.findMany({ where: { active: true, role: { in: ["ADMIN", "SUPER_ADMIN"] } }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [],
  ]);

  const presence = presenceMap.get(id)!;
  const s = stats?.get(id);
  const sessionEvents = sessions.length
    ? await db.activityLog.groupBy({ by: ["sessionId"], where: { sessionId: { in: sessions.map((x) => x.id) } }, _count: { _all: true } })
    : [];
  const eventsBySession = new Map(sessionEvents.map((e) => [e.sessionId, e._count._all]));
  const companyNames = worked.length ? await db.company.findMany({ where: { id: { in: worked.map((w) => w.companyId) } }, select: { id: true, name: true, companyNumber: true } }) : [];
  const nameOf = new Map(companyNames.map((c) => [c.id, c]));

  const pageCount = Math.max(1, Math.ceil(timelineTotal / PAGE_SIZE));
  const q = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const cur: Record<string, string | undefined> = { period: period.kind, anchor: sp.anchor, from: sp.from, to: sp.to, cat: cat ?? undefined, session: sessionFilter ?? undefined, ...over };
    for (const [k, v] of Object.entries(cur)) if (v) p.set(k, v);
    return `/admin/staff/${id}?${p}#timeline`;
  };
  const todayDate = new Date(`${dayKey(now, tz)}T00:00:00.000Z`);
  const targetRole = user.role as UserRole;
  const perms = resolvePermissions(targetRole, user.permissions);
  const hasRate = user.hourlyRateMinor !== null;
  const hoursSummary = periodSheets
    ? (() => {
        const sum = (f: (t: SheetRow) => boolean, g: (t: SheetRow) => number) => periodSheets.filter(f).reduce((a, t) => a + g(t), 0);
        return {
          claimed: sum(() => true, (t) => t.submittedMinutes),
          pending: sum((t) => t.status === "submitted", (t) => t.submittedMinutes),
          notPayable: sum((t) => t.status === "rejected" || t.status === "returned", (t) => t.submittedMinutes),
          pay: totalsByCurrency(payLines(periodSheets)),
          approved: sum((t) => t.status === "approved", (t) => t.approvedMinutes ?? 0),
        };
      })()
    : null;

  return (
    <div className="space-y-6">
      <AdminTabs active="staff" viewer={session} />
      <Link href="/admin/staff" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
        <ChevronLeft className="h-4 w-4" /> All staff
      </Link>

      <PageHero icon={UserCog} eyebrow={ROLE_LABEL[targetRole]} title={user.name} description={user.email} compact>
        <PresenceBadge status={presence.status} />
        <span className="rounded-md bg-white/10 px-3 py-1.5 text-indigo-100 ring-1 ring-white/10">{user.active ? "Account active" : "Account inactive"}</span>
        <span className="rounded-md bg-white/10 px-3 py-1.5 text-indigo-100 ring-1 ring-white/10">Last login: {fmt(user.lastLoginAt, tz)}</span>
        {user.manager && <span className="rounded-md bg-white/10 px-3 py-1.5 text-indigo-100 ring-1 ring-white/10">Supervisor: {user.manager.name}</span>}
      </PageHero>

      {can(session, "staff.manage") && (
        <SectionCard icon={UserCog} tone="violet" title="Account and permissions" description={session.role === "SUPER_ADMIN" ? "Changes are checked on the server and recorded in the audit trail." : "You can activate or deactivate this account and end its sessions."}>
          <div className="p-5">
            <StaffAdminControls
              user={{ id: user.id, name: user.name, role: targetRole, active: user.active, managerId: user.managerId, hourlyRateMinor: user.hourlyRateMinor, rateCurrency: user.rateCurrency }}
              permissions={perms}
              usesRoleDefault={parsePermissions(user.permissions) === null}
              supervisors={supervisors}
              isSelf={user.id === session.userId}
              isSuper={session.role === "SUPER_ADMIN"}
            />
          </div>
        </SectionCard>
      )}

      {canActivity ? (
        <>
          <PeriodControls basePath={`/admin/staff/${id}`} period={period} />
          {periodError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{periodError} Showing the current week instead.</p>}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricTile label="Recorded actions" value={(s?.meaningfulActions ?? 0).toLocaleString()} icon={Activity} tone="blue" hint="searches, CRM, reports, exports" />
            <MetricTile label="Companies worked" value={(s?.companiesWorked ?? 0).toLocaleString()} icon={Briefcase} tone="violet" hint="with a recorded action" />
            <MetricTile label="Contacts logged" value={(s?.contactsLogged ?? 0).toLocaleString()} icon={PhoneCall} tone="emerald" hint={`${s?.contactsReached ?? 0} reached a person`} />
            <MetricTile label="Session time" value={formatDuration(s?.sessionMs ?? 0)} icon={Clock} tone="amber" hint={`${s?.sessions ?? 0} session${s?.sessions === 1 ? "" : "s"} · not verified working time`} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricTile label="Reports created" value={(s?.reportsCreated ?? 0).toLocaleString()} icon={FileText} tone="amber" />
            <MetricTile label="Exports" value={(s?.exports ?? 0).toLocaleString()} icon={FileText} tone="slate" hint="CSV, PDF and Word" />
            <MetricTile label="Follow-ups" value={`${s?.followUpsDone ?? 0} / ${s?.followUpsCreated ?? 0}`} icon={ClipboardList} tone="indigo" hint="completed / created" />
            <MetricTile label="Assigned work done" value={(s?.assignmentsCompleted ?? 0).toLocaleString()} icon={ShieldCheck} tone="emerald" hint={`${s?.failedLogins ?? 0} failed sign-ins`} />
          </div>

          {hoursSummary && (
            <SectionCard icon={Clock} tone="emerald" title="Hours and pay (timesheets)" description={`${period.label} · by work date. Claimed, approved and calculated pay are separate from session time above, which is not working time.`}>
              <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
                <MetricTile label="Claimed" value={formatHours(hoursSummary.claimed)} icon={Clock} tone="slate" hint={`${formatHours(hoursSummary.pending)} waiting · ${formatHours(hoursSummary.notPayable)} rejected/returned`} />
                <MetricTile label="Approved hours" value={formatHours(hoursSummary.approved)} icon={ShieldCheck} tone="emerald" hint="the only hours that reach pay" />
                <MetricTile label="Hourly rate now" value={hasRate ? formatMoney(user.hourlyRateMinor!, user.rateCurrency) : "Not set"} icon={Briefcase} tone="indigo" hint="past approvals keep the rate they were approved at" />
                <MetricTile label="Calculated pay" value={hoursSummary.pay.byCurrency.length ? hoursSummary.pay.byCurrency.map((t) => formatMoney(t.amountMinor, t.currency)).join(" + ") : "—"} icon={FileText} tone="amber" hint={hoursSummary.pay.unratedMinutes ? `${formatHours(hoursSummary.pay.unratedMinutes)} approved without a rate` : "estimate from approved hours, not a payment"} />
              </div>
            </SectionCard>
          )}

          <SectionCard icon={Activity} tone="blue" title="Recorded actions per day" description={`${period.label} · ${period.tz}`}>
            <div className="p-5">{series && <DailyChart points={series} label={`Recorded actions per day for ${user.name}, ${period.label}`} />}</div>
          </SectionCard>

          <div className="grid gap-6 lg:grid-cols-2">
            <SectionCard icon={LogIn} tone="slate" title="Sessions" description="Latest 15. Duration is elapsed session time, not working time. A missing sign-out time is never guessed; last seen and sign-out are shown separately.">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-sm">
                  <thead className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-2 font-semibold">Started</th>
                      <th className="px-4 py-2 font-semibold">Ended / last seen</th>
                      <th className="px-4 py-2 font-semibold">Duration</th>
                      <th className="px-4 py-2 font-semibold">State</th>
                      <th className="px-4 py-2 text-right font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {sessions.map((x) => {
                      const st = sessionStatus(x, now);
                      return (
                        <tr key={x.id}>
                          <td className="px-4 py-2 text-slate-700">{fmt(x.startedAt, tz)}</td>
                          <td className="px-4 py-2 text-slate-600">
                            {x.endedAt ? (
                              <>
                                {x.endReason && x.endReason !== "logout" ? "revoked " : "signed out "}
                                {fmt(x.endedAt, tz)}
                                {x.endReason && x.endReason !== "logout" && <span className="ml-1 text-[11px] text-slate-400">({x.endReason.replace("_", " ")})</span>}
                                <div className="text-[11px] text-slate-400">last seen {fmt(x.lastActivityAt, tz)}</div>
                              </>
                            ) : (
                              <>last seen {fmt(x.lastActivityAt, tz)}</>
                            )}
                            {(() => {
                              const quiet = quietBeforeSignOutMs(x);
                              return quiet !== null && quiet > sessionThresholds().idleMs ? (
                                <div className="text-[11px] font-medium text-amber-700" title="The session stayed open after the last recorded contact. The time in between is elapsed session time, not evidence of work.">
                                  open {formatDuration(quiet)} with nothing recorded before sign-out
                                </div>
                              ) : null;
                            })()}
                          </td>
                          <td className="px-4 py-2 tabular-nums text-slate-700">
                            {formatDuration(sessionDurationMs(x))}
                            {(!x.endedAt || (x.endReason && x.endReason !== "logout")) && <span className="ml-1 text-[11px] text-slate-400">to last seen</span>}
                          </td>
                          <td className="px-4 py-2">
                            <StatusPill tone={st === "active" ? "green" : st === "idle" ? "amber" : "slate"}>{SESSION_STATUS_LABEL[st]}</StatusPill>
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            <Link href={q({ session: x.id, page: undefined, period: "custom", from: startFmt(x.startedAt, tz), to: startFmt(x.lastActivityAt > (x.endedAt ?? x.lastActivityAt) ? x.lastActivityAt : (x.endedAt ?? x.lastActivityAt), tz) })} className="text-indigo-600 hover:underline">
                              {eventsBySession.get(x.id) ?? 0}
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                    {sessions.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-4 text-sm text-slate-400">
                          No sessions recorded. Sign-in tracking started when this feature was introduced; earlier sign-ins have no session record.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </SectionCard>

            <SectionCard icon={Briefcase} tone="violet" title="Companies worked on" description={`Most recorded activity in ${period.label}`}>
              <ul className="divide-y divide-slate-100">
                {worked.map((w) => {
                  const c = nameOf.get(w.companyId);
                  return (
                    <li key={w.companyId} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                      <span className="min-w-0">
                        <Link href={`/companies/${w.companyId}`} className="font-medium text-slate-900 hover:text-indigo-600">
                          {c?.name ?? "Company"}
                        </Link>
                        {c && <span className="ml-2 font-mono text-xs text-slate-400">{c.companyNumber}</span>}
                      </span>
                      <Badge tone="slate">{w.n} action{w.n === 1 ? "" : "s"}</Badge>
                    </li>
                  );
                })}
                {worked.length === 0 && <li className="px-5 py-4 text-sm text-slate-400">No company activity recorded in this period.</li>}
              </ul>
            </SectionCard>
          </div>

          <SectionCard icon={PhoneCall} tone="emerald" title="Recorded contacts" description="Only logged contacts count as contacted. Opening or searching a company does not.">
            <ul className="divide-y divide-slate-100">
              {contacts.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-sm">
                  <span>
                    <Link href={`/companies/${c.company.id}`} className="font-medium text-slate-900 hover:text-indigo-600">
                      {c.company.name}
                    </Link>
                    <span className="ml-2 text-slate-600">
                      {CHANNEL_LABEL[c.channel as ContactChannel]} · {OUTCOME_LABEL[c.outcome as ContactOutcome]}
                    </span>
                  </span>
                  <span className="text-xs text-slate-400">{fmt(c.createdAt, tz)}</span>
                </li>
              ))}
              {contacts.length === 0 && <li className="px-5 py-4 text-sm text-slate-400">No contacts recorded in this period.</li>}
            </ul>
          </SectionCard>

          <section id="timeline" className="scroll-mt-24">
            <SectionCard icon={History} tone="slate" title="Activity timeline" description={`${timelineTotal.toLocaleString()} recorded event${timelineTotal === 1 ? "" : "s"} in ${period.label}${sessionFilter ? " · one session" : ""}`}>
              <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-3 text-xs">
                <span className="font-medium text-slate-500">Show:</span>
                <Link href={q({ cat: undefined, page: undefined })} className={`rounded-full px-2.5 py-1 ${!cat ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                  Everything
                </Link>
                {ACTION_CATEGORY_KEYS.map((k) => (
                  <Link key={k} href={q({ cat: k, page: undefined })} className={`rounded-full px-2.5 py-1 ${cat === k ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                    {CATEGORY_LABEL[k]}
                  </Link>
                ))}
                {sessionFilter && (
                  <Link href={q({ session: undefined, page: undefined })} className="ml-auto text-indigo-600 hover:underline">
                    Clear session filter
                  </Link>
                )}
              </div>
              <ul className="divide-y divide-slate-100">
                {timeline.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 py-2.5 text-sm">
                    <span className="min-w-0 text-slate-800">
                      <Badge tone="slate" className="mr-2">{CATEGORY_LABEL[actionCategory(e.action)]}</Badge>
                      {describeAction(e.action, e.meta)}
                      {e.companyId && (
                        <Link href={`/companies/${e.companyId}`} className="ml-2 text-xs text-indigo-600 hover:underline">
                          open company
                        </Link>
                      )}
                      {e.reportId && (
                        <Link href={`/reports/${e.reportId}`} className="ml-2 text-xs text-indigo-600 hover:underline">
                          open report
                        </Link>
                      )}
                    </span>
                    <span className="text-xs tabular-nums text-slate-400">{fmt(e.createdAt, tz)}</span>
                  </li>
                ))}
                {timeline.length === 0 && <li className="px-5 py-4 text-sm text-slate-400">Nothing recorded for these filters.</li>}
              </ul>
              <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-sm text-slate-500">
                <span>
                  Page {page} of {pageCount}
                </span>
                <span className="flex gap-2">
                  {page > 1 ? <Link href={q({ page: String(page - 1) })} className="rounded-md px-2 py-1 hover:bg-slate-100">Previous</Link> : <span className="px-2 py-1 opacity-40">Previous</span>}
                  {page < pageCount ? <Link href={q({ page: String(page + 1) })} className="rounded-md px-2 py-1 hover:bg-slate-100">Next</Link> : <span className="px-2 py-1 opacity-40">Next</span>}
                </span>
              </div>
            </SectionCard>
          </section>
        </>
      ) : (
        <EmptyPanel icon={Activity} title="Activity is not available to you" description="Viewing sessions and recorded activity needs the “View staff activity” permission." />
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard icon={ClipboardList} tone="amber" title="Work queue" description="Companies assigned to this person.">
          {canAssign && (
            <div className="border-b border-slate-100 p-5">
              <AssignWorkForm assigneeId={id} />
            </div>
          )}
          <ul className="divide-y divide-slate-100">
            {assignments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-sm">
                <span className="min-w-0">
                  <Link href={`/companies/${a.companyId}`} className="font-medium text-slate-900 hover:text-indigo-600">
                    {a.company.name}
                  </Link>
                  <span className="ml-2 text-xs text-slate-500">by {a.assignedBy.name}{a.dueDate ? ` · due ${a.dueDate.toISOString().slice(0, 10)}` : ""}</span>
                </span>
                <StatusPill tone={a.status === "open" ? (a.dueDate && a.dueDate < todayDate ? "red" : "blue") : a.status === "done" ? "green" : "slate"}>
                  {a.status === "open" && a.dueDate && a.dueDate < todayDate ? "Overdue" : a.status === "open" ? "Open" : a.status === "done" ? "Done" : "Cancelled"}
                </StatusPill>
              </li>
            ))}
            {assignments.length === 0 && <li className="px-5 py-4 text-sm text-slate-400">Nothing assigned yet.</li>}
          </ul>
        </SectionCard>

        <div className="space-y-6">
          {canActivity && (
            <SectionCard icon={FileText} tone="amber" title="Reports" description="Most recent saved reports owned by this person.">
              <ul className="divide-y divide-slate-100">
                {reports.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                    {can(session, "reports.viewOthers") ? (
                      <Link href={`/reports/${r.id}`} className="font-medium text-slate-900 hover:text-indigo-600">
                        {r.name}
                      </Link>
                    ) : (
                      <span className="font-medium text-slate-900">{r.name}</span>
                    )}
                    <Badge tone="slate">{r.resultCount.toLocaleString()} results</Badge>
                  </li>
                ))}
                {reports.length === 0 && <li className="px-5 py-4 text-sm text-slate-400">No reports.</li>}
              </ul>
            </SectionCard>
          )}
          {can(session, "timesheets.approve") && (
            <Panel icon={Clock} tone="slate" title="Recent timesheets" right={<Link href="/admin/timesheets" className="text-xs text-indigo-600 hover:underline">Review queue</Link>}>
              {sheets.map((t) => (
                <StatRow key={t.id} label={`${t.workDate.toISOString().slice(0, 10)} · ${TIMESHEET_STATUS_LABEL[t.status] ?? t.status}`}>
                  {t.status === "approved" && t.approvedMinutes !== null ? (
                    <>
                      {formatHours(t.approvedMinutes)}
                      {hasRate && t.rateMinorAtApproval !== null && <span className="ml-2 text-xs font-normal text-slate-500">{formatMoney(payAmountMinor(t.approvedMinutes, t.rateMinorAtApproval), t.rateCurrencyAtApproval ?? user.rateCurrency)}</span>}
                    </>
                  ) : (
                    <>{formatHours(t.submittedMinutes)} claimed</>
                  )}
                </StatRow>
              ))}
              {sheets.length === 0 && <p className="py-2 text-sm text-slate-400">No timesheets.</p>}
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

// YYYY-MM-DD of an instant in the app timezone (used to scope the timeline to one session's days).
function startFmt(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
