import { NextResponse } from "next/server";
import { FIELD_CATALOGUE, isSelectable } from "@/lib/columns/catalogue";
import { effectiveColumns, enabledKeys, recommendedChanged } from "@/lib/columns/resolve";
import { ensureDefaultLayout, getUserPreference, listLayouts, loadFieldSettings, loadUserColumns } from "@/lib/columns/store";
import { requireUserApi } from "@/lib/columns/api";

// What the column picker needs: the fields this user may choose, the recommended layouts, and their own state.
export async function GET() {
  const auth = await requireUserApi();
  if ("error" in auth) return auth.error;

  const [settings, layouts, pref, state, def] = await Promise.all([
    loadFieldSettings(),
    listLayouts(),
    getUserPreference(auth.session.userId),
    loadUserColumns(auth.session.userId),
    ensureDefaultLayout(),
  ]);
  const enabled = enabledKeys(settings);
  const fields = FIELD_CATALOGUE.filter((d) => isSelectable(d.key) && enabled.has(d.key)).map((d) => ({
    key: d.key,
    label: d.label,
    category: d.category,
    description: d.description,
    availability: d.availability,
    sortable: !!d.sortKey,
    filterable: !!d.filterKey,
  }));
  return NextResponse.json({
    fields,
    layouts: layouts.map((l) => ({ id: l.id, name: l.name, description: l.description, isDefault: l.isDefault, columns: effectiveColumns(l.columns, enabled) })),
    defaultLayoutId: def.id,
    columns: state.columns,
    hasSaved: state.hasSaved,
    recommendedChanged: recommendedChanged(pref, def),
  });
}
