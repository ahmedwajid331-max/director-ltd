import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { buildCompanyWhere, iterateCompanies } from "@/lib/data/companies";
import { csvLine } from "@/lib/data/csv";
import { formatDateOnly, formatAddress, STATUS_LABELS, typeLabel } from "@/lib/data/format";
import { parseFilter } from "@/lib/filters/validate";
import { countActiveRules } from "@/lib/filters/types";
import type { CompanyStatus, UserRole } from "@/lib/types";

const bodySchema = z.object({
  filter: z.unknown().optional(),
  q: z.string().max(200).optional(),
  scope: z.enum(["all", "followed", "trashed"]).optional(),
});

const CSV_HEADERS = [
  "Company number",
  "Name",
  "Status",
  "Type",
  "Incorporated",
  "Dormant",
  "Address",
  "Director count",
  "Single director",
  "Accounts overdue",
  "Confirmation overdue",
  "DS01 filed",
];

// Export boundary. Anyone signed in can export the results of a filter they
// can already see on screen, but:
//  - a plain USER must narrow the register first (a filter or search term) -
//    "export everything" is not available to them;
//  - every role has a row cap (env-configurable), so one request cannot walk
//    off with the whole register or exhaust the server;
//  - every export is written to the activity log.
function exportCap(role: UserRole): number {
  const pick = (name: string, fallback: number) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  if (role === "SUPER_ADMIN") return pick("EXPORT_MAX_ROWS_SUPER", 1_000_000);
  if (role === "ADMIN") return pick("EXPORT_MAX_ROWS_ADMIN", 250_000);
  return pick("EXPORT_MAX_ROWS_USER", 50_000);
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const parsedFilter = parseFilter(parsed.data.filter ?? null);
  if (!parsedFilter.ok) {
    return NextResponse.json({ error: "Invalid filter.", details: parsedFilter.errors.slice(0, 10) }, { status: 400 });
  }

  const activeRules = parsedFilter.filter ? countActiveRules(parsedFilter.filter) : 0;
  const hasSearch = !!parsed.data.q?.trim();
  if (session.role === "USER" && activeRules === 0 && !hasSearch && !parsed.data.scope) {
    return NextResponse.json(
      { error: "Add at least one filter or a search term before exporting - exporting the entire register is not available." },
      { status: 403 }
    );
  }

  const where = buildCompanyWhere({
    filter: parsed.data.filter,
    q: parsed.data.q,
    scope: parsed.data.scope ?? "none",
    userId: session.userId,
  });

  const cap = exportCap(session.role);
  const total = await db.company.count({ where });
  if (total > cap) {
    return NextResponse.json(
      { error: `This export has ${total.toLocaleString()} rows; your limit is ${cap.toLocaleString()}. Narrow the filter and try again.` },
      { status: 413 }
    );
  }

  await db.activityLog.create({
    data: {
      userId: session.userId,
      action: "export_csv",
      meta: JSON.stringify({ rows: total, activeRules, q: parsed.data.q?.slice(0, 80) ?? null }),
    },
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(csvLine(CSV_HEADERS) + "\r\n"));
        // Streamed in fixed-size batches so exports stay memory-safe no matter
        // how large the matching result set is.
        for await (const batch of iterateCompanies(where, 500)) {
          const lines = batch
            .map((c) =>
              csvLine([
                c.companyNumber,
                c.name,
                STATUS_LABELS[c.status as CompanyStatus] ?? c.status,
                typeLabel(c.type),
                formatDateOnly(c.incorporationDate),
                c.dormant ? "Yes" : "No",
                formatAddress(c),
                c.directorCount,
                c.singleDirector ? "Yes" : "No",
                c.accountsOverdue ? "Yes" : "No",
                c.confirmationOverdue ? "Yes" : "No",
                c.hasDS01 ? "Yes" : "No",
              ])
            )
            .join("\r\n");
          controller.enqueue(encoder.encode(lines + "\r\n"));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="director-ltd-export-${Date.now()}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
