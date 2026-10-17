import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { SessionPayload } from "@/lib/auth/session";
import { buildCompanyWhere, countCompanies, isSortableField, openCompaniesSorted, searchCompanies } from "@/lib/data/companies";
import { exportCap, spreadsheetExportCap } from "@/lib/data/exportCap";
import { filterErrorResponse } from "@/lib/api/filter-errors";
import { parseFilter } from "@/lib/filters/validate";
import { countActiveRules } from "@/lib/filters/types";
import { describeFilter } from "@/lib/filters/describe";
import { loadOfficerConfig } from "@/lib/companies-house/officerQueue";
import { effectiveColumns, enabledKeys } from "@/lib/columns/resolve";
import { isMissingTable, loadFieldSettings } from "@/lib/columns/store";
import { exportHeaders, exportRow, needsCrmState } from "@/lib/columns/exportCells";
import { docxStream, pdfStream, reportFileName, type Cell } from "@/lib/reports/documents";
import { buildXlsx } from "@/lib/reports/xlsx";
import { filterAccessResponse, stripDirectorColumns } from "@/lib/auth/access";
import { can } from "@/lib/auth/permissions";
import { logActivity } from "@/lib/activity";

// ONE implementation of the report downloads (PDF, Word, Excel). Used by the saved-report route
// (/api/reports/[id]/export) and by the Report Builder's unsaved export (/api/reports/export), so both apply the same
// access rules, narrowing rule, row ceilings, column and sort handling, and produce the same cells as CSV export.
// CSV itself keeps streaming through /api/companies/export.
//
// PDF and Word STREAM: the matching ids are read once in the table's order, rows are fetched and written in batches, and the
// file leaves the server as it is produced - so memory does not grow with the number of companies and there is no separate
// "document" row limit. They share the platform export ceiling (exportCap: per role, the same as CSV). Excel is built in
// memory and keeps its own lower ceiling.

export type DocumentFormat = "pdf" | "docx" | "xlsx";

export const DOCUMENT_FORMATS = {
  pdf: { ext: "pdf", type: "application/pdf", action: "export_pdf" },
  docx: { ext: "docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", action: "export_docx" },
  xlsx: { ext: "xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", action: "export_xlsx" },
} as const;

// The columns used when none were chosen: the original table (see ReportResultsClient / ResultsTable).
export const ORIGINAL_TABLE = ["name", "companyNumber", "status", "type", "incorporationDate", "registeredCity", "registeredPostcode", "directorCount", "filingSummary"];

const BATCH = 1000;

export interface DocumentExportInput {
  format: DocumentFormat;
  rawFilter: unknown;
  // Whose CRM scope the filter is evaluated for (a saved report's owner; the caller for an unsaved export).
  ownerId: string;
  savedColumns: string[] | null;
  savedSort: { field: string; dir: "asc" | "desc" } | null;
  requestedSortField?: string | null;
  requestedSortDir?: string | null;
  title: string;
  description?: string | null;
  // Wording for refusals: "This report" (saved) or "These results" (unsaved).
  subject: string;
  activity: { meta: Record<string, unknown>; reportId?: string };
}

type CompanyRow = Awaited<ReturnType<typeof searchCompanies>>["rows"][number];

