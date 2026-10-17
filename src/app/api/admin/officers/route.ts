import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { hasRole } from "@/lib/auth/guard";
import { loadOfficerPipelineStatus } from "@/lib/companies-house/officerStatus";
import { retryParkedJobs } from "@/lib/companies-house/officerQueue";
import { resetBreaker } from "@/lib/companies-house/breaker";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Super Admin only. GET = pipeline health (never includes API keys);
// POST = manual recovery actions.
export async function GET() {
  const session = await getSession();
  if (!hasRole(session, "SUPER_ADMIN")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json(await loadOfficerPipelineStatus());
}

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("retry_parked"), companyIds: z.array(z.string().max(60)).max(1000).optional() }),
  z.object({ action: z.literal("reset_breaker"), breaker: z.enum(["auth", "outage"]) }),
]);

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || !hasRole(session, "SUPER_ADMIN")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  if (parsed.data.action === "retry_parked") {
    const requeued = await retryParkedJobs({ companyIds: parsed.data.companyIds });
    await db.activityLog.create({ data: { userId: session.userId, action: "officer_retry_parked", meta: JSON.stringify({ requeued }) } });
    return NextResponse.json({ requeued });
  }
  await resetBreaker(parsed.data.breaker);
  await db.activityLog.create({ data: { userId: session.userId, action: "ch_breaker_reset", meta: JSON.stringify({ breaker: parsed.data.breaker }) } });
  return NextResponse.json({ ok: true });
}
