import { notFound } from "next/navigation";
import Link from "next/link";
import { Building2, ChevronLeft, ShieldCheck, MapPin, Factory, FileText, Network, Database, CalendarDays, Users } from "lucide-react";
import { cn } from "@/lib/cn";
import { DataSection, Field } from "@/components/companies/WorkspaceSection";
import { getCompanyById } from "@/lib/data/companies";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { Badge } from "@/components/ui/Badge";
import { formatAddress, formatDate, formatDateOnly, STATUS_LABELS, STATUS_TONE, typeLabel, companyAgeYears } from "@/lib/data/format";
import type { CompanyStatus } from "@/lib/types";
import { CompanyDetailClient } from "@/components/companies/CompanyDetailClient";
import type { ContactChannel, ContactOutcome } from "@/lib/staff/contact";
import { parseWorkspaceTab } from "@/lib/data/workspace-tab";
import { getCompanyActivity } from "@/lib/data/company-activity";
import { isRestConfigured } from "@/lib/companies-house/client";
import { ensureDirectorsFetched } from "@/lib/companies-house/sync";
import { maybeSoftRefresh } from "@/lib/companies-house/officerFreshness";
import { loadOfficerConfig } from "@/lib/companies-house/officerQueue";
import { officerFreshness } from "@/lib/data/director-display";
import { profileFetchedAt } from "@/lib/columns/cellRules";
import { recordCompanyView } from "@/lib/data/recently-viewed";
import { can } from "@/lib/auth/permissions";
import { logActivity } from "@/lib/activity";
import { avatarUrl, findAvatar } from "@/lib/avatar";
import { ContactLogPanel } from "@/components/companies/ContactLogPanel";

