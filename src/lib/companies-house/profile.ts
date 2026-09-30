import { chRestGetWithRateInfo } from "./client";

// Shape of the real GET /company/{number} response — only the fields we
// actually use. Companies House returns more than this; unused fields are
// intentionally left untyped rather than guessed at.
export interface CompaniesHouseProfile {
  company_name: string;
  company_number: string;
  company_status: string;
  company_status_detail?: string;
  type: string;
  date_of_creation: string;
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
    overdue?: boolean;
  };
  sic_codes?: string[];
}

export async function fetchCompanyProfile(companyNumber: string): Promise<CompaniesHouseProfile> {
  return chRestGetWithRateInfo<CompaniesHouseProfile>(`/company/${encodeURIComponent(companyNumber)}`);
}

// Maps a real CH profile response to our Company upsert shape. `dormant`
// is derived strictly from accounts.last_accounts.type — never from
// company_status, per the explicit product requirement.
export function mapProfileToCompanyUpsert(profile: CompaniesHouseProfile, source: "bulk_import" | "stream" | "rest_enrichment") {
  const address = profile.registered_office_address ?? {};
  const accountType = profile.accounts?.last_accounts?.type ?? null;

  return {
    companyNumber: profile.company_number,
    name: profile.company_name,
    status: profile.company_status,
    statusDetail: profile.company_status_detail ?? null,
    type: profile.type,
    incorporationDate: new Date(profile.date_of_creation),
    dissolutionDate: profile.date_of_cessation ? new Date(profile.date_of_cessation) : null,
    dormant: accountType === "dormant",
    accountType,
    registeredAddress1: address.address_line_1 ?? "",
    registeredAddress2: address.address_line_2 ?? null,
    registeredCity: address.locality ?? "",
    registeredPostcode: address.postal_code ?? "",
    registeredCounty: address.region ?? null,
    accountsNextDue: profile.accounts?.next_due ? new Date(profile.accounts.next_due) : null,
    accountsLastMadeUp: profile.accounts?.last_accounts?.made_up_to
      ? new Date(profile.accounts.last_accounts.made_up_to)
      : null,
    accountsOverdue: profile.accounts?.overdue ?? false,
    confirmationNextDue: profile.confirmation_statement?.next_due
      ? new Date(profile.confirmation_statement.next_due)
      : null,
    confirmationOverdue: profile.confirmation_statement?.overdue ?? false,
    hasDS01: profile.company_status_detail === "active-proposal-to-strike-off",
    sicCodes: (profile.sic_codes ?? []).join(","),
    source,
    chLastFetchedAt: new Date(),
  };
}
