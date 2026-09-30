import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChDate, parseUkDate } from "../../src/lib/companies-house/csv/dates";
import {
  ACCOUNT_CATEGORY_MAP,
  CATEGORY_MAP,
  REQUIRED_COLUMNS,
  emptyMappingStats,
  extractSicCode,
  mapCsvRecord,
  missingColumns,
} from "../../src/lib/companies-house/csv/mapping";

// ---- dates -----------------------------------------------------------------
test("parseUkDate reads DD/MM/YYYY explicitly", () => {
  assert.equal(parseUkDate("11/09/2012")?.toISOString(), "2012-09-11T00:00:00.000Z"); // 11 Sept, NOT 9 Nov
  assert.equal(parseUkDate("30/06/2027")?.toISOString(), "2027-06-30T00:00:00.000Z"); // day > 12: was Invalid Date
  assert.equal(parseUkDate("1/2/2020")?.toISOString(), "2020-02-01T00:00:00.000Z");
});

test("parseUkDate validates leap years and impossible dates", () => {
  assert.ok(parseUkDate("29/02/2024"));
  assert.equal(parseUkDate("29/02/2023"), null);
  assert.equal(parseUkDate("31/04/2020"), null);
  assert.equal(parseUkDate("00/01/2020"), null);
  assert.equal(parseUkDate("15/13/2020"), null);
  assert.equal(parseUkDate("2020-01-15"), null); // wrong format is not silently accepted
  assert.equal(parseUkDate(""), null);
  assert.equal(parseUkDate(undefined), null);
  assert.ok(parseUkDate("24/07/1604"), "real register data contains a company incorporated in 1604");
  assert.equal(parseUkDate("15/01/0950"), null);
});

test("parseChDate reads REST YYYY-MM-DD", () => {
  assert.equal(parseChDate("2026-09-30")?.toISOString(), "2026-09-30T00:00:00.000Z");
  assert.equal(parseChDate("2026-02-30"), null);
  assert.equal(parseChDate("30/09/2026"), null);
});

// ---- real CSV header + row ---------------------------------------------------
const REAL_HEADER =
  'CompanyName, CompanyNumber,RegAddress.CareOf,RegAddress.POBox,RegAddress.AddressLine1, RegAddress.AddressLine2,RegAddress.PostTown,RegAddress.County,RegAddress.Country,RegAddress.PostCode,CompanyCategory,CompanyStatus,CountryOfOrigin,DissolutionDate,IncorporationDate,Accounts.AccountRefDay,Accounts.AccountRefMonth,Accounts.NextDueDate,Accounts.LastMadeUpDate,Accounts.AccountCategory,Returns.NextDueDate,Returns.LastMadeUpDate,Mortgages.NumMortCharges,Mortgages.NumMortOutstanding,Mortgages.NumMortPartSatisfied,Mortgages.NumMortSatisfied,SICCode.SicText_1,SICCode.SicText_2,SICCode.SicText_3,SICCode.SicText_4,LimitedPartnerships.NumGenPartners,LimitedPartnerships.NumLimPartners,URI,ConfStmtNextDueDate, ConfStmtLastMadeUpDate';

test("the real (dotted, space-padded) header satisfies every required column", () => {
  assert.deepEqual(missingColumns(REAL_HEADER.split(",")), []);
});

test("the old underscore-style names are NOT accepted", () => {
  const wrong = REAL_HEADER.replace(/RegAddress\./g, "RegAddress_").replace(/SICCode\./g, "SICCode_");
  const missing = missingColumns(wrong.split(","));
  assert.ok(missing.includes("RegAddress.PostCode"));
  assert.ok(missing.includes("SICCode.SicText_1"));
});

