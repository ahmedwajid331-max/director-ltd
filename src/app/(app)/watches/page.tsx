import type { Metadata } from "next";
import { CompanyExplorer } from "@/components/companies/CompanyExplorer";

export const metadata: Metadata = { title: "Watches" };

export default function WatchesPage() {
  return <CompanyExplorer scope="followed" title="Followed companies" />;
}
