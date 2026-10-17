import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { resolveStatePatch, statePatchSchema } from "@/lib/data/company-state";

// Bulk version of POST /api/companies/[id]/state for the rows selected on one
// results page. Strictly the caller's own state; the cap matches the maximum
// search page size, so selection is never an unbounded list.
const MAX_IDS = 100;

const bodySchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_IDS),
  patch: statePatchSchema,
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "crm.manage");
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  // Never trust client ids: keep only companies that exist.
  const requested = [...new Set(parsed.data.ids)];
  const existing = await db.company.findMany({ where: { id: { in: requested } }, select: { id: true, name: true } });
  if (existing.length === 0) return NextResponse.json({ error: "Company not found" }, { status: 404 });
  const ids = existing.map((c) => c.id);

  const next = resolveStatePatch(parsed.data.patch);
  const userId = session.userId;

  await db.$transaction([
    db.userCompanyState.createMany({
      data: ids.map((companyId) => ({ userId, companyId })),
      skipDuplicates: true,
    }),
    db.userCompanyState.updateMany({ where: { userId, companyId: { in: ids } }, data: next }),
  ]);

  // One event per company, so "which companies did this person work on" includes bulk changes (previously a single event
  // with only a count, which could not be attributed to any company). Same event type and wording as the single-company route.
  await db.activityLog.createMany({
    data: existing.map((c) => ({
      userId,
      action: "company_state_change",
      meta: JSON.stringify({ companyName: c.name, ...parsed.data.patch, bulk: true }),
      companyId: c.id,
      sessionId: session.sid ?? null,
    })),
  });

  return NextResponse.json({ updated: ids.length, skipped: requested.length - ids.length, patch: next });
}
