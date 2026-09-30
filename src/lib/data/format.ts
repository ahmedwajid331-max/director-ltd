import type { CompanyStatus } from "@/lib/types";

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// For date-only values (no time-of-day meaning) that were parsed from a
// plain "YYYY-MM-DD" string — e.g. FollowUp.dueDate, sourced from an
// <input type="date">. `new Date("YYYY-MM-DD")` is spec'd to parse as UTC
// midnight; formatting that with the *local* timezone (as formatDate does)
// rolls the displayed calendar date back a day for any viewer west of UTC.
// Reading the date back out in UTC undoes exactly that shift, so the
// calendar day picked by the user is always the day shown, everywhere.
export function formatDateOnly(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

export function companyAgeYears(incorporationDate: Date | string): number {
  const d = typeof incorporationDate === "string" ? new Date(incorporationDate) : incorporationDate;
  const diffMs = Date.now() - d.getTime();
  return Math.floor(diffMs / (365.25 * 24 * 60 * 60 * 1000));
}

// Matches the real Companies House company_status enum (see
// src/lib/types.ts) — every value CH can actually return has a label here.
export const STATUS_LABELS: Record<CompanyStatus, string> = {
  active: "Active",
  dissolved: "Dissolved",
  liquidation: "Liquidation",
  receivership: "Receivership",
  "converted-closed": "Converted / closed",
  "voluntary-arrangement": "Voluntary arrangement",
  "insolvency-proceedings": "Insolvency proceedings",
  administration: "Administration",
  open: "Open",
  closed: "Closed",
  registered: "Registered",
  removed: "Removed",
};

export const STATUS_TONE: Record<CompanyStatus, "green" | "red" | "amber" | "slate"> = {
  active: "green",
  dissolved: "slate",
  liquidation: "red",
  receivership: "red",
  "converted-closed": "slate",
  "voluntary-arrangement": "amber",
  "insolvency-proceedings": "red",
  administration: "amber",
  open: "green",
  closed: "slate",
  registered: "green",
  removed: "slate",
};

// company.type is a raw, open-ended Companies House string (~35 real
// values) — not a closed enum. This covers the common ones the filter
// dropdown curates; anything else falls back to a humanized version of the
// raw value rather than silently rendering nothing.
const COMMON_TYPE_LABELS: Record<string, string> = {
  ltd: "Private limited company",
  plc: "Public limited company",
  llp: "Limited liability partnership",
  "limited-partnership": "Limited partnership",
  "private-unlimited": "Private unlimited company",
  "community-interest-company": "Community interest company",
  "scottish-partnership": "Scottish partnership",
  "uk-establishment": "UK establishment (overseas company)",
};

export function typeLabel(type: string): string {
  if (COMMON_TYPE_LABELS[type]) return COMMON_TYPE_LABELS[type];
  if (!type) return "—";
  return type
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function formatAddress(company: {
  registeredAddress1: string;
  registeredAddress2?: string | null;
  registeredCity: string;
  registeredPostcode: string;
  registeredCounty?: string | null;
}): string {
  return [
    company.registeredAddress1,
    company.registeredAddress2,
    company.registeredCity,
    company.registeredCounty,
    company.registeredPostcode,
  ]
    .filter(Boolean)
    .join(", ");
}
