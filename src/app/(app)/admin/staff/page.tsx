import type { Metadata } from "next";
import Link from "next/link";
import { Users, UserCheck, UserX, Radio, Activity, Search, UserPlus } from "lucide-react";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/auth/permissions";
import { userScopeWhere } from "@/lib/staff/scope";
import { appTimezone, dayKey, startOfDay, addDays } from "@/lib/staff/periods";
import { getLastRecordedActions, getPeriodStats, getPresence, getWorkQueueCounts } from "@/lib/staff/stats";
import { sessionThresholds } from "@/lib/staff/sessions";
import { PageHero, HeroChip, MetricTile, EmptyPanel } from "@/components/admin/AdminUi";
import { AdminTabs } from "@/components/admin/AdminTabs";
import { PresenceBadge } from "@/components/staff/PresenceBadge";
import { Badge } from "@/components/ui/Badge";
import { StatusPill } from "@/components/admin/AdminUi";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Staff" };

const PAGE_SIZE = 20;
const ROLE_LABEL = { USER: "User", ADMIN: "Admin", SUPER_ADMIN: "Super Admin" } as const;

type SP = { q?: string; role?: string; status?: string; signedIn?: string; page?: string };

function when(d: Date | null | undefined) {
  return d ? d.toLocaleString("en-GB", { timeZone: appTimezone(), day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
}

export default async function StaffDirectoryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const session = await requirePermission("staff.view");
  const sp = await searchParams;
  const tz = appTimezone();
  const now = new Date();
  const thresholds = sessionThresholds();

  const q = (sp.q ?? "").trim().slice(0, 80);
  const role = ["USER", "ADMIN", "SUPER_ADMIN"].includes(sp.role ?? "") ? sp.role : undefined;
  const status = sp.status === "active" || sp.status === "inactive" ? sp.status : undefined;
  const signedIn = sp.signedIn === "1";
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  const scope = userScopeWhere(session);
  const where: Prisma.UserWhereInput = {
    AND: [
      scope,
      ...(q ? [{ OR: [{ name: { contains: q, mode: "insensitive" as const } }, { email: { contains: q, mode: "insensitive" as const } }] }] : []),
      ...(role ? [{ role }] : []),
      ...(status ? [{ active: status === "active" }] : []),
      ...(signedIn ? [{ active: true, sessions: { some: { endedAt: null, lastActivityAt: { gt: new Date(now.getTime() - thresholds.idleMs) } } } }] : []),
    ],
  };

  // Headline figures cover everyone in scope, not just the filtered page.
  const scoped = await db.user.findMany({ where: scope, select: { id: true, active: true } });
  const presenceAll = await getPresence(scoped.map((u) => u.id), now);
  const countStatus = (...s: string[]) => scoped.filter((u) => u.active && s.includes(presenceAll.get(u.id)?.status ?? "never")).length;

  const [total, users] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({
      where,
      orderBy: [{ active: "desc" }, { name: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: { id: true, name: true, email: true, role: true, active: true, lastLoginAt: true, manager: { select: { name: true } }, _count: { select: { reports: true } } },
    }),
  ]);
  const ids = users.map((u) => u.id);
  const today = dayKey(now, tz);
  const canActivity = can(session, "staff.activity");
  const [presence, lastActions, todayStats, queues] = await Promise.all([
    getPresence(ids, now),
    getLastRecordedActions(ids),
    canActivity ? getPeriodStats(ids, startOfDay(today, tz), startOfDay(addDays(today, 1), tz)) : Promise.resolve(null),
    getWorkQueueCounts(ids, tz),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const href = (over: Partial<SP>) => {
    const next = { q, role, status, signedIn: signedIn ? "1" : undefined, page: String(page), ...over };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, String(v));
    return `/admin/staff?${p}`;
  };
  const field = "h-9 rounded-lg border border-slate-300 bg-white px-2.5 text-sm text-slate-900 focus-ring focus:border-indigo-400";

  return (
    <div className="space-y-6">
      <AdminTabs active="staff" viewer={session} />
      <PageHero icon={Users} eyebrow={session.role === "SUPER_ADMIN" ? "Super Admin" : "Team"} title="Staff" description="Accounts, sign-in status and recorded activity for the people you manage." compact>
        <HeroChip label="Timezone" value={tz} />
        {can(session, "staff.manage") && (
          <Link href="/users" className="inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 font-semibold text-indigo-800 hover:bg-indigo-50">
            <UserPlus className="h-3.5 w-3.5" /> Create or manage accounts
          </Link>
        )}
      </PageHero>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="Staff accounts" value={scoped.length.toLocaleString()} icon={Users} tone="blue" />
        <MetricTile label="Active accounts" value={scoped.filter((u) => u.active).length.toLocaleString()} icon={UserCheck} tone="emerald" hint={`${scoped.filter((u) => !u.active).length} inactive`} />
        <MetricTile label="Recently active" value={countStatus("active").toLocaleString()} icon={Activity} tone="violet" hint={`seen within ${Math.round(thresholds.activeMs / 60000)} min`} />
        <MetricTile label="Signed in, idle" value={countStatus("idle").toLocaleString()} icon={Radio} tone="amber" hint={`quiet ${Math.round(thresholds.activeMs / 60000)}-${Math.round(thresholds.idleMs / 60000)} min`} />
      </div>
      <p className="-mt-2 text-xs text-slate-500">
        &ldquo;Recently active&rdquo; and &ldquo;Idle&rdquo; describe when a signed-in browser last contacted the app. They do not prove anyone is working. Sessions with no logout and no recent contact are shown as &ldquo;No logout recorded&rdquo;.
      </p>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <label className="text-xs font-medium text-slate-700">
          Search
          <span className="relative mt-1 block">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <input name="q" defaultValue={q} placeholder="Name or email" className={cn(field, "w-56 pl-8")} />
          </span>
        </label>
        <label className="text-xs font-medium text-slate-700">
          Role
          <select name="role" defaultValue={role ?? ""} className={cn(field, "mt-1 block")}>
            <option value="">All roles</option>
            <option value="USER">User</option>
            <option value="ADMIN">Admin</option>
            <option value="SUPER_ADMIN">Super Admin</option>
          </select>
        </label>
        <label className="text-xs font-medium text-slate-700">
          Account
          <select name="status" defaultValue={status ?? ""} className={cn(field, "mt-1 block")}>
            <option value="">Active and inactive</option>
            <option value="active">Active only</option>
            <option value="inactive">Inactive only</option>
          </select>
        </label>
        <label className="flex h-9 items-center gap-2 text-xs font-medium text-slate-700">
          <input type="checkbox" name="signedIn" value="1" defaultChecked={signedIn} className="h-4 w-4 accent-indigo-600" /> Signed in now
        </label>
        <button type="submit" className="h-9 rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 focus-ring">
          Filter
        </button>
        {(q || role || status || signedIn) && (
          <Link href="/admin/staff" className="h-9 self-end py-2 text-sm text-slate-500 hover:text-slate-800">
            Clear
          </Link>
        )}
      </form>

      {users.length === 0 ? (
        <EmptyPanel icon={Users} title="No staff match" description="Try clearing the filters. A supervisor only sees the people in their own team." />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-gradient-to-r from-indigo-50/70 to-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-semibold">Staff member</th>
                  <th className="px-4 py-3 font-semibold">Role</th>
                  <th className="px-4 py-3 font-semibold">Account</th>
                  <th className="px-4 py-3 font-semibold">Session</th>
                  <th className="px-4 py-3 font-semibold">Last login</th>
                  <th className="px-4 py-3 font-semibold">Last recorded action</th>
                  {canActivity && <th className="px-4 py-3 text-right font-semibold">Actions today</th>}
                  <th className="px-4 py-3 text-right font-semibold">Open work</th>
                  <th className="px-4 py-3 text-right font-semibold">Reports</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.map((u) => {
                  const p = presence.get(u.id)!;
                  const q2 = queues.get(u.id)!;
                  return (
                    <tr key={u.id} className="transition-colors even:bg-slate-50/50 hover:bg-indigo-50/40">
                      <td className="px-5 py-3">
                        <Link href={`/admin/staff/${u.id}`} className="font-semibold text-slate-900 hover:text-indigo-600">
                          {u.name}
                          {u.id === session.userId && <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-px text-[10px] font-medium text-slate-500">You</span>}
                        </Link>
                        <div className="truncate text-xs text-slate-500">{u.email}</div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={u.role === "SUPER_ADMIN" ? "indigo" : u.role === "ADMIN" ? "blue" : "slate"}>{ROLE_LABEL[u.role as keyof typeof ROLE_LABEL]}</Badge>
                        {u.manager && <div className="mt-0.5 text-[11px] text-slate-400">Supervisor: {u.manager.name}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill tone={u.active ? "green" : "slate"}>{u.active ? "Active" : "Inactive"}</StatusPill>
                      </td>
                      <td className="px-4 py-3">
                        <PresenceBadge status={p.status} />
                        {p.lastSeenAt && <div className="mt-0.5 text-[11px] text-slate-400">last seen {when(p.lastSeenAt)}</div>}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{u.lastLoginAt ? when(u.lastLoginAt) : "Never"}</td>
                      <td className="px-4 py-3 text-slate-600">{when(lastActions.get(u.id))}</td>
                      {canActivity && <td className="px-4 py-3 text-right tabular-nums text-slate-700">{todayStats?.get(u.id)?.meaningfulActions ?? 0}</td>}
                      <td className="px-4 py-3 text-right tabular-nums">
                        <span className="text-slate-700">{q2.open}</span>
                        {q2.overdue > 0 && <span className="ml-1 text-xs font-medium text-red-600">({q2.overdue} overdue)</span>}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-700">{u._count.reports}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-sm text-slate-500">
            <span>
              {((page - 1) * PAGE_SIZE + 1).toLocaleString()}–{Math.min(total, page * PAGE_SIZE).toLocaleString()} of {total.toLocaleString()}
            </span>
            <span className="flex items-center gap-2">
              {page > 1 ? (
                <Link href={href({ page: String(page - 1) })} className="rounded-md px-2 py-1 hover:bg-slate-100">
                  Previous
                </Link>
              ) : (
                <span className="px-2 py-1 opacity-40">Previous</span>
              )}
              <span>
                Page {page} of {pageCount}
              </span>
              {page < pageCount ? (
                <Link href={href({ page: String(page + 1) })} className="rounded-md px-2 py-1 hover:bg-slate-100">
                  Next
                </Link>
              ) : (
                <span className="px-2 py-1 opacity-40">Next</span>
              )}
            </span>
          </div>
        </div>
      )}
      {!canActivity && (
        <p className="flex items-center gap-1.5 text-xs text-slate-500">
          <UserX className="h-3.5 w-3.5" /> Activity figures need the &ldquo;View staff activity&rdquo; permission.
        </p>
      )}
      <p className="text-xs text-slate-500">
        Recorded for operational monitoring: sign-ins, sign-outs and in-app actions (searches, CRM changes, reports, exports). Staff are told this on the sign-in page and in Settings. Nothing outside the application is tracked.
      </p>
    </div>
  );
}
