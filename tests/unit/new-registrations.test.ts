import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, daysBetween, MAX_LOOKBACK_DAYS, OVERLAP_DAYS, planWindow, mapSearchItem } from "../../src/lib/companies-house/newRegistrations";

test("planWindow: resumes from the last covered day minus the overlap", () => {
  const w = planWindow({ today: "2026-10-12", lastCovered: "2026-10-10" });
  assert.equal(w.from, addDays("2026-10-10", 1 - OVERLAP_DAYS));
  assert.equal(w.to, "2026-10-12");
});

test("planWindow: first run starts at the loaded bulk snapshot date, the first day the file does not cover", () => {
  assert.deepEqual(planWindow({ today: "2026-10-12", bulkSnapshot: "2026-09-01" }), { from: "2026-09-01", to: "2026-10-12" });
});

test("planWindow: an explicit window wins, and the look-back is capped", () => {
  assert.deepEqual(planWindow({ today: "2026-10-12", from: "2026-10-01", to: "2026-10-05", lastCovered: "2026-10-10" }), { from: "2026-10-01", to: "2026-10-05" });
  const capped = planWindow({ today: "2026-10-12", lastCovered: "2020-01-01" });
  assert.equal(capped.from, addDays("2026-10-12", -MAX_LOOKBACK_DAYS));
});

test("planWindow: the window never ends after today", () => {
  assert.equal(planWindow({ today: "2026-10-12", to: "2099-01-01" }).to, "2026-10-12");
});

test("planWindow: with no history it falls back to the last 30 days", () => {
  assert.equal(planWindow({ today: "2026-10-12" }).from, "2026-09-12");
});

test("daysBetween is inclusive and empty when from is after to", () => {
  assert.deepEqual(daysBetween("2026-02-27", "2026-03-02"), ["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
  assert.deepEqual(daysBetween("2026-03-02", "2026-03-01"), []);
});

test("mapSearchItem maps a search hit including SIC codes and normalised postcode", () => {
  const r = mapSearchItem({
    company_number: "sc905284",
    company_name: "EXAMPLE LTD",
    company_status: "active",
    company_type: "ltd",
    date_of_creation: "2026-10-08",
    sic_codes: ["62020", "62090"],
    registered_office_address: { address_line_1: "1 High St", locality: "Glasgow", postal_code: "g1 1aa" },
  });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.data.companyNumber, "SC905284");
    assert.equal(r.data.sicCodes, "62020,62090");
    assert.equal(r.data.source, "advanced_search");
    assert.equal(r.data.registeredCity, "Glasgow");
    assert.equal(r.data.incorporationDate instanceof Date ? r.data.incorporationDate.toISOString().slice(0, 10) : "", "2026-10-08");
  }
});

test("mapSearchItem rejects hits with no usable incorporation date or required field", () => {
  assert.equal(mapSearchItem({ company_number: "1", company_name: "A", company_status: "active", company_type: "ltd" }).ok, false);
  assert.equal(mapSearchItem({ company_number: "1", company_name: "", company_status: "active", company_type: "ltd", date_of_creation: "2026-10-08" }).ok, false);
});
