import type { Company } from "@prisma/client";
import { companyAgeYears, formatAddress, formatDateOnly, STATUS_LABELS, typeLabel } from "@/lib/data/format";
import { directorCsvCells } from "@/lib/data/director-display";
import { OFFICER_UNAVAILABLE_REASON, dormantState, ds01DateState, overdueState, postcodeArea, prettySlug, profileFetchedAt, sicList, statusDetailState, accountsState, type YesNoState } from "./cellRules";
import type { CompanyStatus } from "@/lib/types";

// Server-side CSV cell for every displayable field, in the same wording as the on-screen table. Pure functions of the
// company row (plus, for the four CRM markers, the signed-in user's own state for that company). Nothing here queries
// the database or calls Companies House per company.

export interface ExportContext {
  now: Date;
  staleAfterDays: number;
  // The signed-in user's own markers for this company (only needed for the CRM columns).
  crm?: { followed: boolean; saved: boolean; redFlagged: boolean; trashed: boolean };
}

interface ExportColumn {
  header: string; // identical to the table's column heading (unit-tested)
  value: (c: Company, x: ExportContext) => string | number;
  crm?: true;
}

const PUBLIC_COMPANY_URL = "https://find-and-update.company-information.service.gov.uk/company";
const d = (v: Date | null | undefined) => (v ? formatDateOnly(v) : "");
const yn = (b: boolean) => (b ? "Yes" : "No");
const state = (s: YesNoState) => ({ yes: "Yes", no: "No", unknown: "Unknown", not_applicable: "Not applicable" })[s];
const officer = (c: Company, x: ExportContext) => directorCsvCells(c, x.now, x.staleAfterDays);

