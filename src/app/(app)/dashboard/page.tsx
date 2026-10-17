import { getDataFreshness } from "@/lib/data/freshness";
import type { Metadata } from "next";
import Link from "next/link";
import { Search, Building2, CheckCircle2, XCircle, Users, Star, Bookmark, Flag, BellRing, BookMarked, ArrowRight, CalendarClock, Eye, Activity, History } from "lucide-react";
import { SectionHeader, sectionCard } from "@/components/companies/WorkspaceSection";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth/guard";
import { can } from "@/lib/auth/permissions";
import { autoRefreshState, autoRefreshText } from "@/lib/reports/autoRefresh";
import { Badge } from "@/components/ui/Badge";
import { formatDate, formatDateOnly } from "@/lib/data/format";
import { getRegisterBreakdown } from "@/lib/data/companies";
import { listRecentlyViewed } from "@/lib/data/recently-viewed";
import { effectiveStatus } from "@/lib/jobs/runs";
import { describeFilter } from "@/lib/filters/describe";

export const metadata: Metadata = { title: "Dashboard" };

function greeting(name: string) {
  const hour = new Date().getHours();
  const time = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return `${time}, ${name.split(" ")[0]}`;
}

export default async function DashboardPage() {
  const session = await requireSession();
  const userId = session.userId;
  const weekFromNow = new Date();
  weekFromNow.setDate(weekFromNow.getDate() + 7);
  const startOfToday = new Date(new Date().toDateString());

  const [register, followed, saved, redFlagged, dueSoon, overdue, nextFollowUps, reportCount, reports, lastDaily, streamRun, checkpoint, recentActivity, recentlyViewed] =
    await Promise.all([
      getRegisterBreakdown(),
      db.userCompanyState.count({ where: { userId, followed: true } }),
      db.userCompanyState.count({ where: { userId, saved: true, trashed: false } }),
      db.userCompanyState.count({ where: { userId, redFlagged: true, trashed: false } }),
      db.followUp.count({ where: { userId, done: false, dueDate: { gte: startOfToday, lte: weekFromNow } } }),
      db.followUp.count({ where: { userId, done: false, dueDate: { lt: startOfToday } } }),
      db.followUp.findMany({
        where: { userId, done: false },
        orderBy: { dueDate: "asc" },
        take: 6,
        include: { userCompanyState: { include: { company: { select: { id: true, name: true } } } } },
      }),
      db.report.count({ where: { ownerId: userId } }),
      db.report.findMany({ where: { ownerId: userId }, orderBy: { lastRunAt: { sort: "desc", nulls: "last" } }, take: 5 }),
      db.ingestionRun.findFirst({ where: { kind: "daily_update", status: { in: ["success", "partial"] } }, orderBy: { startedAt: "desc" }, select: { finishedAt: true } }),
      db.ingestionRun.findFirst({ where: { kind: "stream" }, orderBy: { startedAt: "desc" } }),
      db.streamCheckpoint.findUnique({ where: { name: "filings" } }),
      db.activityLog.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 8 }),
      listRecentlyViewed(userId, 8),
    ]);

  const realCompanies = register.total;
  const streamStatus = streamRun ? effectiveStatus(streamRun) : "never";
  // When the company data was last synchronised from Companies House (monthly file / new-registrations sync).
  const lastUpdated = (await getDataFreshness()).lastUpdated;

  // ---- presentation helpers (no data / status logic changes) ----
  // Semantic accents. Full class names so Tailwind picks them up.
  const KPI = {
    blue: { tint: "from-indigo-50", chip: "bg-indigo-600", mark: "text-indigo-200/70", bar: "bg-indigo-500", track: "bg-indigo-100", text: "text-indigo-700" },
    green: { tint: "from-emerald-50", chip: "bg-emerald-600", mark: "text-emerald-200/70", bar: "bg-emerald-500", track: "bg-emerald-100", text: "text-emerald-700" },
    red: { tint: "from-red-50", chip: "bg-red-500", mark: "text-red-200/70", bar: "bg-red-500", track: "bg-red-100", text: "text-red-600" },
    violet: { tint: "from-violet-50", chip: "bg-violet-600", mark: "text-violet-200/70", bar: "bg-violet-500", track: "bg-violet-100", text: "text-violet-700" },
  } as const;
  type Kpi = keyof typeof KPI;

  const CRM = {
    sky: "bg-sky-100 text-sky-700",
    blue: "bg-indigo-100 text-indigo-700",
    red: "bg-red-100 text-red-600",
    amber: "bg-amber-100 text-amber-700",
    violet: "bg-violet-100 text-violet-700",
  } as const;

  // Real share of the register (value / total). Tiny shares are shown honestly, never rounded up.
  const share = (n: number) => (register.total > 0 ? (n / register.total) * 100 : 0);
  const shareLabel = (n: number) => {
    const p = share(n);
    return p === 0 ? "0%" : p < 0.01 ? "<0.01%" : p < 10 ? `${p.toFixed(2)}%` : `${p.toFixed(1)}%`;
  };

  const registerTiles: { label: string; value: number; icon: typeof Building2; href?: string; kpi: Kpi; share?: boolean }[] = [
    { label: "UK companies on the register", value: register.total, icon: Building2, href: "/companies", kpi: "blue" },
    { label: "Active", value: register.active, icon: CheckCircle2, kpi: "green", share: true },
    { label: "Dissolved", value: register.dissolved, icon: XCircle, kpi: "red", share: true },
    { label: "With confirmed director data", value: register.directorsConfirmed, icon: Users, kpi: "violet", share: true },
  ];
  // Each tile links to an area with its own permission; people without it do not see a tile that leads nowhere.
  const allTiles: { label: string; value: number; icon: typeof Star; href: string; alert?: string; tone: keyof typeof CRM; show: boolean }[] = [
    { label: "Followed", value: followed, icon: Star, href: "/watches", tone: "sky", show: can(session, "crm.manage") },
    { label: "Saved companies", value: saved, icon: Bookmark, href: "/saved", tone: "blue", show: can(session, "crm.manage") },
    { label: "Red-flagged", value: redFlagged, icon: Flag, href: "/red-flags", tone: "red", show: can(session, "crm.manage") },
    { label: "Follow-ups due in 7 days", value: dueSoon, icon: BellRing, href: "/calendar", alert: overdue > 0 ? `${overdue} overdue` : undefined, tone: "amber", show: can(session, "calendar.use") },
    { label: "Saved reports", value: reportCount, icon: BookMarked, href: "/reports", tone: "violet", show: can(session, "reports.viewOwn") },
  ];
  const tiles = allTiles.filter((t) => t.show);
  const canCreateReport = can(session, "reports.create");

  // Presentation of the EXISTING status values only: live = green, not yet run = amber, failed = red.
  const streamTone = streamStatus === "running" ? "green" : streamStatus === "never" ? "slate" : streamStatus === "failed" ? "red" : "amber";
  const dailyTone = lastDaily?.finishedAt ? "green" : "amber";
  const healthy = streamTone === "green" && dailyTone === "green";
  const DOT = { green: "bg-emerald-400", amber: "bg-amber-400", red: "bg-red-400", slate: "bg-slate-400" } as const;

  const empty = (Icon: typeof Building2, text: string, link?: { href: string; label: string }) => (
    <div className="flex items-center gap-3 px-4 py-5">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-400">
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="text-[13px] text-slate-500">{text}</p>
        {link && (
          <Link href={link.href} className="mt-0.5 inline-block text-xs font-medium text-indigo-600 hover:underline">
            {link.label} →
          </Link>
        )}
      </div>
    </div>
  );
  const linkCls = "text-xs font-medium text-indigo-600 hover:underline";
  const monthShort = (d: Date) => d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });

  return (
    <div className="w-full space-y-5">
      {/* ---------------- HERO ---------------- */}
      <header
        className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-950 via-indigo-900 to-indigo-700 px-6 py-8 text-white shadow-lg shadow-indigo-950/20 sm:px-10 sm:py-10"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(135deg, var(--color-indigo-950), var(--color-indigo-900) 55%, var(--color-indigo-700))",
          backgroundSize: "36px 36px, 36px 36px, auto",
        }}
      >
        {/* abstract data-network accent: decorative only */}
        <svg aria-hidden className="pointer-events-none absolute -right-10 -top-16 hidden h-[26rem] w-[26rem] text-white/10 lg:block" viewBox="0 0 400 400" fill="none" stroke="currentColor" strokeWidth="1.2">
          <circle cx="200" cy="200" r="190" />
          <circle cx="200" cy="200" r="140" />
          <circle cx="200" cy="200" r="90" />
          <path d="M200 10v380M10 200h380M65 65l270 270M335 65L65 335" strokeOpacity=".5" />
          <g fill="currentColor" stroke="none">
            <circle cx="200" cy="10" r="5" />
            <circle cx="335" cy="65" r="5" />
            <circle cx="390" cy="200" r="5" />
            <circle cx="140" cy="200" r="4" />
            <circle cx="290" cy="290" r="4" />
          </g>
        </svg>
        <div className="relative grid grid-cols-1 items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]">
          <div className="min-w-0">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-indigo-100 ring-1 ring-white/15">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden /> Dashboard
            </span>
            <h2 className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">{greeting(session.name)}</h2>
            <p className="mt-2 max-w-xl text-[15px] text-indigo-100">Your UK company data, saved reports and follow-ups at a glance.</p>
            <div className="mt-5 flex flex-wrap gap-2 text-xs">
              {[
                ["Source", "Companies House"],
                ["Registration ID", "Company number"],
                ["Last updated", lastUpdated ? formatDate(lastUpdated) : "—"],
              ].map(([k, v]) => (
                <span key={k} className="rounded-md bg-white/10 px-3 py-1.5 text-indigo-200 ring-1 ring-white/10">
                  {k}: <span className="font-semibold text-white">{v}</span>
                </span>
              ))}
            </div>
          </div>
          <form
            action="/companies"
            method="get"
            className="flex w-full items-center gap-2 rounded-2xl bg-white p-2 pl-5 shadow-xl shadow-indigo-950/30 ring-4 ring-white/10 focus-within:ring-white/30"
          >
            <Search className="h-5 w-5 shrink-0 text-slate-400" />
            <input
              name="q"
              aria-label="Search UK companies"
              placeholder="Name, number or postcode…"
              className="min-w-0 flex-1 bg-transparent py-3 text-[15px] text-slate-900 outline-none placeholder:text-slate-400"
            />
            <button type="submit" aria-label="Search" className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-700 sm:px-5">
              <span className="hidden sm:inline">Search</span> <ArrowRight className="h-4 w-4" />
            </button>
          </form>
        </div>
      </header>

      {/* ---------------- REGISTER METRICS ---------------- */}
      <section aria-label="UK company register" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {registerTiles.map(({ label, value, icon: Icon, href, kpi, share: showShare }) => {
          const c = KPI[kpi];
          const body = (
            <div className={`relative h-full overflow-hidden rounded-xl border border-slate-200 bg-gradient-to-br ${c.tint} to-white p-4 shadow-sm transition-shadow hover:shadow-md`}>
              <Icon aria-hidden className={`absolute -right-3 -top-3 h-20 w-20 ${c.mark}`} strokeWidth={1.25} />
              <div className="relative">
                <span className={`flex h-9 w-9 items-center justify-center rounded-xl text-white shadow-sm ${c.chip}`}>
                  <Icon className="h-[18px] w-[18px]" />
                </span>
                <p className="mt-3 text-[28px] font-bold leading-none tabular-nums tracking-tight text-slate-900 sm:text-3xl">{value.toLocaleString()}</p>
                <p className="mt-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
                <div className="mt-3 flex items-center gap-2">
                  {showShare ? (
                    <>
                      <span className={`h-1.5 flex-1 overflow-hidden rounded-full ${c.track}`} role="img" aria-label={`${shareLabel(value)} of the register`}>
                        <span className={`block h-full rounded-full ${c.bar}`} style={{ width: `${Math.max(share(value), share(value) > 0 ? 1.5 : 0)}%` }} />
                      </span>
                      <span className={`text-[11px] font-semibold tabular-nums ${c.text}`}>{shareLabel(value)}</span>
                    </>
                  ) : (
                    <span className={`text-[11px] font-semibold ${c.text}`}>Companies House register</span>
                  )}
                </div>
              </div>
            </div>
          );
          return href ? (
            <Link key={label} href={href} className="block">
              {body}
            </Link>
          ) : (
            <div key={label}>{body}</div>
          );
        })}
      </section>

      {/* ---------------- CRM COMMAND STRIP ---------------- */}
      <section aria-label="Your CRM" className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 shadow-sm md:grid-cols-3 xl:grid-cols-5">
        {tiles.map(({ label, value, icon: Icon, href, alert, tone }, i) => (
          <Link
            key={label}
            href={href}
            className={`group flex items-center gap-3 bg-white px-4 py-3 transition-colors hover:bg-slate-50 ${i === tiles.length - 1 ? "col-span-2 md:col-span-2 xl:col-span-1" : ""}`}
          >
            <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${CRM[tone]}`}>
              <Icon className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0">
              <p className="flex items-baseline gap-2">
                <span className="text-2xl font-bold leading-none tabular-nums tracking-tight text-slate-900">{value.toLocaleString()}</span>
                {alert && <span className="rounded bg-red-50 px-1.5 py-px text-[10px] font-bold text-red-600">{alert}</span>}
              </p>
              <p className="mt-1 text-xs leading-tight text-slate-500">{label}</p>
            </div>
          </Link>
        ))}
      </section>

      {/* ---------------- OPERATIONAL PANELS ---------------- */}
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-3">
        <section className={`${sectionCard} min-w-0 overflow-hidden`}>
          <SectionHeader title="Recently viewed" icon={Eye} source="none" />
          {recentlyViewed.length === 0 ? (
            empty(Eye, "Companies you open appear here, newest first.", { href: "/companies", label: "Browse UK companies" })
          ) : (
            <ul className="divide-y divide-slate-100">
              {recentlyViewed.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-[11px] font-bold text-indigo-600">{c.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase() || "•"}</span>
                  <Link href={`/companies/${c.id}`} className="min-w-0 flex-1 truncate font-medium text-slate-900 hover:text-indigo-700">
                    {c.name}
                  </Link>
                  <span className="shrink-0 text-xs text-slate-400">{formatDate(c.viewedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={`${sectionCard} min-w-0 overflow-hidden`}>
          <SectionHeader title="Follow-ups" icon={CalendarClock} source="none" right={can(session, "calendar.use") ? <Link href="/calendar" className={linkCls}>Open calendar</Link> : undefined} />
          {nextFollowUps.length === 0 ? (
            empty(CalendarClock, "No open follow-ups. Schedule one from any company record.", { href: "/companies", label: "Find a company" })
          ) : (
            <ul className="divide-y divide-slate-100">
              {nextFollowUps.map((f) => {
                const isOverdue = f.dueDate < startOfToday;
                return (
                  <li key={f.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <span
                      className={`flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded-lg leading-none ${isOverdue ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-700"}`}
                      aria-hidden
                    >
                      <span className="text-sm font-bold tabular-nums">{f.dueDate.getUTCDate()}</span>
                      <span className="mt-0.5 text-[9px] font-semibold uppercase tracking-wide">{monthShort(f.dueDate)}</span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <Link href={`/companies/${f.userCompanyState.company.id}`} className="block truncate font-medium text-slate-900 hover:text-indigo-700">
                        {f.userCompanyState.company.name}
                      </Link>
                      <p className={isOverdue ? "text-[11px] font-semibold text-red-600" : "text-[11px] text-slate-500"}>
                        {formatDateOnly(f.dueDate)}
                        {isOverdue && " · overdue"}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Data status: monitoring-style panel (dark surface, status dots). Values come from the existing status logic. */}
        <section className="min-w-0 overflow-hidden rounded-lg border border-indigo-950 bg-indigo-950 text-white shadow-sm">
          <header className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
            <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-indigo-100">
              <span className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-white/10 text-indigo-200" aria-hidden>
                <Activity className="h-3.5 w-3.5" />
              </span>
              Data status
            </h3>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${healthy ? "bg-emerald-400/15 text-emerald-300" : "bg-amber-400/15 text-amber-300"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${healthy ? "bg-emerald-400" : "bg-amber-400"}`} aria-hidden />
              {healthy ? "Healthy" : "Check pipeline"}
            </span>
          </header>
          <dl className="divide-y divide-white/10 text-sm">
            {(
              [
                ["Companies House register", `${realCompanies.toLocaleString()} companies loaded`, "green"],
                ["Last automatic daily update", lastDaily?.finishedAt ? formatDate(lastDaily.finishedAt) : "Has not run yet", dailyTone],
                ["Live filing stream", streamStatus === "running" ? "Connected" : streamStatus === "never" ? "Not started" : streamStatus, streamTone],
                ["Last filing event received", checkpoint?.lastEventAt ? formatDate(checkpoint.lastEventAt) : "—", checkpoint?.lastEventAt ? "green" : "slate"],
              ] as const
            ).map(([k, v, tone]) => (
              <div key={k} className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5">
                <dt className="text-[13px] text-indigo-200">{k}</dt>
                <dd className="flex items-center justify-end gap-2 text-right text-[13px] font-semibold">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[tone]}`} aria-hidden />
                  {v}
                </dd>
              </div>
            ))}
          </dl>
          <p className="border-t border-white/10 px-4 py-2 text-[11px] text-indigo-300">
            Filing events (strike-off DS01 / DS02) update companies as they are filed. <Link href="/settings" className="font-medium text-white underline-offset-2 hover:underline">Pipeline details</Link>
          </p>
        </section>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-3">
        <section className={`${sectionCard} min-w-0 overflow-hidden xl:col-span-2`}>
          <SectionHeader
            title="Saved reports"
            icon={BookMarked}
            source="none"
            right={
              <div className="flex gap-4">
                {canCreateReport && <Link href="/reports/new" className={linkCls}>Create report</Link>}
                {can(session, "reports.viewOwn") && <Link href="/reports" className={linkCls}>View all</Link>}
              </div>
            }
          />
          {reports.length === 0 ? (
            empty(BookMarked, "No saved reports yet. Search, add filters, then save the result as a report that refreshes daily.", canCreateReport ? { href: "/reports/new", label: "Create a report" } : undefined)
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-[13px]">
                <thead className="border-b border-slate-100 bg-slate-50/60 text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Report</th>
                    <th className="px-4 py-2 font-semibold">Criteria</th>
                    <th className="px-4 py-2 text-right font-semibold">Companies</th>
                    <th className="px-4 py-2 font-semibold">Daily refresh</th>
                    <th className="px-4 py-2 font-semibold">Last automatic update</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {reports.map((r) => {
                    let criteria = "";
                    try {
                      criteria = describeFilter(JSON.parse(r.filterJson));
                    } catch {
                      criteria = "";
                    }
                    return (
                      <tr key={r.id} className="hover:bg-indigo-50/40">
                        <td className="px-4 py-2.5">
                          <Link href={`/reports/${r.id}`} className="font-semibold text-indigo-700 hover:underline">
                            {r.name}
                          </Link>
                        </td>
                        <td className="max-w-md truncate px-4 py-2.5 text-slate-500" title={criteria}>{criteria || "All companies"}</td>
                        <td className="px-4 py-2.5 text-right font-medium tabular-nums">{r.resultCount.toLocaleString()}</td>
                        <td className="px-4 py-2.5">
                          <Badge tone={r.dailyRefresh ? "green" : "slate"}>{r.dailyRefresh ? "ON" : "OFF"}</Badge>
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">
                          {autoRefreshText(autoRefreshState(r), formatDate)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className={`${sectionCard} min-w-0 overflow-hidden`}>
          <SectionHeader title="Recent activity" icon={History} source="none" />
          {recentActivity.length === 0 ? (
            empty(History, "Activity appears here as you search, save reports and manage companies.")
          ) : (
            <ul className="divide-y divide-slate-100">
              {recentActivity.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-slate-700">{describeAction(entry.action, entry.meta)}</span>
                  <span className="shrink-0 text-xs text-slate-400">{formatDate(entry.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function describeAction(action: string, meta: string | null): string {
  const data = meta ? JSON.parse(meta) : {};
  switch (action) {
    case "login":
      return "Signed in";
    case "report_created":
      return `Created report "${data.name}"`;
    case "report_updated":
      return `Updated report "${data.name}"`;
    case "company_follow_toggle":
      return `${data.followed ? "Followed" : "Unfollowed"} ${data.companyName}`;
    case "company_trash_toggle":
      return `${data.trashed ? "Sent to trash" : "Restored"} ${data.companyName}`;
    case "company_state_change": {
      const changes = (["saved", "followed", "trashed", "redFlagged"] as const)
        .filter((k) => data[k] !== undefined)
        .map((k) => `${data[k] ? "set" : "cleared"} ${k === "redFlagged" ? "red flag" : k}`);
      return `${data.companyName ?? `${data.count} companies`}: ${changes.join(", ")}`;
    }
    case "search":
      return `Searched${data.q ? ` "${data.q}"` : ""}${data.activeRules ? ` with ${data.activeRules} filter${data.activeRules > 1 ? "s" : ""}` : ""} (${data.total} results)`;
    case "export_csv":
      return `Exported ${data.rows ?? "?"} companies to CSV`;
    case "director_contact_added":
      return `Added contact "${data.name}"`;
    case "contact_edited":
      return `Updated contact "${data.name}"`;
    case "contact_deleted":
      return `Removed contact "${data.name}"`;
    case "note_added":
      return "Added a note";
    case "note_edited":
      return "Edited a note";
    case "note_deleted":
      return "Deleted a note";
    case "followup_created":
      return `Scheduled a follow-up${data.dueDate ? ` for ${formatDateOnly(data.dueDate)}` : ""}`;
    case "followup_done":
      return "Completed a follow-up";
    case "followup_reopened":
      return "Reopened a follow-up";
    default:
      return action;
  }
}
