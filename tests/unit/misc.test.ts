import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { csvCell, csvLine, neutraliseFormula } from "../../src/lib/data/csv";
import { validatePassword } from "../../src/lib/auth/password-policy";
import { countActiveDirectors, countsAsDirector } from "../../src/lib/companies-house/officers";
import { classifyRun } from "../../src/lib/jobs/runs";
import { parseFilingEvent } from "../../src/lib/companies-house/filingEvents";
import { companyAgeYears } from "../../src/lib/data/format";
import { openCsvFile } from "../../src/lib/companies-house/csv/source";

// ---- CSV formula injection ------------------------------------------------------
test("CSV cells starting with = + - @ are neutralised; normal data is untouched", () => {
  for (const evil of ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\t=1", "\r=1"]) {
    assert.ok(neutraliseFormula(evil).startsWith("'"), evil);
  }
  assert.equal(neutraliseFormula("ACME LIMITED"), "ACME LIMITED");
  assert.equal(neutraliseFormula("3 Smith-Jones Ltd"), "3 Smith-Jones Ltd"); // hyphen not at the start
  assert.equal(csvCell(12), "12");
  assert.equal(csvCell("A, B"), '"A, B"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0");
  assert.equal(csvLine(["x", null, undefined, true]), "x,,,true");
});

// ---- password policy -------------------------------------------------------------
test("password policy rejects trivial passwords", () => {
  for (const weak of ["12345678", "password", "Password123", "qwertyuiopas", "aaaaaaaaaaaa", "directorltd123", "short1!"]) {
    assert.notEqual(validatePassword(weak), null, weak);
  }
  assert.notEqual(validatePassword("nick.smith-secure1", { email: "nick.smith@example.com" }), null); // contains email name
});

test("password policy accepts strong passwords", () => {
  assert.equal(validatePassword("correct-Horse-battery-7-staple"), null);
  assert.equal(validatePassword("Xk9#mQ2vL8!pR4tZ"), null);
  assert.equal(validatePassword("a long passphrase of words only"), null);
});

// ---- officers: what counts as a director ------------------------------------------
test("director counting is explicit about roles and resignations", () => {
  const o = (officer_role: string, resigned_on?: string) => ({ officer_role, resigned_on, name: "x" });
  assert.equal(countsAsDirector(o("director")), true);
  assert.equal(countsAsDirector(o("corporate-director")), true);
  assert.equal(countsAsDirector(o("nominee-director")), true);
  assert.equal(countsAsDirector(o("llp-member")), true);
  assert.equal(countsAsDirector(o("llp-designated-member")), true);
  assert.equal(countsAsDirector(o("corporate-llp-member")), true);
  assert.equal(countsAsDirector(o("secretary")), false);
  assert.equal(countsAsDirector(o("corporate-secretary")), false);
  assert.equal(countsAsDirector(o("judicial-factor")), false);
  assert.equal(countsAsDirector(o("director", "2020-01-01")), false); // resigned
  assert.equal(countActiveDirectors([o("director"), o("secretary"), o("director", "2019-05-05"), o("corporate-director"), o("llp-member")]), 3);
});

// ---- run classification -----------------------------------------------------------
test("a run with many failures is never SUCCESS", () => {
  assert.equal(classifyRun({ rowsRead: 1000, rowsFailed: 0, rowsSkipped: 0 }).status, "success");
  assert.equal(classifyRun({ rowsRead: 100_000, rowsFailed: 50, rowsSkipped: 0 }).status, "success"); // 0.05%
  assert.equal(classifyRun({ rowsRead: 1000, rowsFailed: 10, rowsSkipped: 0 }).status, "partial"); // 1%
  assert.equal(classifyRun({ rowsRead: 1000, rowsFailed: 0, rowsSkipped: 100 }).status, "failed"); // 10% skipped
  assert.equal(classifyRun({ rowsRead: 199, rowsFailed: 170, rowsSkipped: 0 }).status, "failed"); // the audited 85% failure
  assert.equal(classifyRun({ rowsRead: 0, rowsFailed: 0, rowsSkipped: 0 }).status, "failed"); // nothing read is not success
});

// ---- stream event parsing --------------------------------------------------------
test("stream events: valid, malformed, and foreign lines", () => {
  const good = {
    resource_kind: "filing-history",
    resource_uri: "/company/10705011/filing-history/abc",
    data: { transaction_id: "tx1", type: "DS01", date: "2026-09-30", description: "d" },
    event: { timepoint: 243837355 },
  };
  const parsed = parseFilingEvent(good);
  assert.equal(parsed?.companyNumber, "10705011");
  assert.equal(parsed?.type, "DS01");
  assert.equal(parsed?.timepoint, 243837355);
  assert.equal(parseFilingEvent({ resource_uri: "/company/1/filing-history/x", data: {} }), null); // no transaction id
  assert.equal(parseFilingEvent({ resource_uri: "/officers/1", data: { transaction_id: "t" } }), null); // not filing-history
  assert.equal(parseFilingEvent(null), null);
  assert.equal(parseFilingEvent("garbage"), null);
  assert.equal(parseFilingEvent(42), null);
  assert.equal(parseFilingEvent({ resource_uri: "/company/sc123456/filing-history/x", data: { transaction_id: "t" } })?.companyNumber, "SC123456");
});

// ---- company age display ------------------------------------------------------------
test("displayed age uses calendar dates", () => {
  const now = new Date("2026-09-30T23:59:00Z");
  assert.equal(companyAgeYears(new Date("2016-09-30T00:00:00Z"), now), 10);
  assert.equal(companyAgeYears(new Date("2016-10-01T00:00:00Z"), now), 9);
  assert.equal(companyAgeYears(new Date("2026-09-30T00:00:00Z"), now), 0);
});

// ---- ZIP input -----------------------------------------------------------------------
test("a real ZIP is opened and streamed as CSV (not parsed as zip bytes)", async () => {
  const zip = path.resolve(__dirname, "../fixtures/real-sample-59-rows.zip");
  const src = await openCsvFile(zip);
  let text = "";
  for await (const chunk of src.stream) text += chunk.toString("utf8");
  src.close();
  assert.ok(text.startsWith("CompanyName"), "first bytes must be the CSV header, not 'PK'");
  assert.ok(text.includes("RegAddress.PostCode"));
  assert.equal(text.split("\n").filter(Boolean).length, 60);
  assert.match(src.fingerprint, /real-sample-59-rows\.zip\|\d+\|\d+/);
});
