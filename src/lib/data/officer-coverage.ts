import { officerFreshness, type OfficerFreshness } from "./director-display";
import { loadOfficerConfig } from "@/lib/companies-house/officerQueue";

// Server-side helper: attaches the derived officer freshness (none /
// unavailable / fresh / stale / dirty) to company rows so the UI never has to
// know the configured TTL. Staleness is derived from timestamps, never stored.
export function withOfficerFreshness<T extends { officersCoverage: string; officersFetchedAt: Date | null; officersDirtyAt: Date | null }>(
  rows: T[],
  now: Date = new Date()
): (T & { officerFreshness: OfficerFreshness })[] {
  const staleAfterDays = loadOfficerConfig().staleAfterDays;
  return rows.map((r) => ({ ...r, officerFreshness: officerFreshness(r, now, staleAfterDays) }));
}
