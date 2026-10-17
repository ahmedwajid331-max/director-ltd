import type { Metadata } from "next";
import { requirePermission } from "@/lib/auth/guard";
import { loadUserColumns } from "@/lib/columns/store";
import { paramsToForm } from "@/lib/filters/advancedSearch";
import { AdvancedSearchClient } from "@/components/companies/AdvancedSearchClient";

export const metadata: Metadata = { title: "Advanced Company Search" };

export default async function AdvancedSearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const session = await requirePermission("companies.advancedSearch");
  const columnState = await loadUserColumns(session.userId);
  const page = Math.max(1, Math.min(1_000_000, Number(Array.isArray(raw.page) ? raw.page[0] : raw.page) || 1));
  return <AdvancedSearchClient initialForm={paramsToForm(raw)} initialSearched={raw.go === "1"} initialPage={page} initialColumns={columnState.columns} columnsNotice={columnState.recommendedChanged} />;
}
