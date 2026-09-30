import { isBlankDate, parseUkDate } from "./dates";

// ---------------------------------------------------------------------------
// The ONE place the Companies House "Free Company Data Product" CSV is
// understood. Column names are the real ones from the published file
// (BasicCompanyDataAsOneFile-YYYY-MM-01.csv); note the real header has
// dotted names, and some carry stray leading spaces which are trimmed.
// ---------------------------------------------------------------------------
export const COL = {
  name: "CompanyName",
  number: "CompanyNumber",
  addr1: "RegAddress.AddressLine1",
  addr2: "RegAddress.AddressLine2",
  town: "RegAddress.PostTown",
  county: "RegAddress.County",
  postcode: "RegAddress.PostCode",
  category: "CompanyCategory",
  status: "CompanyStatus",
  dissolved: "DissolutionDate",
  incorporated: "IncorporationDate",
  accountsNextDue: "Accounts.NextDueDate",
  accountsLastMadeUp: "Accounts.LastMadeUpDate",
  accountCategory: "Accounts.AccountCategory",
  sic: ["SICCode.SicText_1", "SICCode.SicText_2", "SICCode.SicText_3", "SICCode.SicText_4"],
  confNextDue: "ConfStmtNextDueDate",
  confLastMadeUp: "ConfStmtLastMadeUpDate",
} as const;

export const REQUIRED_COLUMNS: string[] = [
  COL.name, COL.number, COL.addr1, COL.addr2, COL.town, COL.county, COL.postcode, COL.category, COL.status,
  COL.dissolved, COL.incorporated, COL.accountsNextDue, COL.accountsLastMadeUp, COL.accountCategory,
  ...COL.sic, COL.confNextDue, COL.confLastMadeUp,
];

export function missingColumns(headers: string[]): string[] {
  const have = new Set(headers.map((h) => h.trim()));
  return REQUIRED_COLUMNS.filter((c) => !have.has(c));
}

// ---- CompanyStatus -> internal company_status enum --------------------------
// Keys are lower-cased CSV values. "Active - Proposal to Strike off" is an
// active company with status detail active-proposal-to-strike-off (DS01).
export const STATUS_MAP: Record<string, { status: string; statusDetail: string | null; strikeOff?: boolean }> = {
  "active": { status: "active", statusDetail: null },
  "active - proposal to strike off": { status: "active", statusDetail: "active-proposal-to-strike-off", strikeOff: true },
  "dissolved": { status: "dissolved", statusDetail: null },
  "liquidation": { status: "liquidation", statusDetail: null },
  "receivership": { status: "receivership", statusDetail: null },
  "voluntary arrangement": { status: "voluntary-arrangement", statusDetail: null },
  "converted / closed": { status: "converted-closed", statusDetail: null },
  "in administration": { status: "administration", statusDetail: null },
  "in administration/administrative receiver": { status: "administration", statusDetail: null },
  "in administration/receiver manager": { status: "administration", statusDetail: null },
  "administration order": { status: "administration", statusDetail: null },
  "live but receiver manager on at least one charge": { status: "receivership", statusDetail: null },
  "administrative receiver": { status: "receivership", statusDetail: null },
  "receiver manager / administrative receiver": { status: "receivership", statusDetail: null },
  "voluntary arrangement / receiver manager": { status: "voluntary-arrangement", statusDetail: null },
  "voluntary arrangement / administrative receiver": { status: "voluntary-arrangement", statusDetail: null },
  "insolvency proceedings": { status: "insolvency-proceedings", statusDetail: null },
  "open": { status: "open", statusDetail: null },
  "closed": { status: "closed", statusDetail: null },
  "registered": { status: "registered", statusDetail: null },
  "removed": { status: "removed", statusDetail: null },
};

