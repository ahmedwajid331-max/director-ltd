import type { Metadata } from "next";
import { CrmListPage } from "@/components/companies/CrmListPage";

export const metadata: Metadata = { title: "Watches" };

export default function WatchesPage() {
  return <CrmListPage scope="followed" />;
}
