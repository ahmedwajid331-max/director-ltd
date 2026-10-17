import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { buildCompanyWhere, countCompanies, iterateCompanies } from "@/lib/data/companies";
import { csvLine } from "@/lib/data/csv";
import { directorCsvCells } from "@/lib/data/director-display";
import { loadOfficerConfig } from "@/lib/companies-house/officerQueue";
import { formatDateOnly, formatAddress, STATUS_LABELS, typeLabel } from "@/lib/data/format";
import { parseFilter } from "@/lib/filters/validate";
import { countActiveRules } from "@/lib/filters/types";
import type { CompanyStatus } from "@/lib/types";
import { exportCap } from "@/lib/data/exportCap";
import { filterAccessResponse, stripDirectorColumns } from "@/lib/auth/access";
import { can } from "@/lib/auth/permissions";
import { logActivity } from "@/lib/activity";
import { BUILTIN_DEFAULT, effectiveColumns, enabledKeys } from "@/lib/columns/resolve";
import { isMissingTable, loadFieldSettings } from "@/lib/columns/store";
import { exportHeaders, exportRow, needsCrmState } from "@/lib/columns/exportCells";

const bodySchema = z.object({
  filter: z.unknown().optional(),
  q: z.string().max(200).optional(),
  namePrefix: z.string().regex(/^[A-Za-z]$/).optional(),
  scope: z.enum(["all", "followed", "saved", "redFlagged", "trashed"]).optional(),
  // Optional: the table's column keys, in order. When present the CSV has exactly those columns (see exportCells.ts);
  // when absent the original fixed 15-column format is produced.
  columns: z.array(z.string().max(60)).max(100).optional(),
});

// "Officer data as of": confirmed rows carry the date officers were last
// verified (suffixed when stale / changes are pending); unfetched and
// unavailable rows say so instead of showing a false 0 / "No".
const CSV_HEADERS = [
  "Company number",
  "Name",
  "Status",
  "Type",
  "Incorporated",
  "Dormant",
  "City/Town",
  "Postcode",
  "Address",
  "Director count",
  "Single director",
  "Officer data as of",
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
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "reports.exportCsv");
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const blocked = filterAccessResponse(session, parsed.data.filter);
  if (blocked) return blocked;

  const parsedFilter = parseFilter(parsed.data.filter ?? null);
  if (!parsedFilter.ok) {
    return NextResponse.json({ error: "Invalid filter.", details: parsedFilter.errors.slice(0, 10) }, { status: 400 });
  }

  const activeRules = parsedFilter.filter ? countActiveRules(parsedFilter.filter) : 0;
  const hasSearch = !!parsed.data.q?.trim() || !!parsed.data.namePrefix;
  // "all" is the default Companies view, not a narrowing: only followed / saved / red-flagged / trashed count as narrowed.
  const narrowedByScope = !!parsed.data.scope && parsed.data.scope !== "all";
  if (session.role === "USER" && activeRules === 0 && !hasSearch && !narrowedByScope) {
    return NextResponse.json(
      { error: "Add at least one filter or a search term before exporting - exporting the entire register is not available." },
      { status: 403 }
    );
  }

  const where = buildCompanyWhere({
    filter: parsed.data.filter,
    q: parsed.data.q,
    namePrefix: parsed.data.namePrefix,
    scope: parsed.data.scope ?? "none",
    userId: session.userId,
  });

  const cap = exportCap(session.role);
  const total = await countCompanies(where);
  if (total > cap) {
    return NextResponse.json(
      { error: `This export has ${total.toLocaleString()} rows; your limit is ${cap.toLocaleString()}. Narrow the filter and try again.` },
      { status: 413 }
    );
  }

  // Column-driven export: only fields that are selectable AND switched on for users can ever be exported (the same rule
  // as the table). Anything else in the request - unknown, unavailable, restricted, internal or switched-off keys - is
  // dropped, never exported. The Company column is always first.
  let cols: string[] | null = null;
  if (parsed.data.columns) {
    let enabled = enabledKeys(new Map());
    try {
      enabled = enabledKeys(await loadFieldSettings());
    } catch (err) {
      if (!isMissingTable(err)) throw err;
    }
    cols = effectiveColumns(parsed.data.columns, enabled, BUILTIN_DEFAULT);
  }

  // Without the director permission the officer columns are left out (the legacy fixed layout is replaced by the default columns).
  if (!can(session, "companies.directors")) {
    cols = stripDirectorColumns(cols ?? effectiveColumns(null, enabledKeys(new Map()), BUILTIN_DEFAULT));
  }

  await logActivity(session, "export_csv", { meta: { rows: total, activeRules, q: parsed.data.q?.slice(0, 80) ?? null, ...(cols ? { columns: cols.length } : {}) } });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(csvLine(cols ? exportHeaders(cols) : CSV_HEADERS) + "\r\n"));
        // Streamed in fixed-size batches so exports stay memory-safe no matter
        // how large the matching result set is.
        const staleAfterDays = loadOfficerConfig().staleAfterDays;
        const now = new Date();
        for await (const batch of iterateCompanies(where, 500, cap)) {
          let lines: string;
          if (cols) {
            // The four CRM markers need this user's own state: one indexed lookup per batch of 500 (never per row).
            let crm: Map<string, { followed: boolean; saved: boolean; redFlagged: boolean; trashed: boolean }> | null = null;
            if (needsCrmState(cols)) {
              const states = await db.userCompanyState.findMany({
                where: { userId: session.userId, companyId: { in: batch.map((c) => c.id) } },
                select: { companyId: true, followed: true, saved: true, redFlagged: true, trashed: true },
              });
              crm = new Map(states.map((st) => [st.companyId, st]));
            }
            lines = batch.map((c) => csvLine(exportRow(c, cols, { now, staleAfterDays, crm: crm?.get(c.id) }))).join("\r\n");
          } else {
            lines = batch
              .map((c) =>
                csvLine([
                  c.companyNumber,
                  c.name,
                  STATUS_LABELS[c.status as CompanyStatus] ?? c.status,
                  typeLabel(c.type),
                  formatDateOnly(c.incorporationDate),
                  c.dormant ? "Yes" : "No",
                  c.registeredCity,
                  c.registeredPostcode,
                  formatAddress(c),
                  ...directorCsvCells(c, new Date(), staleAfterDays),
                  c.accountsOverdue ? "Yes" : "No",
                  c.confirmationOverdue ? "Yes" : "No",
                  c.hasDS01 ? "Yes" : "No",
                ])
              )
              .join("\r\n");
          }
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