function record(over: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = Object.fromEntries(REQUIRED_COLUMNS.map((c) => [c, ""]));
  return {
    ...base,
    CompanyName: "! LTD",
    CompanyNumber: "08209948",
    "RegAddress.AddressLine1": "9 PRINCES SQUARE",
    "RegAddress.PostTown": "HARROGATE",
    "RegAddress.PostCode": "hg1  1nd",
    CompanyCategory: "Private Limited Company",
    CompanyStatus: "Active",
    IncorporationDate: "11/09/2012",
    "Accounts.NextDueDate": "30/06/2027",
    "Accounts.LastMadeUpDate": "30/09/2025",
    "Accounts.AccountCategory": "DORMANT",
    "SICCode.SicText_1": "99999 - Dormant Company",
    ConfStmtNextDueDate: "25/09/2026",
    ConfStmtLastMadeUpDate: "11/09/2025",
    ...over,
  };
}

test("maps a real row: address, postcode, dates, categories, SIC, filing dates", () => {
  const res = mapCsvRecord(record(), emptyMappingStats(), new Date("2026-09-30T12:00:00Z"));
  assert.ok(res.ok);
  if (!res.ok) return;
  const r = res.row;
  assert.equal(r.companyNumber, "08209948"); // leading zeros preserved
  assert.equal(r.registeredAddress1, "9 PRINCES SQUARE");
  assert.equal(r.registeredCity, "HARROGATE");
  assert.equal(r.registeredPostcode, "HG1 1ND"); // upper-cased, whitespace normalised
  assert.equal(r.type, "ltd");
  assert.equal(r.status, "active");
  assert.equal(r.accountType, "dormant");
  assert.equal(r.dormant, true);
  assert.equal(r.sicCodes, "99999");
  assert.equal(r.incorporationDate.toISOString().slice(0, 10), "2012-09-11");
  assert.equal(r.accountsNextDue?.toISOString().slice(0, 10), "2027-06-30");
  assert.equal(r.accountsLastMadeUp?.toISOString().slice(0, 10), "2025-09-30"); // Accounts.LastMadeUpDate
  assert.equal(r.confirmationNextDue?.toISOString().slice(0, 10), "2026-09-25"); // ConfStmtNextDueDate
  assert.equal(r.confirmationLastMadeUp?.toISOString().slice(0, 10), "2025-09-11");
  assert.equal(r.confirmationOverdue, true); // 25 Sep 2026 < 30 Sep 2026 and company is active
  assert.equal(r.accountsOverdue, false);
});

test("a missing or invalid incorporation date is skipped, never stored as 1970", () => {
  const blank = mapCsvRecord(record({ IncorporationDate: "" }), emptyMappingStats());
  assert.equal(blank.ok, false);
  const bad = mapCsvRecord(record({ IncorporationDate: "31/02/2020" }), emptyMappingStats());
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /invalid incorporation date/);
});

test("'Active - Proposal to Strike off' is an active company with DS01 set", () => {
  const res = mapCsvRecord(record({ CompanyStatus: "Active - Proposal to Strike off" }), emptyMappingStats());
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.row.status, "active");
    assert.equal(res.row.statusDetail, "active-proposal-to-strike-off");
    assert.equal(res.row.hasDS01, true);
  }
});

test("unknown categories are recorded and kept (slugged), not silently dropped", () => {
  const stats = emptyMappingStats();
  const res = mapCsvRecord(
    record({ CompanyCategory: "Brand New Kind Of Company", CompanyStatus: "Mystery", "Accounts.AccountCategory": "WEIRD CATEGORY" }),
    stats
  );
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.row.type, "brand-new-kind-of-company");
    assert.equal(res.row.status, "mystery");
    assert.equal(res.row.accountType, "weird-category");
  }
  assert.equal(stats.unknownCategories["Brand New Kind Of Company"], 1);
  assert.equal(stats.unknownStatuses["Mystery"], 1);
  assert.equal(stats.unknownAccountCategories["WEIRD CATEGORY"], 1);
});

test("an invalid OPTIONAL date is nulled and counted as a warning, the row is kept", () => {
  const stats = emptyMappingStats();
  const res = mapCsvRecord(record({ "Accounts.NextDueDate": "99/99/2020" }), stats);
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.row.accountsNextDue, null);
  assert.equal(stats.invalidOptionalDates, 1);
});

test("dissolved companies are never flagged overdue", () => {
  const res = mapCsvRecord(record({ CompanyStatus: "Dissolved", "Accounts.NextDueDate": "01/01/2015" }), emptyMappingStats());
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.row.accountsOverdue, false);
});

