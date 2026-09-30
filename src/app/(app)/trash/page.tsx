import type { Metadata } from "next";
import { CompanyExplorer } from "@/components/companies/CompanyExplorer";

export const metadata: Metadata = { title: "Trash" };

export default function TrashPage() {
  return <CompanyExplorer scope="trashed" title="Trash — companies are never permanently deleted" />;
}
