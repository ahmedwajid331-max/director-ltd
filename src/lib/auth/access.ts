import { NextResponse } from "next/server";
import { can, type HasPermissions } from "./permissions";
import { parseFilter } from "@/lib/filters/validate";
import type { FilterNode } from "@/lib/filters/types";

// Data-level permission rules that are not tied to one route: which filters need which permission, and what is removed
// from result rows / export columns when the caller may not see director information.

// Filter fields that expose Companies House officer data.
export const DIRECTOR_FILTER_FIELDS = new Set(["directorCount", "singleDirector"]);
// Result / export columns that expose officer data.
export const DIRECTOR_COLUMN_KEYS = ["directorCount", "singleDirector", "officersCoverage", "officersFetchedAt", "officersUnavailableReason"];

function ruleFields(node: FilterNode, out: Set<string>) {
  if (node.kind === "rule") out.add(node.field);
  else node.children.forEach((c) => ruleFields(c, out));
}

// "Advanced" logic = anything the Report Builder's criteria panel cannot produce on its own: ANY (OR) across several
// conditions, or a nested group that is not just one field's multi-select (which the panel stores as a small OR group).
export function usesAdvancedLogic(root: FilterNode): boolean {
  if (root.kind !== "group") return false;
  const active = root.children.filter((c) => (c.kind === "rule" ? true : c.children.length > 0));
  if (root.combinator === "OR" && active.length > 1) return true;
  for (const child of active) {
    if (child.kind !== "group") continue;
    const onlyRules = child.children.every((g) => g.kind === "rule");
    const oneField = onlyRules && new Set(child.children.map((g) => (g.kind === "rule" ? g.field : ""))).size === 1;
    if (!(child.combinator === "OR" && oneField) && child.children.length > 1) return true;
    if (!onlyRules) return true;
  }
  return false;
}

export interface AccessProblem {
  error: string;
  permission: string;
}

// null = allowed. Invalid filters are left for the query builder to reject with its own 400.
export function filterAccessProblem(subject: HasPermissions, rawFilter: unknown): AccessProblem | null {
  const checked = parseFilter(rawFilter ?? null);
  if (!checked.ok || !checked.filter) return null;
  if (usesAdvancedLogic(checked.filter) && !can(subject, "companies.advancedSearch")) {
    return { error: "Using ANY (OR) or nested groups needs the Advanced Search permission.", permission: "companies.advancedSearch" };
  }
  if (!can(subject, "companies.directors")) {
    const fields = new Set<string>();
    ruleFields(checked.filter, fields);
    if ([...fields].some((f) => DIRECTOR_FILTER_FIELDS.has(f))) {
      return { error: "Filtering by director information needs the director information permission.", permission: "companies.directors" };
    }
  }
  return null;
}

export function filterAccessResponse(subject: HasPermissions, rawFilter: unknown): NextResponse | null {
  const p = filterAccessProblem(subject, rawFilter);
  return p ? NextResponse.json(p, { status: 403 }) : null;
}

// Officer-derived fields removed from result rows for callers without the director permission.
export function redactDirectorFields<T extends object>(row: T): T {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const k of DIRECTOR_COLUMN_KEYS) if (k in out) out[k] = k === "officersCoverage" ? "none" : null;
  if ("officerFreshness" in out) out.officerFreshness = "none";
  if ("officersDirtyAt" in out) out.officersDirtyAt = null;
  return out as T;
}

export function stripDirectorColumns(columns: string[]): string[] {
  return columns.filter((c) => !DIRECTOR_COLUMN_KEYS.includes(c));
}