// ---- CompanyCategory -> internal company type (REST company_type values) ---
export const CATEGORY_MAP: Record<string, string> = {
  "private limited company": "ltd",
  "public limited company": "plc",
  "limited liability partnership": "llp",
  "limited partnership": "limited-partnership",
  "private unlimited company": "private-unlimited",
  "private unlimited": "private-unlimited",
  "priv ltd sect. 30 (private limited company, section 30 of the companies act)": "ltd",
  "united kingdom economic interest grouping": "eeig",
  "further education and sixth form college corps": "further-education-or-sixth-form-college-corporation",
  "pri/ltd by guar/nsc (private, limited by guarantee, no share capital)": "private-limited-guarant-nsc",
  "pri/lbg/nsc (private, limited by guarantee, no share capital, use of 'limited' exemption)": "private-limited-guarant-nsc-limited-exemption",
  "pri/unlltd/nsc (private, unlimited, no share capital)": "private-unlimited-nsc",
  "community interest company": "community-interest-company",
  "scottish partnership": "scottish-partnership",
  "uk establishment company": "uk-establishment",
  "industrial and provident society": "industrial-and-provident-society",
  "registered society": "registered-society-non-jurisdictional",
  "royal charter company": "royal-charter",
  "charitable incorporated organisation": "charitable-incorporated-organisation",
  "scottish charitable incorporated organisation": "scottish-charitable-incorporated-organisation",
  "investment company with variable capital": "investment-company-with-variable-capital",
  "investment company with variable capital (securities)": "icvc-securities",
  "investment company with variable capital(umbrella)": "icvc-umbrella",
  "investment company with variable capital (umbrella)": "icvc-umbrella",
  "investment company with variable capital (warrant)": "icvc-warrant",
  "old public company": "old-public-company",
  "protected cell company": "protected-cell-company",
  "overseas entity": "registered-overseas-entity",
  "other company type": "other",
  "further education or sixth form college corporation": "further-education-or-sixth-form-college-corporation",
  "eeig": "eeig",
  "european public limited-liability company (se)": "european-public-limited-liability-company-se",
  "united kingdom societas": "united-kingdom-societas",
  "northern ireland company": "northern-ireland",
  "northern ireland other": "northern-ireland-other",
  "assurance company": "assurance-company",
  "unregistered company": "unregistered-company",
  "oversea company": "oversea-company",
  "converted/closed": "converted-or-closed",
};

// ---- Accounts.AccountCategory -> internal account type ---------------------
// dormant is derived from this (never from company_status). null = the
// company has filed no accounts of a recognised type.
export const ACCOUNT_CATEGORY_MAP: Record<string, string | null> = {
  "dormant": "dormant",
  "full": "full",
  "small": "small",
  "medium": "medium",
  "group": "group",
  "micro entity": "micro-entity",
  "total exemption full": "total-exemption-full",
  "total exemption small": "total-exemption-small",
  "partial exemption": "partial-exemption",
  "audit exemption subsidiary": "audit-exemption-subsidiary",
  "filing exemption subsidiary": "filing-exemption-subsidiary",
  "unaudited abridged": "unaudited-abridged",
  "audited abridged": "audited-abridged",
  "interim": "interim",
  "initial": "initial",
  "accounts type not available": "no-accounts-type-available",
  "no accounts filed": null,
};

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface CompanyCsvRow {
  companyNumber: string;
  name: string;
  status: string;
  statusDetail: string | null;
  type: string;
  incorporationDate: Date;
  dissolutionDate: Date | null;
  dormant: boolean;
  accountType: string | null;
  sicCodes: string;
  registeredAddress1: string;
  registeredAddress2: string | null;
  registeredCity: string;
  registeredPostcode: string;
  registeredCounty: string | null;
  accountsNextDue: Date | null;
  accountsLastMadeUp: Date | null;
  accountsOverdue: boolean;
  confirmationNextDue: Date | null;
  confirmationLastMadeUp: Date | null;
  confirmationOverdue: boolean;
  hasDS01: boolean;
}

export interface MappingStats {
  unknownStatuses: Record<string, number>;
  unknownCategories: Record<string, number>;
  unknownAccountCategories: Record<string, number>;
  invalidOptionalDates: number;
}

export function emptyMappingStats(): MappingStats {
  return { unknownStatuses: {}, unknownCategories: {}, unknownAccountCategories: {}, invalidOptionalDates: 0 };
}

function bump(map: Record<string, number>, key: string) {
  // Bounded so a corrupt file cannot grow the stats object without limit.
  if (key in map || Object.keys(map).length < 50) map[key] = (map[key] ?? 0) + 1;
}

export type MapResult = { ok: true; row: CompanyCsvRow } | { ok: false; reason: string; companyNumber?: string };

function clean(v: string | undefined): string {
  return (v ?? "").trim();
}

export function normalisePostcode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, " ");
}