export default async function CompanyDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = await params;
  const { tab } = await searchParams;
  const [initialCompany, session] = await Promise.all([getCompanyById(id), getSession()]);
  let company = initialCompany;
  if (!company || !session) notFound();
  if (!can(session, "companies.view")) notFound();
  // Officer data is a separate permission: without it nothing is fetched from Companies House on this person's behalf and
  // no director detail is rendered.
  const canDirectors = can(session, "companies.directors");

  // Lazy-fetch (P0, interactive "user" quota class): the first time a real
  // (non-seed) company is viewed and we haven't pulled its officers yet, fetch
  // them now and cache the result. Never attempted for seed/dev companies —
  // their company numbers aren't real, so a live lookup would just 404.
  // Companies already marked "unavailable" are not re-fetched on every view.
  if (canDirectors && company.source !== "seed" && company.officersCoverage === "none" && isRestConfigured()) {
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

  // Soft refresh: confirmed data older than the soft threshold is queued for a
  // background refresh (per-company cooldown = its queue row). The page still
  // shows the last confirmed data, flagged as not freshly verified below.
  if (canDirectors && company.source !== "seed" && isRestConfigured()) {
    await maybeSoftRefresh(company).catch(() => {});
  }
  const officerConfig = loadOfficerConfig();
  const freshness = officerFreshness(company, new Date(), officerConfig.staleAfterDays);

  const status = company.status as CompanyStatus;

  // Recently viewed (per user). Best effort: a failure here must never break the company page.
  await recordCompanyView(session.userId, company.id).catch(() => {});
  // One event per person per company per 30 minutes: reloading or tab-switching is not new work.
  await logActivity(session, "company_viewed", { meta: { companyName: company.name }, companyId: company.id, dedupeMs: 30 * 60_000 });

  const state = await db.userCompanyState.findUnique({
    where: { userId_companyId: { userId: session.userId, companyId: id } },
    include: { notes: { orderBy: { createdAt: "desc" } }, followUps: { orderBy: { dueDate: "asc" } } },
  });

  // CRM contacts are private to this user and separate from CH officers.
  const crmContacts = await db.crmContact.findMany({
    where: { userId: session.userId, companyId: id },
    orderBy: { createdAt: "asc" },
  });

  const activity = await getCompanyActivity(session.userId, id);
  // Same source the app header uses for the signed-in user's picture; notes on this page are all the user's own.
  const avatar = await findAvatar(session.userId).catch(() => null);

  // The signed-in user's own recorded contacts for this company, and any open work assigned to them for it.
  const [contactLog, myAssignments] = await Promise.all([
    db.contactLog.findMany({ where: { userId: session.userId, companyId: id }, orderBy: { createdAt: "desc" }, take: 20 }),
    db.assignment.findMany({ where: { assigneeId: session.userId, companyId: id, status: "open" }, include: { assignedBy: { select: { name: true } } }, orderBy: { createdAt: "desc" } }),
  ]);

  const sic = (company.sicCodes ?? "").split(/[;,|]/).map((x) => x.trim()).filter(Boolean);
  const NOT_PROVIDED = <span className="font-normal text-slate-400">Not provided</span>;
  const directorSummary = !canDirectors
    ? "restricted - you do not have access to director information"
    : freshness === "unavailable"
      ? `unavailable from Companies House (${company.officersUnavailableReason === "company_gone" ? "company not found" : "no officer data published"})`
      : freshness === "none"
        ? "not yet fetched"
        : `${company.directorCount} director${company.directorCount === 1 ? "" : "s"} counted${company.singleDirector ? " (single director)" : ""} · fetched ${formatDate(company.officersFetchedAt)}`;

  const age = companyAgeYears(company.incorporationDate);
  // Relative hint computed only from the real due date; shown for dates not already flagged overdue.
  const dueHint = (d: Date | string | null | undefined, overdue: boolean) => {
    if (!d || overdue) return null;
    const days = Math.round((new Date(d).getTime() - new Date().getTime()) / 86400000);
    if (days < 0) return null;
    return <span className={cn("ml-1.5 text-xs font-normal", days <= 30 ? "text-amber-600" : "text-slate-400")}>{days === 0 ? "due today" : `in ${days.toLocaleString()} day${days === 1 ? "" : "s"}`}</span>;
  };

  // ---- Header (identity + compact indicators). The CRM action toolbar is added by the client component. ----
  const identity = (
    <div className="flex min-w-0 items-start gap-4">
      <span className="mt-0.5 flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white/10 text-white ring-1 ring-white/25">
        <Building2 className="h-6 w-6" />
      </span>
      <div className="min-w-0">
        <h1 className="break-words text-2xl font-bold leading-tight tracking-tight text-white sm:text-3xl">{company.name}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge tone={STATUS_TONE[status]}>{STATUS_LABELS[status]}</Badge>
          {company.dormant && <Badge tone="slate">Dormant</Badge>}
          {company.hasDS01 && <Badge tone="amber">DS01 filed</Badge>}
          {company.accountsOverdue && <Badge tone="red">Late accounts</Badge>}
        </div>
        <p className="mt-2 text-[13px] text-indigo-100">
          Company no. <span className="font-mono font-semibold text-white">{company.companyNumber}</span> · {typeLabel(company.type)} · Incorporated{" "}
          {formatDateOnly(company.incorporationDate)} <span className="text-indigo-200">({age} yrs)</span>
        </p>
      </div>
    </div>
  );

  const indicators: [string, React.ReactNode][] = [
    ["Status", <Badge key="s" tone={STATUS_TONE[status]}>{STATUS_LABELS[status]}</Badge>],
    ["Company type", typeLabel(company.type)],
    ["Incorporated", <>{formatDateOnly(company.incorporationDate)} <span className="font-normal text-slate-400">({age} yrs)</span></>],
    ["Postcode", company.registeredPostcode || NOT_PROVIDED],
    [
      "Directors",
      !canDirectors ? (
        <span key="d" className="font-normal text-slate-400">Restricted</span>
      ) : freshness === "none" ? (
        <span key="d" className="font-normal text-slate-400">Not fetched</span>
      ) : freshness === "unavailable" ? (
        <span key="d" className="font-normal text-slate-400">Unavailable</span>
      ) : (
        <span key="d">
          {company.directorCount}
          {company.singleDirector && <Badge tone="amber" className="ml-1.5">Single</Badge>}
        </span>
      ),
    ],
    [
      "Filing",
      company.accountsOverdue || company.hasDS01 ? (
        <span key="f" className="flex flex-wrap gap-1">
          {company.accountsOverdue && <Badge tone="red">Late accounts</Badge>}
          {company.hasDS01 && <Badge tone="amber">DS01</Badge>}
        </span>
      ) : (
        <span key="f" className="font-normal text-slate-400">Up to date</span>
      ),
    ],
  ];
  const tileIcons = [ShieldCheck, Building2, CalendarDays, MapPin, Users, FileText];
  const kpis = (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {indicators.map(([label, value], i) => {
        const Icon = tileIcons[i];
        return (
          <div key={label} className="min-w-0 rounded-xl border border-slate-200 bg-gradient-to-br from-indigo-50/60 to-white px-3 py-2.5">
            <dt className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              <Icon className="h-3.5 w-3.5 text-indigo-500" aria-hidden /> {label}
            </dt>
            <dd className="mt-1 break-words text-[13px] font-semibold text-slate-900">{value}</dd>
          </div>
        );
      })}
    </dl>
  );

  // ---- Overview: official Companies House data, grouped into compact panels ----
  const overview = {
    identity: (
      <DataSection title="Company identity" icon={Building2}>
        <Field label="Company name">{company.name}</Field>
        <Field label="Registration ID (CRN)">
          <span className="font-mono">{company.companyNumber}</span>
        </Field>
        <Field label="Legal entity type">{typeLabel(company.type)}</Field>
        <Field label="Incorporated">
          {formatDateOnly(company.incorporationDate)} <span className="font-normal text-slate-400">({age} years)</span>
        </Field>
      </DataSection>
    ),
    status: (
      <DataSection title="Status & compliance" icon={ShieldCheck}>
        <Field label="Register status">
          <Badge tone={STATUS_TONE[status]}>{STATUS_LABELS[status]}</Badge>
        </Field>
        <Field label="Status detail">{company.statusDetail ? company.statusDetail.replace(/-/g, " ") : NOT_PROVIDED}</Field>
        <Field label="Dormant">{company.dormant ? "Yes" : "No"}</Field>
        <Field label="Strike-off (DS01)">
          {company.hasDS01 ? <>Filed{company.ds01FiledAt ? ` ${formatDateOnly(company.ds01FiledAt)}` : ""}</> : "None on record"}
        </Field>
        {company.dissolutionDate && <Field label="Dissolved">{formatDateOnly(company.dissolutionDate)}</Field>}
      </DataSection>
    ),
    address: (
      <DataSection title="Registered address" icon={MapPin}>
        <div className="col-span-2">
          <Field label="Address">{formatAddress(company)}</Field>
        </div>
        <Field label="Postcode">{company.registeredPostcode || NOT_PROVIDED}</Field>
        <Field label="Country">United Kingdom</Field>
      </DataSection>
    ),
    industry: (
      <DataSection title="Industry classification" icon={Factory}>
        <div className="col-span-2">
          <Field label="SIC code(s)">
            {sic.length > 0 ? (
              <span className="flex flex-wrap gap-1.5">
                {sic.map((c) => (
                  <Badge key={c} tone="slate">
                    {c}
                  </Badge>
                ))}
              </span>
            ) : (
              NOT_PROVIDED
            )}
          </Field>
        </div>
      </DataSection>
    ),
    accounts: (
      <DataSection title="Accounts & filing" icon={FileText}>
        <Field label="Accounts next due">
          {formatDateOnly(company.accountsNextDue)}
          {dueHint(company.accountsNextDue, company.accountsOverdue)}
          {company.accountsOverdue && (
            <Badge tone="red" className="ml-1.5">
              Overdue
            </Badge>
          )}
        </Field>
        <Field label="Last accounts made up to">{company.accountsLastMadeUp ? formatDateOnly(company.accountsLastMadeUp) : NOT_PROVIDED}</Field>
        <Field label="Confirmation statement due">
          {formatDateOnly(company.confirmationNextDue)}
          {dueHint(company.confirmationNextDue, company.confirmationOverdue)}
          {company.confirmationOverdue && (
            <Badge tone="red" className="ml-1.5">
              Overdue
            </Badge>
          )}
        </Field>
        <Field label="Last confirmation statement">{company.confirmationLastMadeUp ? formatDateOnly(company.confirmationLastMadeUp) : NOT_PROVIDED}</Field>
      </DataSection>
    ),
    officerSummary: (
      <p className="text-[13px] text-slate-700 first-letter:uppercase">
        {directorSummary}
        {freshness === "dirty" && (
          <Badge tone="amber" className="ml-2">
            Officer change filed - update pending
          </Badge>
        )}
        {freshness === "stale" && (
          <Badge tone="slate" className="ml-2">
            Not recently verified
          </Badge>
        )}
        {freshness === "unavailable" && (
          <Badge tone="slate" className="ml-2">
            Not counted as zero
          </Badge>
        )}
      </p>
    ),
    structure: (
      <DataSection title="Corporate structure" icon={Network}>
        <div className="col-span-2">
          <dd className="text-[13px] text-slate-500">Parent and subsidiary data is not available. DIRECTOR.LTD does not currently hold corporate hierarchy or ownership data.</dd>
        </div>
      </DataSection>
    ),
    provenance: (
      <DataSection title="Data provenance" icon={Database}>
        <Field label="Source">
          {company.source === "seed" ? <Badge tone="amber">Development data</Badge> : <Badge tone="green">Companies House ({company.source})</Badge>}
        </Field>
        <Field label="Profile last fetched">{profileFetchedAt(company.source, company.chLastFetchedAt) ? formatDate(profileFetchedAt(company.source, company.chLastFetchedAt)!) : "Not fetched"}</Field>
      </DataSection>
    ),
  };

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-3">
      <Link href="/companies" className="inline-flex items-center gap-1 text-[13px] text-slate-500 hover:text-slate-800">
        <ChevronLeft className="h-4 w-4" /> Back to companies
      </Link>

      <CompanyDetailClient
        companyId={company.id}
        companyName={company.name}
        identity={identity}
        kpis={kpis}
        overview={overview}
        initialTab={parseWorkspaceTab(tab)}
        initialFollowed={state?.followed ?? false}
        initialTrashed={state?.trashed ?? false}
        initialSaved={state?.saved ?? false}
        initialRedFlagged={state?.redFlagged ?? false}
        authorAvatarSrc={avatar ? avatarUrl(session.userId, avatar.mtimeMs) : null}
        officers={(canDirectors ? company.directors : []).map((d) => ({
          id: d.id,
          name: d.name,
          role: d.role,
          occupation: d.occupation,
          appointedOn: d.appointedOn ? d.appointedOn.toISOString() : null,
          resignedOn: d.resignedOn ? d.resignedOn.toISOString() : null,
        }))}
        initialContacts={crmContacts.map((c) => ({
          id: c.id,
          name: c.name,
          role: c.role,
          occupation: c.occupation,
          email: c.email,
          phone: c.phone,
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
        activity={activity}
      />

      <ContactLogPanel
        companyId={company.id}
        canLog={can(session, "crm.notes")}
        entries={contactLog.map((c) => ({ id: c.id, channel: c.channel as ContactChannel, outcome: c.outcome as ContactOutcome, note: c.note, createdAt: c.createdAt.toISOString() }))}
        assignments={myAssignments.map((a) => ({ id: a.id, dueDate: a.dueDate ? a.dueDate.toISOString() : null, note: a.note, assignedByName: a.assignedBy.name }))}
      />
    </div>
  );
}
