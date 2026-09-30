// CSV output helpers.
//
// Formula injection: a spreadsheet treats a cell starting with = + - @ (or a
// tab / carriage return) as a formula. Company names and addresses come from
// a public register and users can type into notes, so every text cell that
// starts with one of those characters is prefixed with a single quote, which
// spreadsheets display as plain text. Ordinary values are never altered.
const FORMULA_START = /^[=+\-@\t\r]/;

export function neutraliseFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

export function csvCell(value: string | number | boolean | null | undefined): string {
  const text = neutraliseFormula(value === null || value === undefined ? "" : String(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(values: Array<string | number | boolean | null | undefined>): string {
  return values.map(csvCell).join(",");
}
