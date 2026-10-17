"use client";

import { PERMISSIONS, PERMISSION_GROUPS, ADMIN_ONLY_KEYS, withImplied, type PermissionKey } from "@/lib/auth/permissions";
import type { UserRole } from "@/lib/types";
import { cn } from "@/lib/cn";

// The permission checkboxes shown when creating or editing an account. The list comes from the same catalogue the server
// enforces, so every box here does something. Administration permissions only apply to Admin accounts (and a Super Admin
// always has everything), so they are shown only when they can take effect.
export function PermissionMatrix({
  role,
  value,
  onChange,
  disabled,
}: {
  role: UserRole;
  value: PermissionKey[];
  onChange: (next: PermissionKey[]) => void;
  disabled?: boolean;
}) {
  if (role === "SUPER_ADMIN") {
    return <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">A Super Admin always has every permission and cannot be restricted.</p>;
  }
  const selected = new Set(value);
  const toggle = (key: PermissionKey) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(withImplied(next));
  };
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {PERMISSION_GROUPS.filter((g) => g !== "Administration" || role === "ADMIN").map((group) => (
        <fieldset key={group} className="rounded-xl border border-slate-200 bg-white p-3">
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{group}</legend>
          <div className="space-y-1.5">
            {PERMISSIONS.filter((p) => p.group === group && (role === "ADMIN" || !ADMIN_ONLY_KEYS.includes(p.key))).map((p) => (
              <label key={p.key} className={cn("flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1 hover:bg-slate-50", disabled && "cursor-not-allowed opacity-60")}>
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
                  checked={selected.has(p.key)}
                  disabled={disabled}
                  onChange={() => toggle(p.key)}
                  data-permission={p.key}
                />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-slate-800">{p.label}</span>
                  <span className="block text-[11px] leading-snug text-slate-500">{p.description.replace(/ Enforced in:.*$/, "")}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
