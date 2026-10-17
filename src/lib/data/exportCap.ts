import type { UserRole } from "@/lib/types";

// Row cap per role for any export (CSV, PDF, Word), env-configurable, so one request cannot walk off with the whole
// register. CSV, PDF and Word all stream, so this is a policy limit (who may take how much), not a memory limit.
export function exportCap(role: UserRole): number {
  const pick = (name: string, fallback: number) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  if (role === "SUPER_ADMIN") return pick("EXPORT_MAX_ROWS_SUPER", 1_000_000);
  if (role === "ADMIN") return pick("EXPORT_MAX_ROWS_ADMIN", 250_000);
  return pick("EXPORT_MAX_ROWS_USER", 50_000);
}

// Excel is the one format still built in memory (a single worksheet), so it has its own lower ceiling. Above it the
// request is refused with a clear message pointing at CSV - never silently truncated.
export function spreadsheetExportCap(role: UserRole): number {
  const n = Number(process.env.EXPORT_MAX_ROWS_XLSX);
  return Math.min(exportCap(role), Number.isFinite(n) && n > 0 ? n : 50_000);
}
