/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures are loosely typed company rows */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EXPORT_COLUMNS, exportHeaders, exportRow, needsCrmState } from "../../src/lib/columns/exportCells";
import { FIELD_CATALOGUE } from "../../src/lib/columns/catalogue";
import { PHASE1_COLUMNS } from "../../src/lib/columns/resolve";
import { withSearchAsFilter } from "../../src/lib/filters/searchToFilter";
import { emptyFilterGroup } from "../../src/lib/filters/types";
import { parseFilter } from "../../src/lib/filters/validate";
import { csvLine } from "../../src/lib/data/csv";

const NOW = new Date("2026-10-09T12:00:00Z");
const ctx = { now: NOW, staleAfterDays: 180 };

const full: any = {
  id: "c1", companyNumber: "FT000001", name: "AAA FULL TEST LTD", status: "active", type: "ltd", incorporationDate: new Date("2015-06-15T00:00:00Z"), dissolutionDate: null,
  registeredAddress1: "1 High Street", registeredAddress2: "Unit 2", registeredCity: "Colchester", registeredCounty: "Essex", registeredPostcode: "CO4 5AJ",
  sicCodes: "62012,70229", accountsNextDue: new Date("2027-05-31T00:00:00Z"), accountsLastMadeUp: new Date("2025-08-31T00:00:00Z"), accountsOverdue: false,
  confirmationNextDue: new Date("2026-08-24T00:00:00Z"), confirmationLastMadeUp: new Date("2025-08-10T00:00:00Z"), confirmationOverdue: true, dormant: false,
  accountType: "micro-entity", hasDS01: true, ds01FiledAt: null, statusDetail: "active-proposal-to-strike-off", officersCoverage: "full",
  officersFetchedAt: new Date("2026-10-07T00:00:00Z"), officersDirtyAt: null, directorCount: 1, singleDirector: true, source: "bulk_import",
  chLastFetchedAt: new Date("2026-10-06T00:00:00Z"), officersUnavailableReason: null,
};
const sparse: any = { ...full, id: "c2", name: "BARE", status: "dissolved", registeredAddress2: null, registeredCounty: null, sicCodes: "", accountsNextDue: null, accountsLastMadeUp: null,
  confirmationNextDue: null, confirmationLastMadeUp: null, accountType: null, hasDS01: false, statusDetail: null, officersCoverage: "none", officersFetchedAt: null, directorCount: 0, singleDirector: false, chLastFetchedAt: null };

test("an export cell exists for every selectable field, and no other", () => {
  const selectable = FIELD_CATALOGUE.filter((f) => f.selectable).map((f) => f.key).sort();
  assert.deepEqual(Object.keys(EXPORT_COLUMNS).sort(), selectable);
  assert.deepEqual(Object.entries(EXPORT_COLUMNS).filter(([, v]) => v.crm).map(([k]) => k).sort(), ["followed", "redFlagged", "saved", "trashed"]);
});

test("CSV headings are identical to the table's column headings", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../src/components/companies/columnDefs.tsx"), "utf8");
  const block = src.slice(src.indexOf("export const COLUMN_RENDERERS"));
  for (const [key, col] of Object.entries(EXPORT_COLUMNS)) {
    if (key === "name") {
      assert.equal(col.header, "Company"); // drawn by ResultsTable itself
      continue;
    }
    const m = block.match(new RegExp(`^  ${key}: \\{[\\s\\S]*?header: "([^"]+)"`, "m"));
    assert.ok(m, `${key} has a table heading`);
    assert.equal(col.header, m![1], `heading for ${key}`);
  }
});

test("the 33 Phase 1 columns export in order with the table's wording", () => {
  assert.equal(exportHeaders(PHASE1_COLUMNS).length, 33);
  const row = exportRow(full, PHASE1_COLUMNS, { ...ctx, crm: { followed: true, saved: false, redFlagged: false, trashed: false } });
  const byHeader = Object.fromEntries(exportHeaders(PHASE1_COLUMNS).map((h, i) => [h, String(row[i])]));
  assert.deepEqual(byHeader, {
    Company: "AAA FULL TEST LTD", "Company No.": "FT000001", Status: "Active", Type: "Private limited company", Incorporated: "15 Jun 2015", "City / town": "Colchester",
    Postcode: "CO4 5AJ", Directors: "1", Filing: "DS01 filed", Age: "11", "Status detail": "Active proposal to strike off", "Address line 1": "1 High Street",
    "Address line 2": "Unit 2", County: "Essex", "SIC codes": "62012, 70229", "Accounts due": "31 May 2027", "Accounts made up to": "31 Aug 2025", "Accounts overdue": "No",
    "Confirmation due": "24 Aug 2026", "Confirmation made up to": "10 Aug 2025", "Confirmation overdue": "Yes", Dormant: "No", "Accounts type": "Micro entity", "DS01 filed": "Yes",
    "DS01 date": "Not recorded", "Officer data": "Fetched", "Officers fetched": "07 Oct 2026", "Single director": "Yes", Followed: "Yes", Saved: "No", "Red flagged": "No",
    "Data source": "Bulk import", "Profile fetched": "Not fetched",
  });
});

