import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { compileFilterToWhere } from "@/lib/filters/compile";
import { isSortableField, searchCompanies } from "@/lib/data/companies";
import type { Prisma } from "@prisma/client";

const bodySchema = z.object({
  filter: z.any().optional(),
  q: z.string().optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  sortField: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  scope: z.enum(["all", "followed", "trashed"]).optional(),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const { filter, q, page, pageSize, sortField, sortDir, scope } = parsed.data;

  let where: Prisma.CompanyWhereInput = compileFilterToWhere(filter ?? null);

  if (q && q.trim()) {
    const term = q.trim();
    where = {
      AND: [
        where,
        {
          OR: [
            { name: { contains: term } },
            { companyNumber: { contains: term } },
            { registeredPostcode: { contains: term } },
          ],
        },
      ],
    };
  }

  if (scope === "followed" || scope === "trashed") {
    where = {
      AND: [
        where,
        {
          userStates: {
            some: {
              userId: session.userId,
              ...(scope === "followed" ? { followed: true } : { trashed: true }),
            },
          },
        },
      ],
    };
  } else {
    // Default view excludes trashed companies for this user.
    where = {
      AND: [
        where,
        {
          NOT: {
            userStates: { some: { userId: session.userId, trashed: true } },
          },
        },
      ],
    };
  }

  const result = await searchCompanies({
    where,
    sortField: isSortableField(sortField) ? sortField : "name",
    sortDir: sortDir ?? "asc",
    page,
    pageSize,
  });

  const states = await db.userCompanyState.findMany({
    where: { userId: session.userId, companyId: { in: result.rows.map((r) => r.id) } },
  });
  const stateMap = new Map(states.map((s) => [s.companyId, s]));

  return NextResponse.json({
    ...result,
    rows: result.rows.map((row) => ({
      ...row,
      followed: stateMap.get(row.id)?.followed ?? false,
      trashed: stateMap.get(row.id)?.trashed ?? false,
    })),
  });
}
