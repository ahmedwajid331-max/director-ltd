import { FIELD_CATALOGUE, defaultEnabled, isSelectable } from "./catalogue";

// Pure rules for column lists. No database, no I/O: everything here is unit-tested.

// The Company column is always first and cannot be removed or moved (the checkbox and row-number columns are
// not part of any list; the table always draws them).
export const LOCKED_FIRST = "name";
export const MAX_COLUMNS = 40;

// Today's table, in today's order. Used until an administrator sets a recommended layout, and as the safe fallback.
export const BUILTIN_DEFAULT: string[] = [
  "name",
  "companyNumber",
  "status",
  "type",
  "incorporationDate",
  "registeredCity",
  "registeredPostcode",
  "directorCount",
  "filingSummary",
];

// The 33 columns of the Phase 1 proposal sent for approval: today's nine, then the 24 additional stored-field columns
// (Part B2 of that proposal), in a logical reading order. There is no written specification of Nick's columns in the
// repository; this list is the one that was proposed. It is the seeded recommended default, and the Super Admin tool
// can change it without code. Every key is selectable and has a cell renderer (unit-tested).
export const PHASE1_COLUMNS: string[] = [
  ...BUILTIN_DEFAULT,
  "companyAgeYears",
  "statusDetail",
  "registeredAddress1",
  "registeredAddress2",
  "registeredCounty",
  "sicCodes",
  "accountsNextDue",
  "accountsLastMadeUp",
  "accountsOverdue",
  "confirmationNextDue",
  "confirmationLastMadeUp",
  "confirmationOverdue",
  "dormant",
  "accountType",
  "hasDS01",
  "ds01FiledAt",
  "officersCoverage",
  "officersFetchedAt",
  "singleDirector",
  "followed",
  "saved",
  "redFlagged",
  "source",
  "chLastFetchedAt",
];

// Fields the user may display: selectable AND switched on. `settings` holds only the switches an administrator has
// explicitly flipped; every other field takes its catalogue default.
export function enabledKeys(settings: ReadonlyMap<string, boolean>): Set<string> {
  const out = new Set<string>();
  for (const d of FIELD_CATALOGUE) {
    if (!isSelectable(d.key)) continue;
    const on = settings.get(d.key);
    if (on === undefined ? defaultEnabled(d.key) : on) out.add(d.key);
  }
  // The Company column can never be switched off.
  out.add(LOCKED_FIRST);
  return out;
}

export type ColumnListResult = { ok: true; columns: string[] } | { ok: false; error: string };

// Strict validation for anything that is going to be SAVED (layouts and personal preferences).
export function validateColumnList(input: unknown, enabled: ReadonlySet<string>): ColumnListResult {
  if (!Array.isArray(input) || input.some((k) => typeof k !== "string")) return { ok: false, error: "Columns must be a list of column keys." };
  const cols = input as string[];
  if (cols.length === 0) return { ok: false, error: "Choose at least one column." };
  if (cols.length > MAX_COLUMNS) return { ok: false, error: `Choose at most ${MAX_COLUMNS} columns.` };
  if (new Set(cols).size !== cols.length) return { ok: false, error: "Each column can only appear once." };
  if (cols[0] !== LOCKED_FIRST) return { ok: false, error: "The Company column must stay first." };
  for (const k of cols) {
    if (!isSelectable(k)) return { ok: false, error: `"${k}" is not an available column.` };
    if (!enabled.has(k)) return { ok: false, error: `"${k}" is not enabled for users.` };
  }
  return { ok: true, columns: cols };
}

// Lenient resolution for DISPLAY: a saved list may contain fields an administrator has since switched off, or keys
// from an older catalogue. Those are skipped here (never deleted from storage), the Company column is forced first,
// duplicates are dropped, and an empty result falls back to the safe default.
export function effectiveColumns(saved: readonly string[] | null | undefined, enabled: ReadonlySet<string>, fallback: readonly string[] = BUILTIN_DEFAULT): string[] {
  const source = saved && saved.length ? saved : fallback;
  const seen = new Set<string>();
  const out: string[] = [LOCKED_FIRST];
  seen.add(LOCKED_FIRST);
  for (const k of source) {
    if (seen.has(k) || !isSelectable(k) || !enabled.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= MAX_COLUMNS) break;
  }
  return out.length > 1 || source === fallback ? out : effectiveColumns(null, enabled, fallback);
}

export function parseColumnsJson(json: string | null | undefined): string[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.every((k) => typeof k === "string")) return parsed as string[];
  } catch {
    /* fall through */
  }
  return null;
}

export interface PreferenceState {
  columns: string[];
  baseLayoutId: string | null;
  baseLayoutVersion: number | null;
}

export interface DefaultLayoutState {
  id: string;
  version: number;
}

// A user who saved their own list is told when the recommendation they started from has since changed.
// Nothing is ever applied automatically.
export function recommendedChanged(pref: PreferenceState | null, def: DefaultLayoutState | null): boolean {
  if (!pref || !def) return false;
  if (pref.baseLayoutId !== def.id) return true;
  return (pref.baseLayoutVersion ?? 0) < def.version;
}
