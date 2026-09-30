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
// and (in small batches) the bulk-ingest fallback for individual lookups.
export async function syncCompanyProfile(companyNumber: string, source: "bulk_import" | "stream" | "rest_enrichment") {
  const profile = await fetchCompanyProfile(companyNumber);
  const data = mapProfileToCompanyUpsert(profile, source);

  return db.company.upsert({
    where: { companyNumber: data.companyNumber },
    create: { ...data, directorCount: 0, singleDirector: false },
    update: data,
  });
}

// Fetches real officers for a company and syncs Director rows + the
// denormalized directorCount/singleDirector/officersCoverage fields used by
// the filter engine. Never touches manuallyAdded CRM contacts — those stay
// user-owned data, entirely separate from Companies House source data.
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
    db.director.deleteMany({ where: { companyId, manuallyAdded: false } }),
    ...officers.map((officer) => {
      const data = mapOfficerToDirectorUpsert(officer);
      return db.director.create({ data: { ...data, companyId } });
    }),
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
// data has never been fetched. Fire-and-forget friendly — callers should
// not block the page render on this for companies already covered.
export async function ensureDirectorsFetched(companyId: string, companyNumber: string, officersCoverage: string) {
  if (officersCoverage === "full") return;
  await syncCompanyDirectors(companyId, companyNumber);
}
