import type { Metadata } from "next";
import { requireRole } from "@/lib/auth/guard";
import { AdminTabs } from "@/components/admin/AdminTabs";
import { ColumnSettingsClient } from "./ColumnSettingsClient";

export const metadata: Metadata = { title: "Column & Default Settings" };

export default async function ColumnSettingsPage() {
  await requireRole("SUPER_ADMIN");
  return (
    <div className="space-y-6">
      <AdminTabs active="columns" />
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Column settings</h2>
        <p className="text-sm text-slate-500">
          Available decides which columns users can pick. Default decides what shows until a user saves their own columns, and the default order is set in the strip below. Users&apos; own saved columns are never changed.
        </p>
      </div>
      <ColumnSettingsClient />
    </div>
  );
}
