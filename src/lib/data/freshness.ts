import { db } from "@/lib/db";

// "When was the company data last brought up to date from Companies House?"
//
// This is the finish time of the newest successful (or partial) company-data sync: the monthly bulk file or the
// new-registrations sync. It deliberately does NOT use the filing stream's last event or the daily recompute: those
// show that a job is alive, not that new registrations and changed details have been loaded (the stream alone only
// ever carried strike-off filings). If no such sync has ever run it falls back to the older stream / daily timestamps so
// a fresh install does not show an empty value.
export interface DataFreshness {
  lastUpdated: Date | null;
  // Last incorporation day the new-registrations sync has fully stored (YYYY-MM-DD).
  registrationsThrough: string | null;
  // As-of date of the newest monthly bulk file that was loaded (YYYY-MM-DD).
  bulkSnapshot: string | null;
}

export async function getDataFreshness(): Promise<DataFreshness> {
  const ok = { in: ["success", "partial"] };
  const [bulk, reg, regCovered, checkpoint, daily] = await Promise.all([
    db.ingestionRun.findFirst({ where: { kind: "bulk_csv", status: ok }, orderBy: { startedAt: "desc" }, select: { finishedAt: true, statsJson: true } }),
    db.ingestionRun.findFirst({ where: { kind: "new_registrations", status: ok }, orderBy: { startedAt: "desc" }, select: { finishedAt: true } }),
    db.ingestionRun.findFirst({ where: { kind: "new_registrations", checkpoint: { not: null, lte: new Date().toISOString().slice(0, 10) } }, orderBy: { checkpoint: "desc" }, select: { checkpoint: true } }),
    db.streamCheckpoint.findUnique({ where: { name: "filings" }, select: { lastEventAt: true } }),
    db.ingestionRun.findFirst({ where: { kind: "daily_update", status: ok }, orderBy: { startedAt: "desc" }, select: { finishedAt: true } }),
  ]);

  let bulkSnapshot: string | null = null;
  try {
    bulkSnapshot = bulk?.statsJson ? ((JSON.parse(bulk.statsJson) as { snapshotDate?: string | null }).snapshotDate ?? null) : null;
  } catch {
    /* unreadable stats: unknown */
  }

  const synced = [bulk?.finishedAt, reg?.finishedAt].filter((d): d is Date => !!d);
  const candidates = synced.length ? synced : [checkpoint?.lastEventAt, daily?.finishedAt].filter((d): d is Date => !!d);
  const lastUpdated = candidates.length ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : null;
  return { lastUpdated, registrationsThrough: regCovered?.checkpoint ?? null, bulkSnapshot };
}