// "62012 - Business and domestic software development" -> "62012"
export function extractSicCode(text: string): string | null {
  const m = /^\s*(\d{4,5})\b/.exec(text);
  return m ? m[1] : null;
}

export function mapCsvRecord(record: Record<string, string>, stats: MappingStats, today: Date = new Date()): MapResult {
  const companyNumber = clean(record[COL.number]).toUpperCase();
  if (!/^[A-Z0-9]{6,10}$/.test(companyNumber)) {
    return { ok: false, reason: `invalid company number "${companyNumber.slice(0, 20)}"`, companyNumber: companyNumber || undefined };
  }
  const name = clean(record[COL.name]);
  if (!name) return { ok: false, reason: "missing company name", companyNumber };

  // Required date: an absent/invalid incorporation date is skipped (and
  // reported), never stored as 1970.
  const incorporationDate = parseUkDate(record[COL.incorporated]);
  if (!incorporationDate) {
    return {
      ok: false,
      reason: isBlankDate(record[COL.incorporated])
        ? "missing incorporation date"
        : `invalid incorporation date "${clean(record[COL.incorporated]).slice(0, 20)}"`,
      companyNumber,
    };
  }

  const optionalDate = (col: string): Date | null => {
    const raw = record[col];
    if (isBlankDate(raw)) return null;
    const d = parseUkDate(raw);
    if (!d) stats.invalidOptionalDates++;
    return d;
  };

  const rawStatus = clean(record[COL.status]);
  const statusKey = rawStatus.toLowerCase();
  let status: string;
  let statusDetail: string | null;
  let strikeOff = false;
  const mappedStatus = STATUS_MAP[statusKey];
  if (mappedStatus) {
    ({ status, statusDetail } = mappedStatus);
    strikeOff = !!mappedStatus.strikeOff;
  } else {
    // Unknown value: keep the record, store a slug of what Companies House
    // sent, and record the value so the operator sees it.
    status = slugify(rawStatus) || "unknown";
    statusDetail = null;
    bump(stats.unknownStatuses, rawStatus || "(blank)");
  }

  const rawCategory = clean(record[COL.category]);
  const categoryKey = rawCategory.toLowerCase();
  let type = CATEGORY_MAP[categoryKey];
  if (type === undefined) {
    type = slugify(rawCategory) || "unknown";
    bump(stats.unknownCategories, rawCategory || "(blank)");
  }

  const rawAccountCategory = clean(record[COL.accountCategory]);
  const accountKey = rawAccountCategory.toLowerCase();
  let accountType: string | null;
  if (rawAccountCategory === "") {
    accountType = null;
  } else if (accountKey in ACCOUNT_CATEGORY_MAP) {
    accountType = ACCOUNT_CATEGORY_MAP[accountKey];
  } else {
    accountType = slugify(rawAccountCategory);
    bump(stats.unknownAccountCategories, rawAccountCategory);
  }

  const accountsNextDue = optionalDate(COL.accountsNextDue);
  const confirmationNextDue = optionalDate(COL.confNextDue);
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  // Only a live company can be "late"; a dissolved company has no obligations.
  const live = status === "active";

  const sic = COL.sic
    .map((c) => extractSicCode(clean(record[c])))
    .filter((c): c is string => c !== null);

  return {
    ok: true,
    row: {
      companyNumber,
      name,
      status,
      statusDetail,
      type,
      incorporationDate,
      dissolutionDate: optionalDate(COL.dissolved),
      dormant: accountType === "dormant",
      accountType,
      sicCodes: [...new Set(sic)].join(","),
      registeredAddress1: clean(record[COL.addr1]),
      registeredAddress2: clean(record[COL.addr2]) || null,
      registeredCity: clean(record[COL.town]),
      registeredPostcode: normalisePostcode(record[COL.postcode] ?? ""),
      registeredCounty: clean(record[COL.county]) || null,
      accountsNextDue,
      accountsLastMadeUp: optionalDate(COL.accountsLastMadeUp),
      accountsOverdue: live && accountsNextDue !== null && accountsNextDue < todayUtc,
      confirmationNextDue,
      confirmationLastMadeUp: optionalDate(COL.confLastMadeUp),
      confirmationOverdue: live && confirmationNextDue !== null && confirmationNextDue < todayUtc,
      hasDS01: strikeOff,
    },
  };
}
