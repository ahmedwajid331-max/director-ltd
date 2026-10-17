import type { Metadata } from "next";
import { CompanyExplorer } from "@/components/companies/CompanyExplorer";
import { countRealCompanies } from "@/lib/data/companies";
import { getDataFreshness } from "@/lib/data/freshness";
import { requirePermission } from "@/lib/auth/guard";
import { loadUserColumns } from "@/lib/columns/store";

export const metadata: Metadata = { title: "UK Companies" };

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { q } = await searchParams;
  const initialQuery = (Array.isArray(q) ? q[0] : q)?.slice(0, 120) ?? "";
  const session = await requirePermission("companies.view");
  // Header facts, all real: the register size (memoised for a minute) and when the company data was last synchronised
  // from Companies House (newest successful monthly file / new-registrations sync; see lib/data/freshness.ts).
  const [total, freshness, columnState] = await Promise.all([countRealCompanies(), getDataFreshness(), loadUserColumns(session.userId)]);
  const lastUpdated = freshness.lastUpdated ? freshness.lastUpdated.toISOString() : null;
  return <CompanyExplorer scope="all" meta={{ total, lastUpdated }} initialQuery={initialQuery} initialColumns={columnState.columns} columnsNotice={columnState.recommendedChanged} />;
}
