import type { Metadata } from "next";
import { CrmListPage } from "@/components/companies/CrmListPage";

export const metadata: Metadata = { title: "Red-flagged companies" };

export default function RedFlagsPage() {
  return <CrmListPage scope="redFlagged" />;
}