export async function exportReportDocument(session: SessionPayload, input: DocumentExportInput): Promise<Response> {
  const spec = DOCUMENT_FORMATS[input.format];
  const rawFilter = input.rawFilter;

  const blocked = filterAccessResponse(session, rawFilter);
  if (blocked) return blocked;
  const checked = parseFilter(rawFilter);
  if (!checked.ok) return NextResponse.json({ error: "Invalid filter.", details: checked.errors.slice(0, 10) }, { status: 400 });
  const activeRules = checked.filter ? countActiveRules(checked.filter) : 0;
  if (session.role === "USER" && activeRules === 0) {
    return NextResponse.json({ error: "Add at least one filter before exporting - exporting the entire register is not available." }, { status: 403 });
  }

  let where;
  try {
    where = buildCompanyWhere({ filter: rawFilter, userId: input.ownerId });
  } catch (err) {
    const res = filterErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const cap = input.format === "xlsx" ? spreadsheetExportCap(session.role) : exportCap(session.role);
  const counted = await countCompanies(where);
  if (counted > cap) {
    const error =
      input.format === "xlsx"
        ? `${input.subject} has ${counted.toLocaleString()} companies; Excel downloads are limited to ${cap.toLocaleString()}. Use Export CSV for the full set, or narrow the filter.`
        : `${input.subject} has ${counted.toLocaleString()} companies; your export limit is ${cap.toLocaleString()}. Narrow the filter and try again.`;
    return NextResponse.json({ error }, { status: 413 });
  }

  let enabled = enabledKeys(new Map());
  try {
    enabled = enabledKeys(await loadFieldSettings());
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
  let cols = effectiveColumns(input.savedColumns, enabled, ORIGINAL_TABLE);
  if (!can(session, "companies.directors")) cols = stripDirectorColumns(cols);

  const reqField = input.requestedSortField ?? input.savedSort?.field ?? "name";
  const sortField = isSortableField(reqField) ? reqField : "name";
  const sortDir = (input.requestedSortDir ?? input.savedSort?.dir) === "desc" ? "desc" : "asc";

  const now = new Date();
  const staleAfterDays = loadOfficerConfig().staleAfterDays;
  // One batch of companies as export cells. The four CRM markers need this user's own state: one indexed lookup per batch.
  const toCells = async (batch: CompanyRow[]): Promise<Cell[][]> => {
    let crm: Map<string, { followed: boolean; saved: boolean; redFlagged: boolean; trashed: boolean }> | null = null;
    if (needsCrmState(cols)) {
      const states = await db.userCompanyState.findMany({
        where: { userId: session.userId, companyId: { in: batch.map((c) => c.id) } },
        select: { companyId: true, followed: true, saved: true, redFlagged: true, trashed: true },
      });
      crm = new Map(states.map((st) => [st.companyId, st]));
    }
    return batch.map((c) => exportRow(c, cols, { now, staleAfterDays, crm: crm?.get(c.id) }));
  };
  const headers = exportHeaders(cols);
  const metaFor = (total: number) => ({
    title: input.title,
    description: input.description ?? null,
    generatedAt: now,
    total,
    conditions: describeFilter(checked.filter) || "None (all companies)",
    sortLabel: `${exportHeaders([sortField])[0]} (${sortDir === "asc" ? "ascending" : "descending"})`,
  });
  const respond = (body: BodyInit) =>
    new Response(body, {
      headers: {
        "Content-Type": spec.type,
        "Content-Disposition": `attachment; filename="${reportFileName(input.title, spec.ext, now)}"`,
        "Cache-Control": "no-store",
      },
    });
  const audit = (rows: number) => logActivity(session, spec.action, { meta: { ...input.activity.meta, rows, columns: cols.length }, ...(input.activity.reportId ? { reportId: input.activity.reportId } : {}) });

  if (input.format === "xlsx") {
    // One sorted read of every matching row (bounded by the Excel ceiling), so the sheet follows the table's order.
    const { rows: companies } = await searchCompanies({ where, sortField, sortDir, page: 1, pageSize: Math.max(1, counted) });
    if (companies.length !== counted) {
      // The register changed between the count and the read; refuse rather than label a partial list as complete.
      return NextResponse.json({ error: "The report changed while it was being prepared. Please try again." }, { status: 409 });
    }
    const body = buildXlsx(metaFor(counted), headers, await toCells(companies));
    await audit(counted);
    return respond(new Uint8Array(body));
  }

  // PDF / Word: stream. The id list is the single source of truth for the file - its length is the "Matching companies"
  // figure in the header and exactly what the batches deliver.
  const opened = await openCompaniesSorted(where, sortField, sortDir, BATCH, cap + 1);
  if (opened.total > cap) return NextResponse.json({ error: `${input.subject} grew past your export limit of ${cap.toLocaleString()} while it was being prepared. Narrow the filter and try again.` }, { status: 413 });
  async function* cellBatches() {
    for await (const batch of opened.batches) yield await toCells(batch);
  }
  // Read the first batch BEFORE answering, so a database problem is a normal error response, not a half-sent file.
  const rows = cellBatches();
  const first = await rows.next();
  async function* chained(): AsyncGenerator<Cell[][]> {
    if (!first.done) yield first.value;
    yield* rows;
  }
  await audit(opened.total);
  const meta = metaFor(opened.total);
  // From here the file is on its way. A failure part-way aborts the download (the client sees a failed download) rather
  // than ending a short file that looks complete.
  const source = input.format === "pdf" ? pdfStream(meta, headers, chained()) : Readable.from(docxStream(meta, headers, chained()));
  return respond(Readable.toWeb(source) as unknown as ReadableStream);
}
