import type { Metadata } from "next";
import Link from "next/link";
import { Clock, ClipboardCheck, Wallet } from "lucide-react";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth/guard";
import { userScopeWhere } from "@/lib/staff/scope";
import { appTimezone, addDays, resolvePeriod, startOfDay, type PeriodResult } from "@/lib/staff/periods";
import { utcTs } from "@/lib/staff/stats";
import { MEANINGFUL_ACTIONS } from "@/lib/staff/actions";
import { TIMESHEET_STATUS_LABEL, evidenceWarnings, payLines, totalsByCurrency } from "@/lib/staff/timesheet";
import { PeriodControls } from "@/components/staff/PeriodControls";
import { formatDuration, sessionTimeInWindow } from "@/lib/staff/sessions";
import { formatHours, formatMoney, payAmountMinor } from "@/lib/staff/money";
import { EmptyPanel, PageHero, SectionCard, StatusPill } from "@/components/admin/AdminUi";
import { AdminTabs } from "@/components/admin/AdminTabs";
import { TimesheetAmendRow, TimesheetReviewRow } from "@/components/staff/TimesheetReviewRow";

export const metadata: Metadata = { title: "Timesheets" };

const ymd = (d: Date) => d.toISOString().slice(0, 10);

// Review queue. Three different numbers are shown side by side and never merged: what the person CLAIMED, what the
// application RECORDED as session time that day (evidence, not hours worked), and what the supervisor APPROVES (the only
// figure pay is based on). Pay shown is approved time x the rate captured at approval - an indication for payroll, not a payment.
type SP = { period?: string; anchor?: string; from?: string; to?: string };

