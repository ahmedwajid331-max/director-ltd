import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { exportReportDocument } from "@/lib/reports/exportDocument";

const bodySchema = z.object({
  format: z.enum(["pdf", "docx", "xlsx"]),
  filter: z.unknown().optional(),
  columns: z.array(z.string().max(60)).max(100).nullish(),
  sortField: z.string().max(60).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  name: z.string().max(120).optional(),
});

// Export of the Report Builder's CURRENT results without saving a report first. It evaluates exactly the conditions sent
// (same parser, same compiler, same access, narrowing and row-ceiling rules as a saved report - see
// lib/reports/exportDocument.ts) and never creates or changes a saved report. CSV uses /api/companies/export as before.
// PDF and Word need the same permission as on a saved report; Excel is a spreadsheet export like CSV.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { format } = parsed.data;

  const denied = denyUnless(session, format === "xlsx" ? "reports.exportCsv" : "reports.exportDocs");
  if (denied) return denied;

  const title = parsed.data.name?.trim() || "DIRECTOR.LTD companies export";
  return exportReportDocument(session, {
    format,
    rawFilter: parsed.data.filter ?? null,
    ownerId: session.userId,
    savedColumns: parsed.data.columns ?? null,
    savedSort: null,
    requestedSortField: parsed.data.sortField ?? null,
    requestedSortDir: parsed.data.sortDir ?? null,
    title,
    description: null,
    subject: "These results",
    activity: { meta: { name: title, unsaved: true } },
  });
}
