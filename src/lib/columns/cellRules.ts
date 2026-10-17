// Pure rules for what a table cell says when the underlying value is blank, unknown or not applicable.
// Kept free of React so the wording rules are unit-tested.

export type YesNoState = "yes" | "no" | "unknown" | "not_applicable";

// The overdue flags are stored as plain true/false, so "false" alone cannot say whether a company is on time, is not
// active (and so has no filing duty), or has no due date on record. The row's status and due date decide.
export function overdueState(status: string, overdue: boolean, due: string | Date | null | undefined): YesNoState {
  if (status !== "active") return "not_applicable";
  if (overdue) return "yes";
  if (!due) return "unknown";
  return "no";
}

// dormant is derived from the last accounts type, which is empty for a company that has filed no accounts.
// "false" in that case is not a real "No".
export function dormantState(accountType: string | null | undefined, dormant: boolean): YesNoState {
  if (!accountType) return "unknown";
  return dormant ? "yes" : "no";
}

// DS01 filed date: only meaningful when a DS01 exists; the date is only known if the live stream saw the filing.
export function ds01DateState(hasDS01: boolean, filedAt: string | Date | null | undefined): "not_applicable" | "not_recorded" | "date" {
  if (!hasDS01) return "not_applicable";
  return filedAt ? "date" : "not_recorded";
}

// Status detail is empty for two different reasons. The bulk register extract carries a detail only for a proposal to strike
// off, so for a company that only came from the extract (or the Advanced Search sample) an empty value means "the profile has
// not been fetched, so we do not know". Only a company whose profile was fetched from Companies House (stream / REST
// enrichment) can honestly be said to have no detail recorded.
export function statusDetailState(source: string | null | undefined): "none_recorded" | "not_fetched" {
  return source === "stream" || source === "rest_enrichment" ? "none_recorded" : "not_fetched";
}

// chLastFetchedAt is written by EVERY ingest path, including the monthly bulk file (it carries the import time). Only the
// paths that actually ask Companies House about this company stamp a real profile fetch: the filing stream, REST enrichment
// and Advanced Search. For a bulk-import row the value is the import time, not a profile fetch, and must not be shown as one.
const PROFILE_FETCH_SOURCES = new Set(["stream", "rest_enrichment", "advanced_search"]);
export function profileFetchedAt<T extends Date | string>(source: string | null | undefined, chLastFetchedAt: T | null | undefined): T | null {
  return chLastFetchedAt && source && PROFILE_FETCH_SOURCES.has(source) ? chLastFetchedAt : null;
}

// Accounts type / dormant come from the last accounts filed. Nothing filed (no "made up to" date and no type) is a known
// state in the register data, not a missing value; a filed set of accounts without a type is a genuine gap.
export function accountsState(accountType: string | null | undefined, accountsLastMadeUp: string | Date | null | undefined): "has_type" | "no_accounts" | "type_missing" {
  if (accountType) return "has_type";
  return accountsLastMadeUp ? "type_missing" : "no_accounts";
}

// "total-exemption-full" -> "Total exemption full"
export function prettySlug(value: string | null | undefined): string {
  if (!value) return "";
  const s = value.replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function postcodeArea(postcode: string | null | undefined): string {
  if (!postcode) return "";
  return postcode.trim().split(/\s+/)[0] ?? "";
}

export function sicList(sicCodes: string | null | undefined): string[] {
  return (sicCodes ?? "").split(/[;,|]/).map((s) => s.trim()).filter(Boolean);
}

export const OFFICER_UNAVAILABLE_REASON: Record<string, string> = {
  company_gone: "Company not found at Companies House",
  no_officer_resource: "No officer data published",
};
