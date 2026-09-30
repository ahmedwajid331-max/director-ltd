import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { compileFilterToWhere } from "@/lib/filters/compile";
import { visibleCompaniesWhere } from "./scope";

export const SORTABLE_FIELDS = [
  "name",
  "companyNumber",
  "incorporationDate",
  "status",
  "directorCount",
  "accountsNextDue",
  "registeredPostcode",
] as const;

export type SortableField = (typeof SORTABLE_FIELDS)[number];

export interface CompanySearchParams {
  where: Prisma.CompanyWhereInput;
  sortField?: SortableField;
  sortDir?: "asc" | "desc";
  page: number;
  pageSize: number;
}

export function isSortableField(value: string | null | undefined): value is SortableField {
  return !!value && (SORTABLE_FIELDS as readonly string[]).includes(value);
}

export type CompanyScope = "all" | "followed" | "trashed" | "none";

// The single place a company query is assembled, shared by search, export,
// reports and the daily refresh so the same filter can never mean two things.
//   filter - untrusted filter tree (validated; throws FilterValidationError)
//   q      - free-text box: name / company number / postcode
//   scope  - per-user CRM view; "none" applies no per-user trash logic
export function buildCompanyWhere(opts: {
  filter?: unknown;
  q?: string;
  scope?: CompanyScope;
  userId?: string;
}): Prisma.CompanyWhereInput {
  const and: Prisma.CompanyWhereInput[] = [visibleCompaniesWhere(), compileFilterToWhere(opts.filter ?? null)];

  const term = opts.q?.trim();
  if (term) {
    and.push({
      OR: [
        { name: { contains: term, mode: "insensitive" } },
        { companyNumber: { contains: term.toUpperCase() } },
        { registeredPostcode: { contains: term.toUpperCase() } },
      ],
    });
  }

  const scope = opts.scope ?? "none";
  if (opts.userId && (scope === "followed" || scope === "trashed")) {
    and.push({
      userStates: {
        some: { userId: opts.userId, ...(scope === "followed" ? { followed: true } : { trashed: true }) },
      },
    });
  } else if (opts.userId && scope === "all") {
    and.push({ NOT: { userStates: { some: { userId: opts.userId, trashed: true } } } });
  }

  return { AND: and };
}

// Server-side pagination + filtering + sorting only. Never fetch the full
// result set into memory - the dataset is designed to scale to the full
// ~5.6M Companies House register. `id` is always the final sort key so rows
// never repeat or vanish between pages when the chosen column has ties.
// Nullable columns (accountsNextDue) always sort NULLs last in both directions.
export async function searchCompanies({ where, sortField = "name", sortDir = "asc", page, pageSize }: CompanySearchParams) {
  const skip = Math.max(0, (page - 1) * pageSize);

  const [rows, total] = await db.$transaction([
    db.company.findMany({
      where,
      orderBy: [
        sortField === "accountsNextDue" ? { accountsNextDue: { sort: sortDir, nulls: "last" } } : { [sortField]: sortDir },
        { id: "asc" },
      ],
      skip,
      take: pageSize,
    }),
    db.company.count({ where }),
  ]);

  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function getCompanyById(id: string) {
  return db.company.findUnique({
    where: { id },
    include: {
      directors: { orderBy: [{ resignedOn: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }] },
    },
  });
}

// Streams matching rows in fixed-size batches via a cursor so exports never
// hold the full result set in memory, however large the underlying query.
export async function* iterateCompanies(where: Prisma.CompanyWhereInput, batchSize = 500) {
  let cursor: string | undefined;
  while (true) {
    const batch = await db.company.findMany({
      where,
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) return;
    yield batch;
    cursor = batch[batch.length - 1].id;
    if (batch.length < batchSize) return;
  }
}
