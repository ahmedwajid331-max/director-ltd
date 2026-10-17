import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  BUILTIN_DEFAULT,
  PHASE1_COLUMNS,
  effectiveColumns,
  enabledKeys,
  parseColumnsJson,
  recommendedChanged,
  validateColumnList,
  type PreferenceState,
} from "./resolve";
import { isSelectable } from "./catalogue";
import { isSortableField, type SortableField } from "@/lib/data/companies";

// Database access for Column & Default Settings. Nothing here touches the Company table.

export interface LayoutDTO {
  id: string;
  name: string;
  description: string | null;
  columns: string[];
  isDefault: boolean;
  version: number;
  updatedAt: string;
}

// If the migration has not been applied the table is missing. The company table must still work, on today's columns.
export function isMissingTable(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2021" || err.code === "P2010");
}

function toLayoutDTO(row: { id: string; name: string; description: string | null; columnsJson: string; isDefault: boolean; version: number; updatedAt: Date }): LayoutDTO {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    columns: parseColumnsJson(row.columnsJson) ?? [...BUILTIN_DEFAULT],
    isDefault: row.isDefault,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadFieldSettings(): Promise<Map<string, boolean>> {
  const rows = await db.columnFieldSetting.findMany();
  return new Map(rows.map((r) => [r.key, r.enabled]));
}

// There is always a default layout. The first visit creates "General research" with today's columns.
export async function ensureDefaultLayout(): Promise<LayoutDTO> {
  const existing = await db.columnLayout.findFirst({ where: { isDefault: true } });
  if (existing) return toLayoutDTO(existing);
  try {
    const created = await db.columnLayout.create({
      data: { name: "General research", description: "The standard table: the 33 Phase 1 columns.", columnsJson: JSON.stringify(PHASE1_COLUMNS), isDefault: true },
    });
    return toLayoutDTO(created);
  } catch (err) {
    // Another request created it first (unique name / single default): read theirs.
    const again = await db.columnLayout.findFirst({ where: { isDefault: true } });
    if (again) return toLayoutDTO(again);
    throw err;
  }
}

export async function listLayouts(): Promise<LayoutDTO[]> {
  await ensureDefaultLayout();
  const rows = await db.columnLayout.findMany({ orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
  return rows.map(toLayoutDTO);
}

export async function getUserPreference(userId: string): Promise<PreferenceState | null> {
  const row = await db.userColumnPreference.findUnique({ where: { userId } });
  if (!row) return null;
  const columns = parseColumnsJson(row.columnsJson);
  if (!columns) return null;
  return { columns, baseLayoutId: row.baseLayoutId, baseLayoutVersion: row.baseLayoutVersion };
}

export interface UserColumnState {
  columns: string[]; // what the table should draw
  hasSaved: boolean;
  recommendedChanged: boolean;
}

// One small read per page load: three tiny tables. Falls back to today's columns if anything is unavailable.
export async function loadUserColumns(userId: string): Promise<UserColumnState> {
  try {
    const [settings, layout, pref] = await Promise.all([loadFieldSettings(), ensureDefaultLayout(), getUserPreference(userId)]);
    const enabled = enabledKeys(settings);
    const fallback = effectiveColumns(layout.columns, enabled);
    return {
      columns: pref ? effectiveColumns(pref.columns, enabled, fallback) : fallback,
      hasSaved: !!pref,
      recommendedChanged: recommendedChanged(pref, layout),
    };
  } catch (err) {
    if (!isMissingTable(err)) console.error("[columns] could not load column settings:", err);
    return { columns: [...BUILTIN_DEFAULT], hasSaved: false, recommendedChanged: false };
  }
}

// ---- Administrator actions ------------------------------------------------------------------------------------

async function audit(userId: string, what: string, detail: Record<string, unknown>) {
  await db.activityLog.create({ data: { userId, action: "column_settings_changed", meta: JSON.stringify({ what, ...detail }) } });
}

export type StoreResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const fail = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });

export async function setFieldSwitches(userId: string, updates: { key: string; enabled: boolean }[]): Promise<StoreResult<{ changed: number }>> {
  for (const u of updates) {
    if (!isSelectable(u.key)) return fail(400, `"${u.key}" cannot be switched on or off: its data is not available in the table yet.`);
    if (u.key === "name" && !u.enabled) return fail(400, "The Company column cannot be switched off.");
  }
  await db.$transaction(
    updates.map((u) =>
      db.columnFieldSetting.upsert({
        where: { key: u.key },
        create: { key: u.key, enabled: u.enabled, updatedById: userId },
        update: { enabled: u.enabled, updatedById: userId },
      })
    )
  );
  await audit(userId, "field_switches", { count: updates.length, on: updates.filter((u) => u.enabled).map((u) => u.key), off: updates.filter((u) => !u.enabled).map((u) => u.key) });
  return { ok: true, value: { changed: updates.length } };
}

async function checkColumns(columns: unknown): Promise<StoreResult<string[]>> {
  const enabled = enabledKeys(await loadFieldSettings());
  const v = validateColumnList(columns, enabled);
  return v.ok ? { ok: true, value: v.columns } : fail(400, v.error);
}

export async function createLayout(userId: string, input: { name: string; description?: string | null; columns: unknown; makeDefault?: boolean }): Promise<StoreResult<LayoutDTO>> {
  const cols = await checkColumns(input.columns);
  if (!cols.ok) return cols;
  await ensureDefaultLayout();
  try {
    const row = await db.$transaction(async (tx) => {
      if (input.makeDefault) await tx.columnLayout.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      return tx.columnLayout.create({
        data: { name: input.name.trim(), description: input.description?.trim() || null, columnsJson: JSON.stringify(cols.value), isDefault: !!input.makeDefault, updatedById: userId },
      });
    });
    await audit(userId, "layout_created", { id: row.id, name: row.name });
    return { ok: true, value: toLayoutDTO(row) };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return fail(409, "A layout with that name already exists.");
    throw err;
  }
}

export async function updateLayout(
  userId: string,
  id: string,
  patch: { name?: string; description?: string | null; columns?: unknown; isDefault?: boolean }
): Promise<StoreResult<LayoutDTO>> {
  const current = await db.columnLayout.findUnique({ where: { id } });
  if (!current) return fail(404, "Layout not found.");
  if (patch.isDefault === false && current.isDefault) return fail(400, "Choose another layout as the default instead.");

  const data: Prisma.ColumnLayoutUpdateInput = { updatedById: userId };
  if (patch.name !== undefined) data.name = patch.name.trim();
  if (patch.description !== undefined) data.description = patch.description?.trim() || null;
  if (patch.columns !== undefined) {
    const cols = await checkColumns(patch.columns);
    if (!cols.ok) return cols;
    const next = JSON.stringify(cols.value);
    if (next !== current.columnsJson) {
      data.columnsJson = next;
      data.version = { increment: 1 };
    }
  }
  try {
    const row = await db.$transaction(async (tx) => {
      if (patch.isDefault) {
        await tx.columnLayout.updateMany({ where: { isDefault: true, NOT: { id } }, data: { isDefault: false } });
        data.isDefault = true;
      }
      return tx.columnLayout.update({ where: { id }, data });
    });
    await audit(userId, "layout_updated", { id, name: row.name, version: row.version, default: row.isDefault });
    return { ok: true, value: toLayoutDTO(row) };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return fail(409, "A layout with that name already exists.");
    throw err;
  }
}

export async function deleteLayout(userId: string, id: string): Promise<StoreResult<{ id: string }>> {
  const current = await db.columnLayout.findUnique({ where: { id } });
  if (!current) return fail(404, "Layout not found.");
  if (current.isDefault) return fail(400, "The default layout cannot be deleted. Make another layout the default first.");
  // Users' saved lists are never touched: they keep their own columns and simply see the "recommendation changed" notice.
  await db.columnLayout.delete({ where: { id } });
  await audit(userId, "layout_deleted", { id, name: current.name });
  return { ok: true, value: { id } };
}

export async function duplicateLayout(userId: string, id: string): Promise<StoreResult<LayoutDTO>> {
  const current = await db.columnLayout.findUnique({ where: { id } });
  if (!current) return fail(404, "Layout not found.");
  const names = new Set((await db.columnLayout.findMany({ select: { name: true } })).map((r) => r.name));
  let name = `${current.name} (copy)`;
  for (let n = 2; names.has(name); n++) name = `${current.name} (copy ${n})`;
  const row = await db.columnLayout.create({ data: { name, description: current.description, columnsJson: current.columnsJson, isDefault: false, updatedById: userId } });
  await audit(userId, "layout_duplicated", { from: id, id: row.id, name });
  return { ok: true, value: toLayoutDTO(row) };
}

// ---- User actions (each user can only ever touch their own row) ----------------------------------------------------

export async function savePreference(userId: string, columns: unknown, baseLayoutId?: string | null): Promise<StoreResult<{ columns: string[] }>> {
  const cols = await checkColumns(columns);
  if (!cols.ok) return cols;
  const layout = baseLayoutId ? await db.columnLayout.findUnique({ where: { id: baseLayoutId } }) : await db.columnLayout.findFirst({ where: { isDefault: true } });
  const data = { columnsJson: JSON.stringify(cols.value), baseLayoutId: layout?.id ?? null, baseLayoutVersion: layout?.version ?? null };
  await db.userColumnPreference.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  return { ok: true, value: { columns: cols.value } };
}

export async function resetPreference(userId: string): Promise<void> {
  await db.userColumnPreference.deleteMany({ where: { userId } });
}

// "Keep mine": dismiss the notice by recording the current recommendation as seen. The saved columns are not changed.
export async function keepMyColumns(userId: string): Promise<void> {
  const layout = await ensureDefaultLayout();
  await db.userColumnPreference.updateMany({ where: { userId }, data: { baseLayoutId: layout.id, baseLayoutVersion: layout.version } });
}

// ---- Saved reports: the columns and sort a report remembers (stored in Report.columnsJson / sortJson) -------------------

export interface ReportSort {
  field: SortableField;
  dir: "asc" | "desc";
}

// Strict, for saving: every column must be available to users right now (same rule as personal preferences).
export async function validateReportColumns(columns: unknown): Promise<StoreResult<string[]>> {
  return checkColumns(columns);
}

export function validateReportSort(sort: unknown): StoreResult<ReportSort> {
  const s = sort as { field?: unknown; dir?: unknown } | null;
  if (!s || typeof s.field !== "string" || !isSortableField(s.field) || (s.dir !== "asc" && s.dir !== "desc")) return fail(400, "That sort order is not supported.");
  return { ok: true, value: { field: s.field, dir: s.dir } };
}

// Lenient, for display: a stored sort that is no longer valid is ignored.
export function parseReportSort(json: string | null | undefined): ReportSort | null {
  if (!json) return null;
  try {
    const v = validateReportSort(JSON.parse(json));
    return v.ok ? v.value : null;
  } catch {
    return null;
  }
}

// What a saved report should draw: its own saved columns (minus any field since switched off), or null for reports saved
// before this existed, which keep their original nine-column table.
export async function loadReportColumns(json: string | null | undefined): Promise<string[] | null> {
  const saved = parseColumnsJson(json);
  if (!saved) return null;
  try {
    return effectiveColumns(saved, enabledKeys(await loadFieldSettings()));
  } catch (err) {
    if (!isMissingTable(err)) console.error("[columns] could not load report columns:", err);
    return null;
  }
}