export default async function TimesheetsAdminPage({ searchParams }: { searchParams: Promise<SP> }) {
  const session = await requirePermission("timesheets.approve");
  const sp = await searchParams;
  const tz = appTimezone();
  const now = new Date();
  const resolved = resolvePeriod({ kind: sp.period ?? "month", anchor: sp.anchor || undefined, from: sp.from, to: sp.to }, now, tz);
  const period = (resolved.ok ? resolved : (resolvePeriod({ kind: "month" }, now, tz) as Extract<PeriodResult, { ok: true }>)).period;
  const scope = userScopeWhere(session);

  const [pending, history] = await Promise.all([
    db.timesheet.findMany({ where: { status: "submitted", user: { AND: [scope, { id: { not: session.userId } }] } }, orderBy: { workDate: "asc" }, take: 100, include: { user: { select: { id: true, name: true, hourlyRateMinor: true, rateCurrency: true } } } }),
    db.timesheet.findMany({ where: { status: { in: ["approved", "rejected", "returned"] }, user: scope }, orderBy: { reviewedAt: "desc" }, take: 30, include: { user: { select: { id: true, name: true, rateCurrency: true } }, reviewedBy: { select: { name: true } } } }),
  ]);

  // Recorded session time on each claimed day, per person (one query for the whole queue).
  const ids = [...new Set(pending.map((p) => p.userId))];
  const days = pending.map((p) => ymd(p.workDate));
  const minDay = days.reduce((a, b) => (a < b ? a : b), days[0] ?? "");
  const maxDay = days.reduce((a, b) => (a > b ? a : b), days[0] ?? "");
  const sessions = pending.length
    ? await db.userSession.findMany({
        where: { userId: { in: ids }, startedAt: { lt: startOfDay(addDays(maxDay, 1), tz) }, OR: [{ endedAt: { gte: startOfDay(minDay, tz) } }, { endedAt: null, lastActivityAt: { gte: startOfDay(minDay, tz) } }] },
        select: { userId: true, startedAt: true, lastActivityAt: true, endedAt: true, endReason: true },
      })
    : [];

  // Meaningful recorded actions per person per day (app timezone) for the queue: evidence to read next to the claim.
  const actionRows = pending.length
    ? await db.$queryRaw<{ userId: string; day: string; n: number }[]>(
        Prisma.sql`SELECT "userId", to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n FROM "ActivityLog"
          WHERE "userId" IN (${Prisma.join(ids)}) AND "createdAt" >= ${utcTs(startOfDay(minDay, tz))} AND "createdAt" < ${utcTs(startOfDay(addDays(maxDay, 1), tz))} AND "action" IN (${Prisma.join(MEANINGFUL_ACTIONS)})
          GROUP BY 1, 2`
      )
    : [];
  const actionsOn = new Map(actionRows.map((r) => [`${r.userId}|${r.day}`, r.n]));

  // Payroll estimate: APPROVED sheets only, work dates inside the chosen period, grouped by the rate captured at approval.
  const periodDates = { gte: new Date(`${period.fromDay}T00:00:00.000Z`), lte: new Date(`${period.toDay}T00:00:00.000Z`) };
  const [paid, awaiting] = await Promise.all([
    db.timesheet.groupBy({ by: ["userId", "rateMinorAtApproval", "rateCurrencyAtApproval"], where: { status: "approved", workDate: periodDates, user: scope }, _sum: { approvedMinutes: true } }),
    db.timesheet.groupBy({ by: ["status"], where: { status: { in: ["submitted", "returned", "rejected"] }, workDate: periodDates, user: scope }, _count: { _all: true } }),
  ]);
  const lines = payLines(paid.map((g) => ({ userId: g.userId, status: "approved", approvedMinutes: g._sum.approvedMinutes ?? 0, rateMinorAtApproval: g.rateMinorAtApproval, rateCurrencyAtApproval: g.rateCurrencyAtApproval })));
  const totals = totalsByCurrency(lines);
  const payNames = lines.length ? await db.user.findMany({ where: { id: { in: [...new Set(lines.map((l) => l.userId))] } }, select: { id: true, name: true } }) : [];
  const nameOf = new Map(payNames.map((u) => [u.id, u.name]));

  return (
    <div className="space-y-6">
      <AdminTabs active="timesheets" viewer={session} />
      <PageHero icon={Clock} eyebrow={session.role === "SUPER_ADMIN" ? "Super Admin" : "Team"} title="Timesheets" description="Approve the hours staff report. Nothing is approved automatically, and login time is never treated as hours worked. Session time and recorded actions are evidence to read next to the claim, not proof of work." compact />

      <SectionCard icon={ClipboardCheck} tone="amber" title={`Waiting for review (${pending.length})`} description="You cannot review your own timesheet.">
        {pending.length === 0 ? (
          <div className="p-5">
            <EmptyPanel icon={ClipboardCheck} tone="emerald" title="Nothing waiting" description="Submitted timesheets from your team appear here." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2.5 font-semibold">Staff member</th>
                  <th className="px-3 py-2.5 font-semibold">Day</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Claimed</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Recorded evidence that day</th>
                  <th className="px-3 py-2.5 font-semibold">Note</th>
                  <th className="px-3 py-2.5 font-semibold">Review</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pending.map((p) => {
                  const day = ymd(p.workDate);
                  const recorded = sessionTimeInWindow(sessions.filter((s) => s.userId === p.userId), startOfDay(day, tz), startOfDay(addDays(day, 1), tz));
                  return (
                    <tr key={p.id} className="align-top">
                      <td className="px-5 py-3">
                        <Link href={`/admin/staff/${p.userId}`} className="font-medium text-slate-900 hover:text-indigo-600">
                          {p.user.name}
                        </Link>
                        <div className="text-[11px] text-slate-400">{p.user.hourlyRateMinor === null ? "no rate set" : `${formatMoney(p.user.hourlyRateMinor, p.user.rateCurrency)} / hour`}</div>
                      </td>
                      <td className="px-3 py-3 tabular-nums text-slate-700">{day}</td>
                      <td className="px-3 py-3 text-right tabular-nums font-semibold text-slate-900">{formatHours(p.submittedMinutes)}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-slate-600">
                        <div>{recorded > 0 ? `${formatDuration(recorded)} signed in` : "no session recorded"}</div>
                        <div className="text-[11px] text-slate-500">{actionsOn.get(`${p.userId}|${day}`) ?? 0} recorded actions</div>
                        {evidenceWarnings({ claimedMinutes: p.submittedMinutes, sessionMs: recorded, recordedActions: actionsOn.get(`${p.userId}|${day}`) ?? 0 }).map((w) => (
                          <div key={w} className="text-[11px] font-medium text-amber-700">{w}</div>
                        ))}
                      </td>
                      <td className="max-w-56 px-3 py-3 text-slate-600">{p.note ?? "—"}</td>
                      <td className="px-3 py-3">
                        <TimesheetReviewRow id={p.id} submittedMinutes={p.submittedMinutes} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard icon={Clock} tone="slate" title="Recently reviewed" description="Pay indication = approved time × the hourly rate captured when it was approved. Amending an approved day keeps that rate and records the original decision in the audit trail.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-2 font-semibold">Staff member</th>
                <th className="px-3 py-2 font-semibold">Day</th>
                <th className="px-3 py-2 text-right font-semibold">Claimed</th>
                <th className="px-3 py-2 text-right font-semibold">Approved</th>
                <th className="px-3 py-2 text-right font-semibold">Pay indication</th>
                <th className="px-3 py-2 font-semibold">Decision</th>
                <th className="px-3 py-2 font-semibold">By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {history.map((h) => (
                <tr key={h.id}>
                  <td className="px-5 py-2 text-slate-800">{h.user.name}</td>
                  <td className="px-3 py-2 tabular-nums text-slate-600">{ymd(h.workDate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{formatHours(h.submittedMinutes)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium text-slate-900">{h.approvedMinutes !== null ? formatHours(h.approvedMinutes) : "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                    {h.approvedMinutes !== null && h.rateMinorAtApproval !== null ? formatMoney(payAmountMinor(h.approvedMinutes, h.rateMinorAtApproval), h.rateCurrencyAtApproval ?? h.user.rateCurrency) : h.status === "approved" ? <span className="text-xs text-slate-400">no rate set</span> : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill tone={h.status === "approved" ? "green" : h.status === "rejected" ? "red" : "amber"}>{TIMESHEET_STATUS_LABEL[h.status] ?? h.status}</StatusPill>
                    {h.reviewNote && <div className="mt-0.5 text-[11px] text-slate-500">{h.reviewNote}</div>}
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {h.reviewedBy?.name ?? "—"}
                    {h.status === "approved" && h.approvedMinutes !== null && h.userId !== session.userId && <TimesheetAmendRow id={h.id} submittedMinutes={h.submittedMinutes} approvedMinutes={h.approvedMinutes} />}
                  </td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-4 text-sm text-slate-400">
                    No timesheets reviewed yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <PeriodControls basePath="/admin/timesheets" period={period} />
      <SectionCard icon={Wallet} tone="emerald" title={`Payroll estimate · ${period.label}`} description="Calculated from APPROVED hours only, at the hourly rate captured when each day was approved. This is a calculation, not a payment: nothing here has been paid.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-2 font-semibold">Staff member</th>
                <th className="px-3 py-2 text-right font-semibold">Approved hours</th>
                <th className="px-3 py-2 text-right font-semibold">Hourly rate</th>
                <th className="px-3 py-2 text-right font-semibold">Calculated amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="px-5 py-2 text-slate-800">{nameOf.get(l.userId) ?? "Staff member"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{formatHours(l.approvedMinutes)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{l.rateMinor === null || l.currency === null ? <span className="text-xs text-slate-400">no rate set</span> : formatMoney(l.rateMinor, l.currency)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium text-slate-900">{l.amountMinor === null || l.currency === null ? "—" : formatMoney(l.amountMinor, l.currency)}</td>
                </tr>
              ))}
              {lines.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-5 py-4 text-sm text-slate-400">
                    No approved hours with work dates in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="space-y-1 border-t border-slate-100 px-5 py-3 text-sm text-slate-700">
          {totals.byCurrency.map((t) => (
            <div key={t.currency} className="flex justify-between">
              <span>Total {t.currency} ({formatHours(t.approvedMinutes)} approved)</span>
              <span className="font-semibold tabular-nums">{formatMoney(t.amountMinor, t.currency)}</span>
            </div>
          ))}
          {totals.unratedMinutes > 0 && <p className="text-xs text-amber-700">{formatHours(totals.unratedMinutes)} approved without a pay rate set - not priced. Set a rate on the account, then amend the day to re-price it.</p>}
          <p className="text-xs text-slate-500">
            Different currencies are never added together. Not included: {awaiting.length ? awaiting.map((a) => `${a._count._all} ${a.status}`).join(", ") : "nothing else pending"} in this period. Each amount is rounded once per rate to the nearest penny/cent.
          </p>
        </div>
      </SectionCard>
    </div>
  );
}
