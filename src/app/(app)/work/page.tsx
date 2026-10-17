import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Briefcase, CheckCircle2 } from "lucide-react";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth/guard";
import { can } from "@/lib/auth/permissions";
import { appTimezone, dayKey } from "@/lib/staff/periods";
import { EmptyPanel, PageHero, HeroChip, SectionCard, StatusPill } from "@/components/admin/AdminUi";
import { WorkTabs } from "@/components/staff/WorkTabs";
import { CompleteAssignmentButton } from "@/components/staff/WorkClients";
import { formatDate } from "@/lib/data/format";

export const metadata: Metadata = { title: "My work" };

export default async function MyWorkPage() {
  const session = await requireSession();
  if (!can(session, "work.assigned")) redirect(can(session, "timesheets.submit") ? "/work/timesheets" : "/dashboard");

  const todayKey = dayKey(new Date(), appTimezone());
  const today = new Date(`${todayKey}T00:00:00.000Z`);
  const [open, done] = await Promise.all([
    db.assignment.findMany({ where: { assigneeId: session.userId, status: "open" }, orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }], include: { company: { select: { id: true, name: true, companyNumber: true } }, assignedBy: { select: { name: true } } } }),
    db.assignment.findMany({ where: { assigneeId: session.userId, status: "done" }, orderBy: { completedAt: "desc" }, take: 10, include: { company: { select: { id: true, name: true, companyNumber: true } } } }),
  ]);
  const overdue = open.filter((a) => a.dueDate && a.dueDate < today).length;

  return (
    <div className="space-y-6">
      <WorkTabs active="work" viewer={session} />
      <PageHero icon={Briefcase} eyebrow="My work" title="Assigned companies" description="Companies your supervisor has asked you to work on. Record contacts on the company page, then mark the work complete." compact accent="emerald">
        <HeroChip label="Open" value={open.length} />
        <HeroChip label="Overdue" value={overdue} dot={overdue > 0 ? "red" : "green"} />
      </PageHero>

      <SectionCard icon={Briefcase} tone="indigo" title={`Open (${open.length})`} description="Oldest due date first.">
        {open.length === 0 ? (
          <div className="p-5">
            <EmptyPanel icon={CheckCircle2} tone="emerald" title="Nothing assigned" description="When a supervisor assigns you a company it appears here." />
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {open.map((a) => {
              const late = !!a.dueDate && a.dueDate < today;
              return (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <Link href={`/companies/${a.company.id}`} className="font-medium text-slate-900 hover:text-indigo-600">
                      {a.company.name}
                    </Link>
                    <span className="ml-2 font-mono text-xs text-slate-400">{a.company.companyNumber}</span>
                    <div className="mt-0.5 text-xs text-slate-500">
                      From {a.assignedBy.name}
                      {a.note ? ` · ${a.note}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {a.dueDate ? <StatusPill tone={late ? "red" : "blue"}>{late ? "Overdue · " : "Due "}{formatDate(a.dueDate)}</StatusPill> : <StatusPill tone="slate">No due date</StatusPill>}
                    <CompleteAssignmentButton id={a.id} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      {done.length > 0 && (
        <SectionCard icon={CheckCircle2} tone="emerald" title="Recently completed" description="Your last 10.">
          <ul className="divide-y divide-slate-100">
            {done.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                <Link href={`/companies/${a.company.id}`} className="text-slate-800 hover:text-indigo-600">
                  {a.company.name}
                </Link>
                <span className="text-xs text-slate-400">{a.completedAt ? formatDate(a.completedAt) : ""}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}
