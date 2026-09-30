// Explicit date parsing. `new Date("11/09/2012")` is locale/engine dependent
// (it reads 9 November) and yields Invalid Date for "30/06/2027" - it must
// never touch Companies House dates. All dates here are calendar dates
// stored as UTC midnight, matching the SQL DATE columns.

function buildUtcDate(year: number, month: number, day: number): Date | null {
  // Real register data includes very old Royal Charter companies (e.g. 24/07/1604).
  if (year < 1000 || year > 2200) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Round-trip check rejects 31/02, 29/02 in non-leap years, etc.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d;
}

// Bulk CSV format: DD/MM/YYYY (e.g. "11/09/2012"). Blank -> null.
// Anything else (including an impossible date) -> null; callers decide
// whether that is a row error (required fields) or a warning (optional).
export function parseUkDate(input: string | null | undefined): Date | null {
  const s = (input ?? "").trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  return buildUtcDate(Number(m[3]), Number(m[2]), Number(m[1]));
}

// REST/stream format: YYYY-MM-DD.
export function parseChDate(input: string | null | undefined): Date | null {
  const s = (input ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return buildUtcDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function isBlankDate(input: string | null | undefined): boolean {
  return (input ?? "").trim() === "";
}
