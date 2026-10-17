import { chRestGetWithRateInfo, CompaniesHouseApiError } from "./client";
import type { QuotaClass } from "./quota";
import { parseChDate } from "./csv/dates";

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
  items_per_page?: number;
}

// ---------------------------------------------------------------------------
// What counts as a "director" (the definition behind directorCount and the
// "single director" filter). Explicit, not "every officer":
//
//   COUNTED (an active appointment whose role is one of these):
//     director, corporate-director, nominee-director, corporate-nominee-director
//       -> a company's directors, natural or corporate, including nominees
//     llp-member, llp-designated-member, corporate-llp-member,
//     corporate-llp-designated-member
//       -> an LLP has members rather than directors; they fill the same
//          role, so an LLP's member count is its directorCount
//
//   NOT COUNTED: secretary, corporate-secretary, nominee-secretary,
//     corporate-nominee-secretary, judicial-factor, receiver-and-manager,
//     manager-of-a-charitable-incorporated-organisation, and any role not
//     listed above (they are stored and displayed, never counted).
//
//   "Active" = no resigned_on date.
//
// Changing this list changes filter results, so it is the single source of
// truth and is unit-tested.
// ---------------------------------------------------------------------------
export const DIRECTOR_ROLES = new Set([
  "director",
  "corporate-director",
  "nominee-director",
  "corporate-nominee-director",
]);
export const LLP_MEMBER_ROLES = new Set([
  "llp-member",
  "llp-designated-member",
  "corporate-llp-member",
  "corporate-llp-designated-member",
]);

export function countsAsDirector(officer: Pick<CompaniesHouseOfficer, "officer_role" | "resigned_on">): boolean {
  if (officer.resigned_on) return false;
  return DIRECTOR_ROLES.has(officer.officer_role) || LLP_MEMBER_ROLES.has(officer.officer_role);
}

export function countActiveDirectors(officers: CompaniesHouseOfficer[]): number {
  return officers.filter(countsAsDirector).length;
}

// The officer's stable Companies House id is only exposed embedded in the
// appointments link, e.g. /officers/AbC123.../appointments - not as a
// flat field on the list item.
function extractOfficerId(officer: CompaniesHouseOfficer): string | null {
  const href = officer.links?.officer?.appointments;
  const match = href?.match(/\/officers\/([^/]+)\/appointments/);
  return match ? match[1] : null;
}

const PAGE_SIZE = 100; // the API maximum
const MAX_PAGES = 100; // 10,000 officers: a safety stop, never hit by a real company

// Reads EVERY page of a company's officers (the API defaults to 35 per page
// and a large company - e.g. Tesco PLC, 74 officers - spans several).
//
// A 200 response without an `items` array is a malformed answer, not "no
// officers": it throws (retried later) rather than ever producing a confirmed
// zero. A genuine empty list is `items: []`.
export async function fetchCompanyOfficers(
  companyNumber: string,
  options: { quotaClass?: QuotaClass } = {}
): Promise<CompaniesHouseOfficer[]> {
  const all: CompaniesHouseOfficer[] = [];
  let startIndex = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await chRestGetWithRateInfo<OfficerListResponse>(
      `/company/${encodeURIComponent(companyNumber)}/officers`,
      { params: { items_per_page: PAGE_SIZE, start_index: startIndex }, quotaClass: options.quotaClass }
    );
    if (!Array.isArray(res?.items)) {
      throw new CompaniesHouseApiError(`Companies House officers response for ${companyNumber} has no items list`, 502);
    }
    const items = res.items;
    all.push(...items);
    startIndex += items.length;
    const total = res.total_results ?? all.length;
    if (items.length === 0 || all.length >= total) break;
  }
  return all;
}

export function mapOfficerToDirectorUpsert(officer: CompaniesHouseOfficer) {
  return {
    officerId: extractOfficerId(officer),
    name: officer.name,
    role: officer.officer_role,
    appointedOn: officer.appointed_on ? parseChDate(officer.appointed_on) : null,
    resignedOn: officer.resigned_on ? parseChDate(officer.resigned_on) : null,
    nationality: officer.nationality ?? null,
    occupation: officer.occupation ?? null,
    source: "rest" as const,
  };
}
