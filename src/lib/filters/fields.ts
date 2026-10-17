import type { FilterFieldDef } from "./types";
import { LETTER_OPTIONS } from "./nameLetter";

// Matches the real Companies House `company_status` enum exactly
// (companieshouse/api-enumerations) — not an invented simplification.
export const COMPANY_STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "dissolved", label: "Dissolved" },
  { value: "liquidation", label: "Liquidation" },
  { value: "receivership", label: "Receivership" },
  { value: "converted-closed", label: "Converted / closed" },
  { value: "voluntary-arrangement", label: "Voluntary arrangement" },
  { value: "insolvency-proceedings", label: "Insolvency proceedings" },
  { value: "administration", label: "Administration" },
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "registered", label: "Registered" },
  { value: "removed", label: "Removed" },
];

// Company.type stores whatever raw company_type string Companies House
// returns (there are ~35 real values). This is a curated subset of the
// common ones for the filter dropdown — anything else still matches via
// the "contains" operator, it just isn't in this list.
export const COMPANY_TYPE_OPTIONS = [
  { value: "ltd", label: "Private limited company" },
  { value: "plc", label: "Public limited company" },
  { value: "llp", label: "Limited liability partnership" },
  { value: "limited-partnership", label: "Limited partnership" },
  { value: "private-unlimited", label: "Private unlimited company" },
  { value: "community-interest-company", label: "Community interest company" },
  { value: "scottish-partnership", label: "Scottish partnership" },
  { value: "uk-establishment", label: "UK establishment (overseas company)" },
];

// Declarative registry: every filterable Companies House attribute the
// product exposes today. Add a row here (+ a branch in compile.ts if the
// field needs custom SQL, e.g. a derived value) to add a new filter —
// nothing else in the report builder needs to change.
export const COMPANY_FILTER_FIELDS: FilterFieldDef[] = [
  {
    key: "name",
    label: "Company name",
    type: "string",
    operators: ["contains", "equals", "startsWith"],
    group: "Identity",
  },
  {
    key: "nameLetter",
    label: "Company name starts with letter",
    type: "enum",
    operators: ["equals"],
    options: LETTER_OPTIONS,
    group: "Identity",
    description: "The same as the A to Z bar on the Companies page.",
  },
  {
    key: "companyNumber",
    label: "Company number",
    type: "string",
    operators: ["equals", "contains", "startsWith"],
    group: "Identity",
  },
  {
    key: "status",
    label: "Status",
    type: "enum",
    operators: ["equals"],
    options: COMPANY_STATUS_OPTIONS,
    group: "Identity",
  },
  {
    key: "type",
    label: "Company type",
    type: "enum",
    operators: ["equals"],
    options: COMPANY_TYPE_OPTIONS,
    group: "Identity",
  },
  {
    key: "dormant",
    label: "Dormant",
    type: "boolean",
    operators: ["isTrue", "isFalse"],
    group: "Filing status",
  },
  {
    key: "companyAgeYears",
    label: "Company age (years)",
    type: "number",
    operators: ["between", "gt", "gte", "lt", "lte"],
    group: "Identity",
    description: "Derived from incorporation date",
  },
  {
    key: "incorporationDate",
    label: "Incorporation date",
    type: "date",
    operators: ["before", "after", "dateBetween"],
    group: "Identity",
  },
  {
    key: "registeredPostcode",
    label: "Postcode",
    type: "string",
    operators: ["startsWith", "contains", "equals"],
    group: "Address",
    placeholder: "e.g. SW1A",
  },
  {
    key: "registeredCity",
    label: "City / town",
    type: "string",
    operators: ["contains", "equals"],
    group: "Address",
  },
  {
    key: "registeredCounty",
    label: "County",
    type: "string",
    operators: ["contains", "equals"],
    group: "Address",
  },
  {
    key: "directorCount",
    label: "Director count",
    type: "number",
    operators: ["equals", "gt", "gte", "lt", "lte", "between"],
    group: "Directors",
  },
  {
    key: "singleDirector",
    label: "Single director",
    type: "boolean",
    operators: ["isTrue", "isFalse"],
    group: "Directors",
  },
  {
    key: "accountsOverdue",
    label: "Late filing (accounts)",
    type: "boolean",
    operators: ["isTrue", "isFalse"],
    group: "Filing status",
  },
  {
    key: "confirmationOverdue",
    label: "Late confirmation statement",
    type: "boolean",
    operators: ["isTrue", "isFalse"],
    group: "Filing status",
  },
  {
    key: "accountsNextDue",
    label: "Accounts next due",
    type: "date",
    operators: ["before", "after", "dateBetween"],
    group: "Filing status",
  },
  {
    key: "accountsLastMadeUp",
    label: "Accounts last made up to",
    type: "date",
    operators: ["before", "after", "dateBetween"],
    group: "Filing status",
    description: "End date of the last accounts filed. Companies with no accounts filed never match.",
  },
  {
    key: "confirmationNextDue",
    label: "Confirmation statement due",
    type: "date",
    operators: ["before", "after", "dateBetween"],
    group: "Filing status",
  },
  {
    key: "confirmationLastMadeUp",
    label: "Confirmation last made up",
    type: "date",
    operators: ["before", "after", "dateBetween"],
    group: "Filing status",
    description: "Companies that have never filed a confirmation statement never match.",
  },
  {
    key: "hasDS01",
    label: "DS01 filed (strike-off)",
    type: "boolean",
    operators: ["isTrue", "isFalse"],
    group: "Filing status",
  },
  {
    key: "followed",
    label: "Followed",
    type: "boolean",
    operators: ["isTrue", "isFalse"],
    group: "My CRM",
    description: "Your own followed companies",
  },
  {
    key: "saved",
    label: "Saved",
    type: "boolean",
    operators: ["isTrue", "isFalse"],
    group: "My CRM",
    description: "Your own saved companies",
  },
  {
    key: "redFlagged",
    label: "Red flagged",
    type: "boolean",
    operators: ["isTrue", "isFalse"],
    group: "My CRM",
    description: "Your own red-flagged companies",
  },
  {
    key: "sicCodes",
    label: "SIC code",
    type: "string",
    operators: ["contains"],
    group: "Identity",
    placeholder: "e.g. 62012",
  },
  {
    key: "dissolutionDate",
    label: "Dissolved date",
    type: "date",
    operators: ["before", "after", "dateBetween"],
    group: "Identity",
  },
  {
    key: "registeredAddress1",
    label: "Address line 1",
    type: "string",
    operators: ["contains"],
    group: "Address",
  },
  {
    key: "registeredAddress2",
    label: "Address line 2",
    type: "string",
    operators: ["contains"],
    group: "Address",
  },
];

export function getFieldDef(key: string): FilterFieldDef | undefined {
  return COMPANY_FILTER_FIELDS.find((f) => f.key === key);
}

export const OPERATOR_LABELS: Record<string, string> = {
  equals: "is",
  notEquals: "is not",
  contains: "contains",
  startsWith: "starts with",
  gt: "greater than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
  between: "between",
  before: "before",
  after: "after",
  dateBetween: "between",
  isTrue: "yes",
  isFalse: "no",
  in: "is one of",
};