export const EXPORT_COLUMNS: Record<string, ExportColumn> = {
  name: { header: "Company", value: (c) => c.name },
  companyNumber: { header: "Company No.", value: (c) => c.companyNumber },
  status: { header: "Status", value: (c) => STATUS_LABELS[c.status as CompanyStatus] ?? c.status },
  type: { header: "Type", value: (c) => (c.type ? typeLabel(c.type) : "") },
  incorporationDate: { header: "Incorporated", value: (c) => d(c.incorporationDate) },
  registeredCity: { header: "City / town", value: (c) => c.registeredCity },
  registeredPostcode: { header: "Postcode", value: (c) => c.registeredPostcode },
  directorCount: { header: "Directors", value: (c, x) => officer(c, x)[0] },
  filingSummary: { header: "Filing", value: (c) => [c.hasDS01 ? "DS01 filed" : "", c.accountsOverdue ? "Late accounts" : ""].filter(Boolean).join(" + ") || "None" },

  statusDetail: { header: "Status detail", value: (c) => (c.statusDetail ? prettySlug(c.statusDetail) : statusDetailState(c.source) === "none_recorded" ? "None recorded" : "Not fetched") },
  companyAgeYears: { header: "Age", value: (c, x) => companyAgeYears(c.incorporationDate, x.now) },
  dissolutionDate: { header: "Dissolved", value: (c) => (c.status === "dissolved" ? d(c.dissolutionDate) : "Not applicable") },
  chLink: { header: "Companies House", value: (c) => `${PUBLIC_COMPANY_URL}/${encodeURIComponent(c.companyNumber)}` },

  registeredAddress1: { header: "Address line 1", value: (c) => c.registeredAddress1 ?? "" },
  registeredAddress2: { header: "Address line 2", value: (c) => c.registeredAddress2 ?? "" },
  registeredCounty: { header: "County", value: (c) => c.registeredCounty ?? "" },
  postcodeArea: { header: "Postcode area", value: (c) => postcodeArea(c.registeredPostcode) },
  fullAddress: { header: "Full address", value: (c) => formatAddress(c) },

  sicCodes: { header: "SIC codes", value: (c) => sicList(c.sicCodes).join(", ") },
  sicFirst: { header: "Main SIC", value: (c) => sicList(c.sicCodes)[0] ?? "" },
  sicCount: { header: "SIC count", value: (c) => sicList(c.sicCodes).length },

  accountsNextDue: { header: "Accounts due", value: (c) => d(c.accountsNextDue) },
  accountsLastMadeUp: { header: "Accounts made up to", value: (c) => d(c.accountsLastMadeUp) },
  accountsOverdue: { header: "Accounts overdue", value: (c) => state(overdueState(c.status, c.accountsOverdue, c.accountsNextDue)) },
  accountType: { header: "Accounts type", value: (c) => { const s = accountsState(c.accountType, c.accountsLastMadeUp); return s === "has_type" ? prettySlug(c.accountType) : s === "no_accounts" ? "No accounts filed" : "Not recorded"; } },
  dormant: { header: "Dormant", value: (c) => (accountsState(c.accountType, c.accountsLastMadeUp) === "no_accounts" ? "No accounts filed" : state(dormantState(c.accountType, c.dormant))) },
  confirmationNextDue: { header: "Confirmation due", value: (c) => d(c.confirmationNextDue) },
  confirmationLastMadeUp: { header: "Confirmation made up to", value: (c) => d(c.confirmationLastMadeUp) },
  confirmationOverdue: { header: "Confirmation overdue", value: (c) => state(overdueState(c.status, c.confirmationOverdue, c.confirmationNextDue)) },
  hasDS01: { header: "DS01 filed", value: (c) => yn(c.hasDS01) },
  ds01FiledAt: {
    header: "DS01 date",
    value: (c) => {
      const s = ds01DateState(c.hasDS01, c.ds01FiledAt);
      return s === "date" ? d(c.ds01FiledAt) : s === "not_recorded" ? "Not recorded" : "Not applicable";
    },
  },

  singleDirector: { header: "Single director", value: (c, x) => officer(c, x)[1] },
  officersCoverage: { header: "Officer data", value: (c) => (c.officersCoverage === "full" ? "Fetched" : c.officersCoverage === "unavailable" ? "Unavailable" : "Not fetched") },
  officersFetchedAt: { header: "Officers fetched", value: (c) => (c.officersCoverage === "full" && c.officersFetchedAt ? d(c.officersFetchedAt) : "Not fetched") },
  officersUnavailableReason: {
    header: "Officer data issue",
    value: (c) => (c.officersCoverage === "unavailable" ? (c.officersUnavailableReason ? OFFICER_UNAVAILABLE_REASON[c.officersUnavailableReason] ?? prettySlug(c.officersUnavailableReason) : "Not provided") : c.officersCoverage === "full" ? "Not applicable" : "Not fetched"),
  },

  source: { header: "Data source", value: (c) => (c.source ? prettySlug(c.source) : "") },
  chLastFetchedAt: { header: "Profile fetched", value: (c) => { const at = profileFetchedAt(c.source, c.chLastFetchedAt); return at ? d(at) : "Not fetched"; } },

  followed: { header: "Followed", value: (_c, x) => yn(!!x.crm?.followed), crm: true },
  saved: { header: "Saved", value: (_c, x) => yn(!!x.crm?.saved), crm: true },
  redFlagged: { header: "Red flagged", value: (_c, x) => yn(!!x.crm?.redFlagged), crm: true },
  trashed: { header: "In Trash", value: (_c, x) => yn(!!x.crm?.trashed), crm: true },
};

export function needsCrmState(columns: readonly string[]): boolean {
  return columns.some((k) => EXPORT_COLUMNS[k]?.crm);
}

export function exportHeaders(columns: readonly string[]): string[] {
  return columns.map((k) => EXPORT_COLUMNS[k]?.header ?? k);
}

export function exportRow(c: Company, columns: readonly string[], x: ExportContext): (string | number)[] {
  return columns.map((k) => EXPORT_COLUMNS[k]?.value(c, x) ?? "");
}
