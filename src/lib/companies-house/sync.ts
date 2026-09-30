import { db } from "@/lib/db";
import { fetchCompanyProfile, mapProfileToCompanyUpsert } from "./profile";
import {
  fetchCompanyOfficers,
  mapOfficerToDirectorUpsert,
  countActiveDirectors,
  type CompaniesHouseOfficer,
} from "./officers";
import { CompaniesHouseNotFoundError } from "./client";

// Fetches a company's real profile from Companies House and upserts it.
// Used by: REST enrichment after a DS01 stream event, on-demand refresh,
// and (in small batches) the Advanced Search ingest.
export async function syncCompanyProfile(
  companyNumber: string,
  source: "advanced_search" | "bulk_import" | "stream" | "rest_enrichment"
) {
  const profile = await fetchCompanyProfile(companyNumber);
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

// Fetches ALL real officers for a company (every page) and replaces the
// Companies House Director rows + the denormalised directorCount /
// singleDirector / officersCoverage used by the filter engine. CRM contacts
// live in a separate table and are never touched. See officers.ts for what
// counts as a director.
export async function syncCompanyDirectors(companyId: string, companyNumber: string) {
  let officers: CompaniesHouseOfficer[];
  try {
    officers = await fetchCompanyOfficers(companyNumber);
  } catch (err) {
    if (err instanceof CompaniesHouseNotFoundError) {
      officers = [];
    } else {
      throw err;
    }
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
      },
    }),
  ]);

  return activeCount;
}

// Lazy-fetch entry point: called when a company is viewed and its officer
// data has never been fetched.
export async function ensureDirectorsFetched(companyId: string, companyNumber: string, officersCoverage: string) {
  if (officersCoverage === "full") return;
  await syncCompanyDirectors(companyId, companyNumber);
}
