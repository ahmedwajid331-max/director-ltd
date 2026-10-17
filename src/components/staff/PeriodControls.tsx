import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, type ResolvedPeriod } from "@/lib/staff/periods";

// Filter bar for the staff reports. A plain GET form, so the chosen period / person is in the URL (shareable, bookmarkable,
// and handled entirely on the server) and works without client JavaScript. The week starts on Monday and every day is a
// calendar day in the configured timezone, which the period label states.
export function PeriodControls({
  basePath,
  period,
  staff,
  staffId,
  roleFilter,
  teams,
  teamId,
  extra,
}: {
  basePath: string;
  period: ResolvedPeriod;
  staff?: { id: string; name: string }[];
  staffId?: string;
  roleFilter?: string; // when defined the Role filter is shown
  teams?: { id: string; name: string }[]; // supervisors, for the Team filter (Super Admin only)
  teamId?: string;
  extra?: Record<string, string | undefined>; // other params to carry (e.g. the user id on a profile)
}) {
  const carry = Object.entries(extra ?? {}).filter(([, v]) => v);
  const link = (anchor: string) => {
    const q = new URLSearchParams({ period: period.kind, anchor });
    if (staffId) q.set("staff", staffId);
    if (roleFilter) q.set("role", roleFilter);
    if (teamId) q.set("team", teamId);
    for (const [k, v] of carry) q.set(k, v!);
    return `${basePath}?${q}`;
  };
  const steppable = period.kind !== "custom";
  const field = "h-9 rounded-lg border border-slate-300 bg-white px-2.5 text-sm text-slate-900 focus-ring focus:border-indigo-400";
  return (
    <form method="get" action={basePath} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      {carry.map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-medium text-slate-700">
          Period
          <select name="period" defaultValue={period.kind} className={`${field} mt-1 block`}>
            <option value="day">Daily</option>
            <option value="week">Weekly (Mon-Sun)</option>
            <option value="month">Monthly</option>
            <option value="year">Annual</option>
            <option value="custom">Custom range</option>
          </select>
        </label>
        <label className="text-xs font-medium text-slate-700">
          Date in period
          <input type="date" name="anchor" defaultValue={period.kind === "custom" ? "" : period.fromDay} className={`${field} mt-1 block`} />
        </label>
        <label className="text-xs font-medium text-slate-700">
          Custom from
          <input type="date" name="from" defaultValue={period.kind === "custom" ? period.fromDay : ""} className={`${field} mt-1 block`} />
        </label>
        <label className="text-xs font-medium text-slate-700">
          Custom to
          <input type="date" name="to" defaultValue={period.kind === "custom" ? period.toDay : ""} className={`${field} mt-1 block`} />
        </label>
        {staff && (
          <label className="text-xs font-medium text-slate-700">
            Staff member
            <select name="staff" defaultValue={staffId ?? ""} className={`${field} mt-1 block max-w-56`}>
              <option value="">Everyone in scope</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {roleFilter !== undefined && (
          <label className="text-xs font-medium text-slate-700">
            Role
            <select name="role" defaultValue={roleFilter} className={`${field} mt-1 block`}>
              <option value="">All roles</option>
              <option value="USER">Users</option>
              <option value="ADMIN">Admins</option>
              <option value="SUPER_ADMIN">Super Admins</option>
            </select>
          </label>
        )}
        {teams && teams.length > 0 && (
          <label className="text-xs font-medium text-slate-700">
            Team (supervisor)
            <select name="team" defaultValue={teamId ?? ""} className={`${field} mt-1 block max-w-56`}>
              <option value="">All teams</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" className="h-9 rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 focus-ring">
          Apply
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="flex items-center gap-1">
          {steppable && (
            <Link href={link(addDays(period.fromDay, -1))} aria-label="Previous period" className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100">
              <ChevronLeft className="h-4 w-4" />
            </Link>
          )}
          <span className="font-semibold text-slate-900">{period.label}</span>
          {steppable && (
            <Link href={link(addDays(period.toDay, 1))} aria-label="Next period" className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100">
              <ChevronRight className="h-4 w-4" />
            </Link>
          )}
        </div>
        <span className="text-xs text-slate-500">Times are in {period.tz}. Days run midnight to midnight; weeks run Monday to Sunday.</span>
      </div>
    </form>
  );
}
