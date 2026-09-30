import type { IngestionRun } from "@prisma/client";
import { db } from "@/lib/db";
import { effectiveStatus } from "./runs";

export const RUN_KINDS = ["advanced_search", "bulk_csv", "stream", "officer_backfill", "daily_update"] as const;

export const RUN_KIND_LABELS: Record<string, string> = {
  advanced_search: "Advanced Search sample ingest",
  bulk_csv: "Monthly bulk CSV ingest",
  stream: "Filing stream (DS01 etc.)",
  officer_backfill: "Officer backfill",
  daily_update: "Daily update",
};

// Approximate size of the Companies House register, used only to express
// coverage honestly ("N of roughly 5.6 million").
export const REGISTER_SIZE_ESTIMATE = 5_600_000;

export function coverageLabel(realCompanies: number): string {
  if (realCompanies === 0) return "No real Companies House data loaded yet";
  const pct = (realCompanies / REGISTER_SIZE_ESTIMATE) * 100;
  const pctText = pct < 0.01 ? "<0.01%" : pct < 1 ? `${pct.toFixed(2)}%` : `${pct.toFixed(1)}%`;
  return `${realCompanies.toLocaleString()} of roughly 5.6 million registered companies (${pctText})`;
}

export interface RunView {
  run: IngestionRun | null;
  status: string; // running | success | partial | failed | stalled
  tone: "green" | "blue" | "amber" | "red";
  detail: string;
}

export async function loadLatestRuns(): Promise<RunView[]> {
  const runs = await Promise.all(RUN_KINDS.map((kind) => db.ingestionRun.findFirst({ where: { kind }, orderBy: { startedAt: "desc" } })));
  return runs.map((run) => {
    if (!run) return { run: null, status: "never", tone: "amber", detail: "" };
    const status = effectiveStatus(run);
    const tone = status === "success" ? "green" : status === "running" ? "blue" : status === "partial" ? "amber" : "red";
    const parts: string[] = [];
    if (run.rowsRead > 0) parts.push(`${run.rowsRead.toLocaleString()} read`);
    if (run.rowsFailed + run.rowsSkipped > 0) parts.push(`${(run.rowsFailed + run.rowsSkipped).toLocaleString()} failed/skipped`);
    if (status === "stalled") parts.push("no heartbeat - presumed dead");
    return { run, status, tone, detail: parts.join(" · ") };
  });
}