test("category tables use the values the filter dropdown offers", () => {
  assert.equal(CATEGORY_MAP["private limited company"], "ltd");
  assert.equal(CATEGORY_MAP["public limited company"], "plc");
  assert.equal(CATEGORY_MAP["limited liability partnership"], "llp");
  assert.equal(ACCOUNT_CATEGORY_MAP["total exemption full"], "total-exemption-full");
  assert.equal(ACCOUNT_CATEGORY_MAP["dormant"], "dormant");
});

test("extractSicCode", () => {
  assert.equal(extractSicCode("62012 - Business and domestic software development"), "62012");
  assert.equal(extractSicCode("None Supplied"), null);
  assert.equal(extractSicCode(""), null);
});

// Every distinct value found in the real September 2026 file (5,689,368 rows, scanned
// in full) must map explicitly - nothing may fall through to the "unknown" path.
const REAL_STATUSES = [
  "Active", "Active - Proposal to Strike off", "Liquidation", "In Administration", "Live but Receiver Manager on at least one charge",
  "Voluntary Arrangement", "In Administration/Administrative Receiver", "RECEIVERSHIP", "ADMINISTRATION ORDER", "ADMINISTRATIVE RECEIVER",
  "In Administration/Receiver Manager", "RECEIVER MANAGER / ADMINISTRATIVE RECEIVER", "VOLUNTARY ARRANGEMENT / RECEIVER MANAGER",
  "VOLUNTARY ARRANGEMENT / ADMINISTRATIVE RECEIVER",
];
const REAL_CATEGORIES = [
  "Private Limited Company", "PRI/LTD BY GUAR/NSC (Private, limited by guarantee, no share capital)", "Limited Partnership",
  "Limited Liability Partnership", "Community Interest Company", "Charitable Incorporated Organisation",
  "PRI/LBG/NSC (Private, Limited by guarantee, no share capital, use of 'Limited' exemption)", "Overseas Entity", "Other company type",
  "Registered Society", "Scottish Charitable Incorporated Organisation", "Private Unlimited Company", "Public Limited Company",
  "Royal Charter Company", "Investment Company with Variable Capital", "United Kingdom Economic Interest Grouping", "Scottish Partnership",
  "Industrial and Provident Society", "Private Unlimited", "Investment Company with Variable Capital(Umbrella)", "Old Public Company",
  "PRIV LTD SECT. 30 (Private limited company, section 30 of the Companies Act)", "Investment Company with Variable Capital (Securities)",
  "United Kingdom Societas", "Protected Cell Company", "Other Company Type", "Further Education and Sixth Form College Corps", "Converted/Closed",
];
const REAL_ACCOUNT_CATEGORIES = [
  "MICRO ENTITY", "NO ACCOUNTS FILED", "TOTAL EXEMPTION FULL", "DORMANT", "UNAUDITED ABRIDGED", "FULL", "SMALL", "AUDIT EXEMPTION SUBSIDIARY",
  "GROUP", "TOTAL EXEMPTION SMALL", "MEDIUM", "ACCOUNTS TYPE NOT AVAILABLE", "AUDITED ABRIDGED", "FILING EXEMPTION SUBSIDIARY", "PARTIAL EXEMPTION", "INITIAL",
];

test("every real-world status / category / account-category value is explicitly mapped", () => {
  const stats = emptyMappingStats();
  for (const v of REAL_STATUSES) assert.ok(mapCsvRecord(record({ CompanyStatus: v }), stats).ok);
  for (const v of REAL_CATEGORIES) assert.ok(mapCsvRecord(record({ CompanyCategory: v }), stats).ok);
  for (const v of REAL_ACCOUNT_CATEGORIES) assert.ok(mapCsvRecord(record({ "Accounts.AccountCategory": v }), stats).ok);
  assert.deepEqual(stats.unknownStatuses, {});
  assert.deepEqual(stats.unknownCategories, {});
  assert.deepEqual(stats.unknownAccountCategories, {});
});
