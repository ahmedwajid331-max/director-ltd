import { test } from "node:test";
import assert from "node:assert/strict";
import { directorDisplay, directorCsvCells, officerFreshness } from "../../src/lib/data/director-display";

const NOW = new Date("2026-10-01T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

// ---- UI: data state is "none | full | unavailable" ---------------------------------------------
test("not fetched is not shown as zero directors", () => {
  for (const coverage of ["none", "partial", "", undefined]) {
    const d = directorDisplay({ officersCoverage: coverage, directorCount: 0, singleDirector: false });
    assert.equal(d.state, "not_fetched");
    assert.notEqual(d.label, "0");
  }
});

test("unavailable is its own state: never a zero count", () => {
  const d = directorDisplay({ officersCoverage: "unavailable", directorCount: 0, singleDirector: false });
  assert.equal(d.state, "unavailable");
  assert.equal(d.label, "Unavailable");
  assert.notEqual(d.label, "0");
});

test("fetched with zero directors shows 0 and no Single", () => {
  const d = directorDisplay({ officersCoverage: "full", officersFetchedAt: daysAgo(1), directorCount: 0, singleDirector: false });
  assert.equal(d.state, "fetched");
  if (d.state === "fetched") {
    assert.equal(d.label, "0");
    assert.equal(d.single, false);
    assert.equal(d.freshness, "fresh");
    assert.equal(d.tooltip, null);
  }
});

test("fetched with one director shows 1 + Single", () => {
  const d = directorDisplay({ officersCoverage: "full", officersFetchedAt: daysAgo(1), directorCount: 1, singleDirector: true });
  assert.equal(d.state === "fetched" && d.label, "1");
  assert.equal(d.state === "fetched" && d.single, true);
});

test("fetched with several directors shows the stored count", () => {
  const d = directorDisplay({ officersCoverage: "full", officersFetchedAt: daysAgo(1), directorCount: 3, singleDirector: false });
  assert.equal(d.state === "fetched" && d.label, "3");
});

// ---- freshness is derived from timestamps, never a stored state ----------------------------------
test("freshness: fresh / stale / dirty are derived; the last confirmed count is kept", () => {
  assert.equal(officerFreshness({ officersCoverage: "full", officersFetchedAt: daysAgo(10) }, NOW, 180), "fresh");
  assert.equal(officerFreshness({ officersCoverage: "full", officersFetchedAt: daysAgo(200) }, NOW, 180), "stale");
  // an officer filing seen AFTER the fetch -> dirty (wins over stale)
  assert.equal(officerFreshness({ officersCoverage: "full", officersFetchedAt: daysAgo(200), officersDirtyAt: daysAgo(2) }, NOW, 180), "dirty");
  // a dirty flag OLDER than the fetch has already been covered by that fetch
  assert.equal(officerFreshness({ officersCoverage: "full", officersFetchedAt: daysAgo(1), officersDirtyAt: daysAgo(5) }, NOW, 180), "fresh");
  assert.equal(officerFreshness({ officersCoverage: "none" }, NOW), "none");
  assert.equal(officerFreshness({ officersCoverage: "unavailable" }, NOW), "unavailable");

  const dirty = directorDisplay({ officersCoverage: "full", officersFetchedAt: daysAgo(30), officersDirtyAt: daysAgo(1), directorCount: 2, singleDirector: false });
  assert.equal(dirty.state === "fetched" && dirty.label, "2", "dirty data keeps its last confirmed count");
  assert.equal(dirty.state === "fetched" && dirty.freshness, "dirty");
  assert.ok(dirty.state === "fetched" && dirty.tooltip);
});

// ---- CSV: confirmed values only for fully fetched officer data -------------------------------------
test("CSV shows confirmed values only for fully fetched officer data", () => {
  const f = (directorCount: number, singleDirector: boolean) => directorCsvCells({ officersCoverage: "full", officersFetchedAt: new Date("2026-09-30T08:00:00Z"), directorCount, singleDirector }, NOW);
  assert.deepEqual(f(0, false), [0, "No", "2026-09-30"]);
  assert.deepEqual(f(1, true), [1, "Yes", "2026-09-30"]);
  assert.deepEqual(f(4, false), [4, "No", "2026-09-30"]);
});

test("CSV never represents unfetched or unavailable data as 0 / No", () => {
  for (const coverage of ["none", "partial", "", null, undefined]) {
    assert.deepEqual(directorCsvCells({ officersCoverage: coverage, directorCount: 0, singleDirector: false }, NOW), ["Not fetched", "Not fetched", "Not fetched"]);
  }
  assert.deepEqual(directorCsvCells({ officersCoverage: "unavailable", directorCount: 0, singleDirector: false }, NOW), ["Unavailable", "Unavailable", "Unavailable"]);
});

test("CSV keeps confirmed values for stale / dirty data and says so in the as-of column", () => {
  const stale = directorCsvCells({ officersCoverage: "full", officersFetchedAt: new Date("2026-01-01T00:00:00Z"), directorCount: 2, singleDirector: false }, NOW, 180);
  assert.deepEqual(stale, [2, "No", "2026-01-01 (stale)"]);
  const dirty = directorCsvCells({ officersCoverage: "full", officersFetchedAt: new Date("2026-09-01T00:00:00Z"), officersDirtyAt: new Date("2026-09-20T00:00:00Z"), directorCount: 1, singleDirector: true }, NOW, 180);
  assert.deepEqual(dirty, [1, "Yes", "2026-09-01 (changes pending)"]);
});
