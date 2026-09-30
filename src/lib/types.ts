// Domain enums as TS union types (SQLite has no native Prisma enum
// support, so these are plain `String` columns in schema.prisma
// constrained only at the application layer). Swapping the datasource to
// Postgres later can promote these to real Prisma enums without touching
// application code.

export type UserRole = "SUPER_ADMIN" | "ADMIN" | "USER";

// The real Companies House `company_status` enum (confirmed against the
// official api-enumerations reference — companieshouse/api-enumerations).
// Do not add invented values here; anything CH doesn't use won't appear in
// real ingested data.
export type CompanyStatus =
  | "active"
  | "dissolved"
  | "liquidation"
  | "receivership"
  | "converted-closed"
  | "voluntary-arrangement"
  | "insolvency-proceedings"
  | "administration"
  | "open"
  | "closed"
  | "registered"
  | "removed";

// Companies House's real `company_type` enum has ~35 values (private
// unlimited companies, protected cell companies, overseas establishments,
// etc). Company.type stores whatever raw string CH gives us — this is
// only the curated subset offered in the filter UI dropdown; anything else
// still matches via the "contains" operator.
export type CommonCompanyType =
  | "ltd"
  | "plc"
  | "llp"
  | "limited-partnership"
  | "private-unlimited"
  | "community-interest-company"
  | "scottish-partnership"
  | "uk-establishment"
  | "other";

// Real accounts.last_accounts.type values (account_type enum). "dormant"
// is what Company.dormant is derived from — never from company_status.
export type AccountType =
  | "full"
  | "small"
  | "medium"
  | "group"
  | "dormant"
  | "interim"
  | "initial"
  | "total-exemption-full"
  | "total-exemption-small"
  | "partial-exemption"
  | "audit-exemption-subsidiary"
  | "filing-exemption-subsidiary"
  | "micro-entity"
  | "no-accounts-type-available"
  | "audited-abridged"
  | "unaudited-abridged";

export type CompanyDataSource = "seed" | "bulk_import" | "stream" | "rest_enrichment";

export type OfficersCoverage = "none" | "partial" | "full";

export type CalendarProviderName = "GOOGLE" | "MICROSOFT" | "INTERNAL";

export type CalendarConnectionStatus = "CONNECTED" | "DISCONNECTED" | "ERROR";
