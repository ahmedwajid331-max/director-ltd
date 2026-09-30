import { chRestGetWithRateInfo } from "./client";
import { parseChDate } from "./csv/dates";

// Shape of the real GET /company/{number} response - only the fields we
// actually use. Companies House returns more than this; unused fields are
// intentionally left untyped rather than guessed at.
export interface CompaniesHouseProfile {
  company_name: string;
  company_number: string;
  company_status: string;
  company_status_detail?: string;
  type: string;
  date_of_creation?: string;
  date_of_cessation?: string;
  registered_office_address?: {
    address_line_1?: string;
    address_line_2?: string;
    locality?: string;
    region?: string;
    postal_code?: string;
    country?: string;
  };
  accounts?: {
    next_due?: string;
    next_made_up_to?: string;
    overdue?: boolean;
    last_accounts?: {
      made_up_to?: string;
      type?: string;
    };
  };
  confirmation_statement?: {
    next_due?: string;
    last_made_up_to?: string;
    overdue?: boolean;
  };
  sic_codes?: string[];
}

export async function fetchCompanyProfile(companyNumber: string): Promise<CompaniesHouseProfile> {
  return chRestGetWithRateInfo<CompaniesHouseProfile>(`/company/${encodeURIComponent(companyNumber)}`);
}

export const STRIKE_OFF_STATUS_DETAIL = "active-proposal-to-strike-off";

// Maps a real CH profile response to our Company upsert shape. `dormant`
// is derived strictly from accounts.last_accounts.type - never from
// company_status, per the explicit product requirement.
//
// `existingDs01FiledAt` is the event-derived DS01 date already stored for the
// company (if any). DS01 is sticky: a profile that does not (yet) show the
// strike-off status detail must not erase a DS01 the stream already recorded.
export function mapProfileToCompanyUpsert(
  profile: CompaniesHouseProfile,
  source: "advanced_search" | "bulk_import" | "stream" | "rest_enrichment",
  existingDs01FiledAt: Date | null = null
) {
  const address = profile.registered_office_address ?? {};
  const accountType = profile.accounts?.last_accounts?.type ?? null;
  const incorporationDate = parseChDate(profile.date_of_creation);
  if (!incorporationDate) {
    throw new Error(`Company ${profile.company_number} has no usable date_of_creation`);
  }

  return {
    companyNumber: profile.company_number.toUpperCase(),
    name: profile.company_name,
    status: profile.company_status,
    statusDetail: profile.company_status_detail ?? null,
    type: profile.type,
    incorporationDate,
    dissolutionDate: parseChDate(profile.date_of_cessation),
    dormant: accountType === "dormant",
    accountType,
    registeredAddress1: address.address_line_1 ?? "",
    registeredAddress2: address.address_line_2 ?? null,
    registeredCity: address.locality ?? "",
    registeredPostcode: (address.postal_code ?? "").toUpperCase(),
    registeredCounty: address.region ?? null,
    accountsNextDue: parseChDate(profile.accounts?.next_due),
    accountsLastMadeUp: parseChDate(profile.accounts?.last_accounts?.made_up_to),
    accountsOverdue: profile.accounts?.overdue ?? false,
    confirmationNextDue: parseChDate(profile.confirmation_statement?.next_due),
    confirmationLastMadeUp: parseChDate(profile.confirmation_statement?.last_made_up_to),
    confirmationOverdue: profile.confirmation_statement?.overdue ?? false,
    hasDS01: profile.company_status_detail === STRIKE_OFF_STATUS_DETAIL || existingDs01FiledAt !== null,
    sicCodes: (profile.sic_codes ?? []).join(","),
    source,
    chLastFetchedAt: new Date(),
  };
}
