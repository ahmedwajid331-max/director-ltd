import type { Metadata } from "next";
import { Building2, Star, BellRing, BookMarked, ArrowRight } from "lucide-react";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth/guard";
import { StatCard } from "@/components/ui/StatCard";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatDate } from "@/lib/data/format";
import { REAL_COMPANIES_WHERE, seedDataVisible, visibleCompaniesWhere } from "@/lib/data/scope";
import { coverageLabel } from "@/lib/jobs/display";

export const metadata: Metadata = { title: "Overview" };

function greeting(name: string) {
  const hour = new Date().getHours();
  const time = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return `${time}, ${name.split(" ")[0]}`;
}

export default async function DashboardPage() {
  const session = await requireSession();
  const weekFromNow = new Date();
  weekFromNow.setDate(weekFromNow.getDate() + 7);

  const [companiesStored, realCompanies, followedCount, dueFollowUps, savedReports, recentActivity] = await Promise.all([
    db.company.count({ where: visibleCompaniesWhere() }),
    db.company.count({ where: REAL_COMPANIES_WHERE }),
    db.userCompanyState.count({ where: { userId: session.userId, followed: true } }),
    db.followUp.count({ where: { userId: session.userId, done: false, dueDate: { lte: weekFromNow } } }),
    db.report.count({ where: { ownerId: session.userId } }),
    db.activityLog.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">Company monitoring</p>
          <h2 className="text-2xl font-semibold text-slate-900">{greeting(session.name)}</h2>
          <p className="mt-1 text-sm text-slate-500">Here&apos;s what&apos;s happening across your companies.</p>
        </div>
        <LinkButton href="/companies">
          Find a company <ArrowRight className="h-4 w-4" />
        </LinkButton>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Companies searchable" value={companiesStored.toLocaleString()} icon={Building2} accent="indigo" />
        <StatCard label="Followed companies" value={followedCount.toLocaleString()} icon={Star} accent="amber" />
        <StatCard label="Follow-ups due (7 days)" value={dueFollowUps.toLocaleString()} icon={BellRing} accent="emerald" />
        <StatCard label="Saved reports" value={savedReports.toLocaleString()} icon={BookMarked} accent="slate" />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Recent activity</h3>
            <p className="text-xs text-slate-500">Your latest searches, reports and CRM actions.</p>
          </div>
        </div>
        {recentActivity.length === 0 ? (
          <EmptyState
            title="No activity recorded yet"
            description="Activity appears here as you search, save reports and manage companies."
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {recentActivity.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between px-5 py-3 text-sm">
                <span className="text-slate-700">{describeAction(entry.action, entry.meta)}</span>
                <span className="text-xs text-slate-400">{formatDate(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-5 py-4 text-xs text-slate-500">
        <>
          Companies House coverage: {coverageLabel(realCompanies)}.
          {seedDataVisible() && companiesStored > realCompanies
            ? ` ${(companiesStored - realCompanies).toLocaleString()} of the companies shown are synthetic development data, not Companies House.`
            : ""}
        </>{" "}
        See <a href="/settings" className="font-medium text-indigo-600 hover:text-indigo-700">Settings</a> for
        pipeline status.
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
    case "company_follow_toggle":
      return `${data.followed ? "Followed" : "Unfollowed"} ${data.companyName}`;
    case "company_trash_toggle":
      return `${data.trashed ? "Sent to trash" : "Restored"} ${data.companyName}`;
    case "search":
      return `Searched${data.q ? ` "${data.q}"` : ""}${data.activeRules ? ` with ${data.activeRules} filter${data.activeRules > 1 ? "s" : ""}` : ""} (${data.total} results)`;
    case "export_csv":
      return `Exported ${data.rows ?? "?"} companies to CSV`;
    case "director_contact_added":
      return `Added contact "${data.name}"`;
    default:
      return action;
  }
}