test("blank, unknown and not-applicable values are worded, never a false zero or No", () => {
  const by = (c: any) => Object.fromEntries(exportHeaders(PHASE1_COLUMNS).map((h, i) => [h, String(exportRow(c, PHASE1_COLUMNS, ctx)[i])]));
  const s = by(sparse);
  assert.equal(s.Directors, "Not fetched");
  assert.equal(s["Single director"], "Not fetched");
  assert.equal(s["Officers fetched"], "Not fetched");
  assert.equal(s["Officer data"], "Not fetched");
  assert.equal(s["Accounts overdue"], "Not applicable"); // dissolved
  assert.equal(s.Dormant, "No accounts filed"); // nothing filed
  assert.equal(s["Accounts type"], "No accounts filed");
  assert.equal(s["DS01 date"], "Not applicable");
  assert.equal(s["Profile fetched"], "Not fetched");
  assert.equal(s["Status detail"], "Not fetched"); // bulk-import row: profile never fetched
  assert.equal(s["Accounts due"], "");
  assert.equal(s.County, "");
  const unavailable = by({ ...full, officersCoverage: "unavailable" });
  assert.equal(unavailable.Directors, "Unavailable");
  assert.equal(unavailable["Single director"], "Unavailable");
  assert.equal(by({ ...full, status: "active", accountsNextDue: null })["Accounts overdue"], "Unknown");
});

test("CRM columns are only needed when chosen, and read the user's own markers", () => {
  assert.equal(needsCrmState(["name", "status"]), false);
  assert.equal(needsCrmState(["name", "saved"]), true);
  assert.deepEqual(exportRow(full, ["name", "saved", "trashed"], ctx), ["AAA FULL TEST LTD", "No", "No"]);
});

test("every cell goes through the CSV formula guard", () => {
  const evil = { ...full, name: '=HYPERLINK("http://x")', registeredAddress1: "+cmd" };
  const line = csvLine(exportRow(evil, ["name", "registeredAddress1"], ctx));
  assert.ok(line.startsWith(`"'=HYPERLINK`), line);
  assert.ok(line.endsWith(",'+cmd"), line);
});

// ---- search box / A-Z letter saved as filter rules -----------------------------------------------------------------

test("withSearchAsFilter changes nothing without a search or letter", () => {
  const f = emptyFilterGroup();
  assert.equal(withSearchAsFilter(f, "", null), f);
  assert.equal(withSearchAsFilter(f, "   ", ""), f);
});

test("withSearchAsFilter builds the same conditions as the search endpoint, and the result validates", () => {
  const base = emptyFilterGroup();
  base.children.push({ id: "r1", kind: "rule", field: "status", operator: "equals", value: "active" });
  const out = withSearchAsFilter(base, "smith", "s");
  assert.equal(out.combinator, "AND");
  assert.equal(out.children.length, 3);
  assert.equal(out.children[0], base);
  assert.deepEqual(out.children[1], { ...(out.children[1] as object), field: "nameLetter", operator: "equals", value: "S" });
  const search: any = out.children[2];
  assert.equal(search.combinator, "OR");
  assert.deepEqual(search.children.map((c: any) => [c.field, c.operator, c.value]), [["name", "contains", "smith"], ["companyNumber", "contains", "smith"], ["registeredPostcode", "contains", "smith"]]);
  assert.equal(parseFilter(out).ok, true);
  // an empty base filter is not carried as an empty group
  assert.equal(withSearchAsFilter(emptyFilterGroup(), "x", null).children.length, 1);
  // an invalid letter is ignored
  assert.equal(withSearchAsFilter(emptyFilterGroup(), "", "7").children.length, 0);
});

test("the three new date filters validate and reject bad dates", () => {
  const mk = (field: string, operator: string, value: unknown, value2?: unknown) => ({ id: "g", kind: "group", combinator: "AND", children: [{ id: "r", kind: "rule", field, operator, value, ...(value2 ? { value2 } : {}) }] });
  for (const field of ["accountsLastMadeUp", "confirmationNextDue", "confirmationLastMadeUp"]) {
    assert.equal(parseFilter(mk(field, "before", "2026-12-31")).ok, true, field);
    assert.equal(parseFilter(mk(field, "dateBetween", "2026-01-01", "2026-06-30")).ok, true, field);
    assert.equal(parseFilter(mk(field, "before", "not-a-date")).ok, false, field);
    assert.equal(parseFilter(mk(field, "contains", "2026")).ok, false, field);
  }
});

test("officer data issue: unknown is not 'not applicable' (only fetched officer data has nothing to explain)", () => {
  const cell = (cov: string, reason: string | null = null) => String(exportRow({ ...full, officersCoverage: cov, officersUnavailableReason: reason } as typeof full, ["officersUnavailableReason"], ctx)[0]);
  assert.equal(cell("none"), "Not fetched");
  assert.equal(cell("full"), "Not applicable");
  assert.equal(cell("unavailable"), "Not provided");
  assert.notEqual(cell("unavailable", "company_gone"), "Not provided");
});
