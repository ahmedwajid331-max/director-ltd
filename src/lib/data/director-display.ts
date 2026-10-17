// How a list row / export shows the director figure. directorCount defaults
// to 0 before any officer fetch, so 0 alone cannot tell "not fetched" from
// "fetched, none counted"; officersCoverage is the discriminator:
//   full         confirmed count (may still be stale / dirty - see below)
//   none         officers never fetched
//   unavailable  Companies House has no officer data for the company
// Staleness is derived from timestamps, never stored.
export type OfficerCoverage = "none" | "full" | "unavailable";
export type OfficerFreshness = "none" | "unavailable" | "fresh" | "stale" | "dirty";

export interface OfficerRowFields {
  officersCoverage?: string | null;
  officersFetchedAt?: Date | string | null;
  officersDirtyAt?: Date | string | null;
  officerFreshness?: OfficerFreshness | null; // already derived server-side
  directorCount: number;
  singleDirector: boolean;
}

const asDate = (d: Date | string | null | undefined) => (d ? new Date(d) : null);

// dirty = an officer filing was seen after the data was fetched
// stale = fetched longer ago than staleAfterDays
export function officerFreshness(
  row: { officersCoverage?: string | null; officersFetchedAt?: Date | string | null; officersDirtyAt?: Date | string | null },
  now: Date = new Date(),
  staleAfterDays = 180
): OfficerFreshness {
  if (row.officersCoverage === "unavailable") return "unavailable";
  if (row.officersCoverage !== "full") return "none";
  const fetched = asDate(row.officersFetchedAt);
  const dirty = asDate(row.officersDirtyAt);
  if (dirty && (!fetched || dirty > fetched)) return "dirty";
  if (!fetched || now.getTime() - fetched.getTime() > staleAfterDays * 86_400_000) return "stale";
  return "fresh";
}

export type DirectorDisplay =
  | { state: "not_fetched"; label: string; tooltip: string }
  | { state: "unavailable"; label: string; tooltip: string }
  | { state: "fetched"; label: string; count: number; single: boolean; freshness: "fresh" | "stale" | "dirty"; tooltip: string | null };

export function directorDisplay(row: OfficerRowFields): DirectorDisplay {
  if (row.officersCoverage === "unavailable") {
    return {
      state: "unavailable",
      label: "Unavailable",
      tooltip: "Companies House has no officer data for this company. It is not counted as zero directors.",
    };
  }
  if (row.officersCoverage !== "full") {
    return {
      state: "not_fetched",
      label: "Not fetched",
      tooltip: "Officer data has not been fetched yet. Open the company to load it.",
    };
  }
  // The server derives freshness (it knows the configured TTL); fall back to
  // timestamps with the default TTL when a row did not carry it.
  const derived = row.officerFreshness ?? officerFreshness(row);
  const freshness = derived === "stale" || derived === "dirty" ? derived : "fresh";
  return {
    state: "fetched",
    label: String(row.directorCount),
    count: row.directorCount,
    single: row.singleDirector,
    freshness,
    tooltip:
      freshness === "dirty"
        ? "Last confirmed count. A change to the officers has been filed and is waiting to be re-checked."
        : freshness === "stale"
          ? "Last confirmed count. Officer data was not verified recently."
          : null,
  };
}

// CSV cells: director count, single director, officer data as of. Confirmed
// values only for fully fetched officer data; otherwise a clear label rather
// than a false 0 / "No". Never calls Companies House.
export function directorCsvCells(row: OfficerRowFields, now: Date = new Date(), staleAfterDays = 180): [string | number, string, string] {
  if (row.officersCoverage === "unavailable") return ["Unavailable", "Unavailable", "Unavailable"];
  if (row.officersCoverage !== "full") return ["Not fetched", "Not fetched", "Not fetched"];
  const freshness = officerFreshness(row, now, staleAfterDays);
  const fetched = asDate(row.officersFetchedAt);
  const date = fetched ? fetched.toISOString().slice(0, 10) : "";
  const asOf = freshness === "dirty" ? `${date} (changes pending)` : freshness === "stale" ? `${date} (stale)` : date;
  return [row.directorCount, row.singleDirector ? "Yes" : "No", asOf];
}
