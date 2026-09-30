import { chRestGetWithRateInfo } from "./client";

export interface CompaniesHouseOfficer {
  name: string;
  officer_role: string;
  appointed_on?: string;
  resigned_on?: string;
  nationality?: string;
  occupation?: string;
  links?: { officer?: { appointments?: string } };
}

interface OfficerListResponse {
  items: CompaniesHouseOfficer[];
  active_count?: number;
  total_results?: number;
}

// The officer's stable Companies House id is only exposed embedded in the
// appointments link, e.g. /officers/AbC123.../appointments — not as a
// flat field on the list item.
function extractOfficerId(officer: CompaniesHouseOfficer): string | null {
  const href = officer.links?.officer?.appointments;
  const match = href?.match(/\/officers\/([^/]+)\/appointments/);
  return match ? match[1] : null;
}

export async function fetchCompanyOfficers(companyNumber: string): Promise<CompaniesHouseOfficer[]> {
  const res = await chRestGetWithRateInfo<OfficerListResponse>(
    `/company/${encodeURIComponent(companyNumber)}/officers`
  );
  return res.items ?? [];
}

export function mapOfficerToDirectorUpsert(officer: CompaniesHouseOfficer) {
  return {
    officerId: extractOfficerId(officer),
    name: officer.name,
    role: officer.officer_role,
    appointedOn: officer.appointed_on ? new Date(officer.appointed_on) : null,
    resignedOn: officer.resigned_on ? new Date(officer.resigned_on) : null,
    nationality: officer.nationality ?? null,
    occupation: officer.occupation ?? null,
    source: "rest" as const,
  };
}

// directorCount/singleDirector only count officers still in post (no
// resigned_on) with an officer_role of "director" — matches how Companies
// House itself defines an active directorship.
export function countActiveDirectors(officers: CompaniesHouseOfficer[]): number {
  return officers.filter((o) => o.officer_role === "director" && !o.resigned_on).length;
}
