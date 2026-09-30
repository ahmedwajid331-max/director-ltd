import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { getCompanyById } from "@/lib/data/companies";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { Badge } from "@/components/ui/Badge";
import { formatAddress, formatDate, STATUS_LABELS, STATUS_TONE, typeLabel, companyAgeYears } from "@/lib/data/format";
import type { CompanyStatus } from "@/lib/types";
import { CompanyDetailClient } from "@/components/companies/CompanyDetailClient";
import { isRestConfigured } from "@/lib/companies-house/client";
import { ensureDirectorsFetched } from "@/lib/companies-house/sync";

export default async function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [initialCompany, session] = await Promise.all([getCompanyById(id), getSession()]);
  let company = initialCompany;
  if (!company || !session) notFound();

  // Lazy-fetch: the first time a real (non-seed) company is viewed and we
  // haven't pulled its officers yet, fetch them now and cache the result.
  // Never attempted for seed/dev companies — their company numbers aren't
  // real, so a live lookup would just 404 and wipe the synthetic directors.
  if (company.source !== "seed" && company.officersCoverage !== "full" && isRestConfigured()) {
    try {
      await ensureDirectorsFetched(company.id, company.companyNumber, company.officersCoverage);
      company = await getCompanyById(id);
      if (!company) notFound();
    } catch {
      // Companies House unavailable/rate-limited — render with whatever
      // director data we already have rather than breaking the page.
    }
  }
  if (!company) notFound();

  const status = company.status as CompanyStatus;

  const state = await db.userCompanyState.findUnique({
    where: { userId_companyId: { userId: session.userId, companyId: id } },
    include: { notes: { orderBy: { createdAt: "desc" } }, followUps: { orderBy: { dueDate: "asc" } } },
  });

  return (
    <div className="space-y-6">
      <Link href="/companies" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
        <ChevronLeft className="h-4 w-4" /> Back to companies
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-slate-900">{company.name}</h1>
            <Badge tone={STATUS_TONE[status]}>{STATUS_LABELS[status]}</Badge>
            {company.dormant && <Badge tone="slate">Dormant</Badge>}
            {company.hasDS01 && <Badge tone="amber">DS01 filed</Badge>}
          </div>
          <p className="mt-1 text-sm text-slate-500">
            Company number {company.companyNumber} · {typeLabel(company.type)} · Incorporated{" "}
            {formatDate(company.incorporationDate)} ({companyAgeYears(company.incorporationDate)} yrs)
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-400">
            {company.source === "seed" ? (
              <Badge tone="amber">Development data</Badge>
            ) : (
              <Badge tone="green">Companies House ({company.source})</Badge>
            )}
            <span>
              Director data:{" "}
              {company.officersCoverage === "full"
                ? `fetched ${formatDate(company.officersFetchedAt)}`
                : "not yet fetched"}
            </span>
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Registered address</p>
          <p className="mt-1 text-sm text-slate-700">{formatAddress(company)}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Accounts</p>
          <p className="mt-1 text-sm text-slate-700">
            Next due {formatDate(company.accountsNextDue)}
            {company.accountsOverdue && (
              <Badge tone="red" className="ml-2">
                Overdue
              </Badge>
            )}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Confirmation statement</p>
          <p className="mt-1 text-sm text-slate-700">
            Next due {formatDate(company.confirmationNextDue)}
            {company.confirmationOverdue && (
              <Badge tone="red" className="ml-2">
                Overdue
              </Badge>
            )}
          </p>
        </div>
      </div>

      <CompanyDetailClient
        companyId={company.id}
        initialFollowed={state?.followed ?? false}
        initialTrashed={state?.trashed ?? false}
        initialDirectors={company.directors.map((d) => ({
          id: d.id,
          name: d.name,
          role: d.role,
          occupation: d.occupation,
          email: d.email,
          phone: d.phone,
          manuallyAdded: d.manuallyAdded,
          appointedOn: d.appointedOn ? d.appointedOn.toISOString() : null,
        }))}
        initialNotes={(state?.notes ?? []).map((n) => ({
          id: n.id,
          body: n.body,
          authorName: n.authorName,
          createdAt: n.createdAt.toISOString(),
        }))}
        initialFollowUps={(state?.followUps ?? []).map((f) => ({
          id: f.id,
          dueDate: f.dueDate.toISOString(),
          note: f.note,
          done: f.done,
        }))}
      />
    </div>
  );
}
