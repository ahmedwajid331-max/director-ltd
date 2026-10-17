import { NextResponse } from "next/server";
import { FIELD_CATALOGUE, UNAVAILABLE_FIELDS, defaultEnabled, isSelectable } from "@/lib/columns/catalogue";
import { enabledKeys } from "@/lib/columns/resolve";
import { listLayouts, loadFieldSettings } from "@/lib/columns/store";
import { requireSuperAdminApi } from "@/lib/columns/api";

// Super Admin: the whole catalogue with each field's switch, plus every layout.
export async function GET() {
  const auth = await requireSuperAdminApi();
  if ("error" in auth) return auth.error;
  const [settings, layouts] = await Promise.all([loadFieldSettings(), listLayouts()]);
  const enabled = enabledKeys(settings);
  return NextResponse.json({
    fields: FIELD_CATALOGUE.map((d) => ({ ...d, canSwitch: isSelectable(d.key), enabled: enabled.has(d.key), defaultEnabled: defaultEnabled(d.key) })),
    unavailable: UNAVAILABLE_FIELDS,
    layouts,
  });
}
