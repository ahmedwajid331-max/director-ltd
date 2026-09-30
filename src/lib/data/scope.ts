import type { Prisma } from "@prisma/client";

// Real vs development ("seed") data.
//
// Every company row carries a provenance in `source`. "seed" rows are
// synthetic development data and must never be presented as Companies House
// data. SEED_DATA_VISIBLE controls whether they appear in search, reports,
// exports and counts:
//   - unset + development  -> visible (so a fresh checkout has something to click)
//   - unset + production   -> hidden
//   - "true" / "false"     -> explicit override
export function seedDataVisible(): boolean {
  const v = process.env.SEED_DATA_VISIBLE?.toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return process.env.NODE_ENV !== "production";
}

// Always AND this into any user-facing company query or count.
export function visibleCompaniesWhere(): Prisma.CompanyWhereInput {
  return seedDataVisible() ? {} : { source: { not: "seed" } };
}

export const REAL_COMPANIES_WHERE: Prisma.CompanyWhereInput = { source: { not: "seed" } };
