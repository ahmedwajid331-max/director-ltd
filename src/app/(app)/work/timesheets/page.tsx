import type { Metadata } from "next";
import { Clock } from "lucide-react";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth/guard";
import { addDays, appTimezone, dayKey } from "@/lib/staff/periods";
import { formatHours } from "@/lib/staff/money";
import { TIMESHEET_STATUS_LABEL } from "@/lib/staff/timesheet";
import { PageHero, SectionCard, StatusPill } from "@/components/admin/AdminUi";
import { WorkTabs } from "@/components/staff/WorkTabs";
import { TimesheetForm } from "@/components/staff/WorkClients";

export const metadata: Metadata = { title: "My timesheets" };

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export default async function MyTimesheetsPage() {
  const session = await requirePermission("timesheets.submit");
  const today = dayKey(new Date(), appTimezone());
  const sheets = await db.timesheet.findMany({ where: { userId: session.userId }, orderBy: { workDate: "desc" }, take: 31 });

  return (
    <div className="space-y-6">
      <WorkTabs active="timesheets" viewer={session} />
      <PageHero icon={Clock} eyebrow="My work" title="My timesheets" description="Tell your supervisor how long you worked each day. They approve the hours; nothing is approved or paid automatically." compact accent="emerald" />

      <SectionCard icon={Clock} tone="indigo" title="Submit hours" description="One entry per day. A rejected or returned day can be corrected and sent again; an approved day can only be amended by your supervisor.">
        <div className="p-5">
          <TimesheetForm today={today} minDate={addDays(today, -62)} />
        </div>
      </SectionCard>

      <SectionCard icon={Clock} tone="slate" title="Your submissions" description="Last 31 entries.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-2 font-semibold">Day</th>
                <th className="px-3 py-2 text-right font-semibold">You claimed</th>
                <th className="px-3 py-2 text-right font-semibold">Approved</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Supervisor note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sheets.map((t) => (
                <tr key={t.id}>
                  <td className="px-5 py-2 tabular-nums text-slate-800">{ymd(t.workDate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{formatHours(t.submittedMinutes)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium text-slate-900">{t.approvedMinutes !== null ? formatHours(t.approvedMinutes) : "—"}</td>
                  <td className="px-3 py-2">
                    <StatusPill tone={t.status === "approved" ? "green" : t.status === "rejected" ? "red" : "amber"}>{TIMESHEET_STATUS_LABEL[t.status] ?? t.status}</StatusPill>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{t.reviewNote ?? "—"}</td>
                </tr>
              ))}
              {sheets.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-4 text-sm text-slate-400">
                    No timesheets yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
