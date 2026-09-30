import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { compileFilterToWhere } from "@/lib/filters/compile";
import { iterateCompanies } from "@/lib/data/companies";
import { formatDate, formatAddress, STATUS_LABELS, typeLabel } from "@/lib/data/format";
import type { CompanyStatus } from "@/lib/types";
import type { Prisma } from "@prisma/client";

const bodySchema = z.object({
  filter: z.any().optional(),
  q: z.string().optional(),
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

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return new Response("Invalid request", { status: 400 });

  let where: Prisma.CompanyWhereInput = compileFilterToWhere(parsed.data.filter ?? null);
  if (parsed.data.q?.trim()) {
    const term = parsed.data.q.trim();
    where = {
      AND: [
        where,
        { OR: [{ name: { contains: term } }, { companyNumber: { contains: term } }] },
      ],
    };
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(CSV_HEADERS.join(",") + "\n"));
      // Streamed in fixed-size batches so exports stay memory-safe no matter
      // how large the matching result set is.
      for await (const batch of iterateCompanies(where, 500)) {
        const lines = batch
          .map((c) =>
            [
              c.companyNumber,
              c.name,
              STATUS_LABELS[c.status as CompanyStatus],
              typeLabel(c.type),
              formatDate(c.incorporationDate),
              c.dormant ? "Yes" : "No",
              formatAddress(c),
              String(c.directorCount),
              c.singleDirector ? "Yes" : "No",
              c.accountsOverdue ? "Yes" : "No",
              c.confirmationOverdue ? "Yes" : "No",
              c.hasDS01 ? "Yes" : "No",
            ]
              .map(csvEscape)
              .join(",")
          )
          .join("\n");
        controller.enqueue(encoder.encode(lines + "\n"));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="director-ltd-export-${Date.now()}.csv"`,
    },
  });
}
