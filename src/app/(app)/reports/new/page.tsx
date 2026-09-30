import type { Metadata } from "next";
import { ReportBuilderClient } from "./ReportBuilderClient";

export const metadata: Metadata = { title: "Report Builder" };

export default function ReportBuilderPage() {
  return (
    <div className="space-y-1">
      <h2 className="text-lg font-semibold text-slate-900">Report builder</h2>
      <p className="mb-4 text-sm text-slate-500">
        Combine any number of filters to build the exact report you need. Save it once — results refresh daily.
      </p>
      <ReportBuilderClient />
    </div>
  );
}
