import type { Metadata } from "next";
import { CompanyExplorer } from "@/components/companies/CompanyExplorer";

export const metadata: Metadata = { title: "Companies" };

export default function CompaniesPage() {
  return <CompanyExplorer scope="all" />;
}
