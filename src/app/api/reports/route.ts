import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { compileFilterToWhere } from "@/lib/filters/compile";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const reports = await db.report.findMany({
    where: { ownerId: session.userId },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ reports });
}

const bodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  filter: z.any(),
  dailyRefresh: z.boolean().default(true),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Give the report a name." }, { status: 400 });

  const where = compileFilterToWhere(parsed.data.filter);
  const resultCount = await db.company.count({ where });

  const report = await db.report.create({
    data: {
      ownerId: session.userId,
      name: parsed.data.name,
      description: parsed.data.description || null,
      filterJson: JSON.stringify(parsed.data.filter),
      dailyRefresh: parsed.data.dailyRefresh,
      resultCount,
      lastRunAt: new Date(),
    },
  });

  await db.activityLog.create({
    data: {
      userId: session.userId,
      action: "report_created",
      meta: JSON.stringify({ reportId: report.id, name: report.name }),
    },
  });

  return NextResponse.json({ report });
}
