import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

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

// Server-side pagination + filtering + sorting only. Never fetch the full
// result set into memory — the dataset is designed to scale to the full
// ~5.6M Companies House register.
export async function searchCompanies({ where, sortField = "name", sortDir = "asc", page, pageSize }: CompanySearchParams) {
  const skip = Math.max(0, (page - 1) * pageSize);

  const [rows, total] = await db.$transaction([
    db.company.findMany({
      where,
      orderBy: { [sortField]: sortDir },
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
      directors: { orderBy: { createdAt: "asc" } },
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
