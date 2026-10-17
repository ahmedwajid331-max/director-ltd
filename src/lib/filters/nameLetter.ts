import type { Prisma } from "@prisma/client";

// "Company name begins with this letter" - ONE definition shared by the A-Z bar (buildCompanyWhere) and the
// "Company name starts with letter" filter, so a saved report built from the A-Z bar returns exactly the same
// companies. The range condition lets PostgreSQL start reading the (name, id) index at that letter; the ILIKE keeps the
// match case-insensitive. Measured on the 5.69M-row database: this form returns the first page in about 0 ms, while
// ILIKE alone took 11-13 s (it had to read every earlier letter first).
export const LETTER_OPTIONS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => ({ value: l, label: l }));

export function isNameLetter(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z]$/.test(value);
}

export function nameLetterConditions(letterIn: string): Prisma.CompanyWhereInput[] {
  const letter = letterIn.toUpperCase();
  const next = String.fromCharCode(letter.charCodeAt(0) + 1);
  return [{ name: letter === "Z" ? { gte: letter } : { gte: letter, lt: next } }, { name: { startsWith: letter, mode: "insensitive" } }];
}
