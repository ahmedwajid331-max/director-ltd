import { db } from "@/lib/db";
import { fetchCompanyProfile, mapProfileToCompanyUpsert } from "./profile";
import {
  fetchCompanyOfficers,
  mapOfficerToDirectorUpsert,
  countActiveDirectors,
  type CompaniesHouseOfficer,
} from "./officers";
import { CompaniesHouseNotFoundError } from "./client";
import type { QuotaClass } from "./quota";

// Fetches a company's real profile from Companies House and upserts it.
// Used by: REST enrichment after a DS01 stream event, on-demand refresh,
// and (in small batches) the Advanced Search ingest.
export async function syncCompanyProfile(
  companyNumber: string,
  source: "advanced_search" | "bulk_import" | "stream" | "rest_enrichment",
  options: { quotaClass?: QuotaClass } = {}
) {
  const profile = await fetchCompanyProfile(companyNumber, { quotaClass: options.quotaClass ?? (source === "stream" ? "stream" : "filing") });
  const existing = await db.company.findUnique({
    where: { companyNumber: profile.company_number.toUpperCase() },
    select: { ds01FiledAt: true },
  });
  const data = mapProfileToCompanyUpsert(profile, source, existing?.ds01FiledAt ?? null);

  return db.company.upsert({
    where: { companyNumber: data.companyNumber },
    create: { ...data, directorCount: 0, singleDirector: false },
    // A REST refresh must not downgrade provenance of a company we already
    // know, nor reset officer-derived fields.
    update: data,
  });
}

// Why a company has no officer data.
export type OfficerUnavailableReason = "no_officer_resource" | "company_gone";

export type OfficerSyncOutcome =
  // Every officer page fetched; directorCount / singleDirector are confirmed
  // (a genuine 200 with zero active directors is full / 0 / not single).
  | { kind: "full"; activeCount: number }
  // Companies House has no officer data. NEVER a confirmed zero.
  | { kind: "unavailable"; reason: OfficerUnavailableReason }
  // 404 for a company whose previously CONFIRMED data we keep untouched. The
  // caller treats this as a (retryable) failure, not as a change of state.
  | { kind: "kept_confirmed" };

// Fetches ALL real officers for a company (every page) and replaces the
// Companies House Director rows + the denormalised directorCount /
// singleDirector / officersCoverage used by the filter engine, in ONE
// transaction. CRM contacts live in a separate table and are never touched.
// See officers.ts for what counts as a director.
//
// 404 handling (never a confirmed zero):
//   officers 404 + profile 200 -> unavailable / no_officer_resource
//   officers 404 + profile 404 -> unavailable / company_gone
//   officers 404 on an already-confirmed company -> state untouched
// Every other failure (429, 5xx, breaker, malformed answer) throws and leaves
// the stored data exactly as it was.
export async function syncCompanyOfficers(
  companyId: string,
  companyNumber: string,
  options: { quotaClass?: QuotaClass } = {}
): Promise<OfficerSyncOutcome> {
  const quotaClass = options.quotaClass ?? "user";
  const startedAt = new Date();
  const existing = await db.company.findUniqueOrThrow({ where: { id: companyId }, select: { officersCoverage: true } });

  let officers: CompaniesHouseOfficer[];
  try {
    officers = await fetchCompanyOfficers(companyNumber, { quotaClass });
  } catch (err) {
    if (!(err instanceof CompaniesHouseNotFoundError)) throw err;
    if (existing.officersCoverage === "full") return { kind: "kept_confirmed" };

    let reason: OfficerUnavailableReason = "no_officer_resource";
    try {
      await fetchCompanyProfile(companyNumber, { quotaClass });
    } catch (profileErr) {
      if (profileErr instanceof CompaniesHouseNotFoundError) reason = "company_gone";
      else throw profileErr;
    }
    await db.$transaction([
      db.company.update({
        where: { id: companyId },
        data: { officersCoverage: "unavailable", officersUnavailableReason: reason, officersFetchedAt: new Date() },
      }),
      db.company.updateMany({ where: { id: companyId, officersDirtyAt: { lte: startedAt } }, data: { officersDirtyAt: null } }),
      db.officerSyncJob.deleteMany({ where: { companyId } }),
    ]);
    return { kind: "unavailable", reason };
  }

  const activeCount = countActiveDirectors(officers);

  await db.$transaction([
    db.director.deleteMany({ where: { companyId } }),
    db.director.createMany({ data: officers.map((o) => ({ ...mapOfficerToDirectorUpsert(o), companyId })) }),
    db.company.update({
      where: { id: companyId },
      data: {
        directorCount: activeCount,
        singleDirector: activeCount === 1,
        officersCoverage: "full",
        officersFetchedAt: new Date(),
        officersUnavailableReason: null,
      },
    }),
    // An officer filing seen while this fetch was in flight leaves the company
    // dirty (it may not be in the data we just read); anything older is now
    // covered.
    db.company.updateMany({ where: { id: companyId, officersDirtyAt: { lte: startedAt } }, data: { officersDirtyAt: null } }),
    db.officerSyncJob.deleteMany({ where: { companyId } }),
  ]);

  return { kind: "full", activeCount };
}

// Backwards-compatible wrapper: the confirmed active-director count, or null
// when the company has no officer data (unavailable) or nothing changed.
export async function syncCompanyDirectors(companyId: string, companyNumber: string, options: { quotaClass?: QuotaClass } = {}): Promise<number | null> {
  const outcome = await syncCompanyOfficers(companyId, companyNumber, options);
  return outcome.kind === "full" ? outcome.activeCount : null;
}

// Lazy-fetch entry point (P0): called when a company is viewed and its
// officer data has never been fetched. Charged to the interactive "user"
// quota class. "unavailable" companies are NOT re-fetched on every view (that
// would burn two requests per page view); the freshness sweep re-checks them.
export async function ensureDirectorsFetched(companyId: string, companyNumber: string, officersCoverage: string) {
  if (officersCoverage !== "none") return;
  await syncCompanyOfficers(companyId, companyNumber, { quotaClass: "user" });
}
