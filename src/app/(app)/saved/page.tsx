import type { Metadata } from "next";
import { CrmListPage } from "@/components/companies/CrmListPage";

export const metadata: Metadata = { title: "Saved companies" };

export default function SavedPage() {
  return <CrmListPage scope="saved" />;
}
