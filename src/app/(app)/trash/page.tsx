import type { Metadata } from "next";
import { CrmListPage } from "@/components/companies/CrmListPage";

export const metadata: Metadata = { title: "Trash" };

export default function TrashPage() {
  return <CrmListPage scope="trashed" />;
}
