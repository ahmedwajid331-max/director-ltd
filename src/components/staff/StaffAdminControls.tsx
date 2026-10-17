"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, LogOut, Save, ShieldCheck, UserCheck, UserX } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Input";
import { PermissionMatrix } from "./PermissionMatrix";
import { CURRENCIES, parseRateToMinor } from "@/lib/staff/money";
import type { PermissionKey } from "@/lib/auth/permissions";
import type { UserRole } from "@/lib/types";

interface Props {
  user: { id: string; name: string; role: UserRole; active: boolean; managerId: string | null; hourlyRateMinor: number | null; rateCurrency: string };
  permissions: PermissionKey[]; // the resolved set
  usesRoleDefault: boolean;
  supervisors: { id: string; name: string }[];
  isSelf: boolean;
  isSuper: boolean; // the viewer is a Super Admin (may change role, permissions, supervisor, rate)
}

// Account controls on a staff profile. Every change is a PATCH to /api/users/[id], which re-checks the caller's authority
// and writes the audit entry; this component only collects input. Only the fields that were edited are sent, so nothing
// unrelated (saved columns, preferences) is touched.
export function StaffAdminControls({ user, permissions, usesRoleDefault, supervisors, isSelf, isSuper }: Props) {
  const router = useRouter();
  const [role, setRole] = useState<UserRole>(user.role);
  const [managerId, setManagerId] = useState(user.managerId ?? "");
  const [rate, setRate] = useState(user.hourlyRateMinor === null ? "" : (user.hourlyRateMinor / 100).toFixed(2));
  const [currency, setCurrency] = useState(user.rateCurrency);
  const [perms, setPerms] = useState<PermissionKey[]>(permissions);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function call(label: string, url: string, method: string, body?: unknown, ok = "Saved.") {
    setBusy(label);
    setMsg(null);
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setMsg({ ok: false, text: data.error ?? "That change was not allowed." });
      else {
        setMsg({ ok: true, text: ok });
        router.refresh();
      }
    } catch {
      setMsg({ ok: false, text: "Could not reach the server. Try again." });
    } finally {
      setBusy(null);
    }
  }

  function saveProfile() {
    const patch: Record<string, unknown> = {};
    if (role !== user.role) patch.role = role;
    if ((managerId || null) !== user.managerId) patch.managerId = managerId || null;
    const minor = rate.trim() === "" ? null : parseRateToMinor(rate);
    if (rate.trim() !== "" && minor === null) return setMsg({ ok: false, text: "Enter the hourly rate like 20 or 20.50." });
    if (minor !== user.hourlyRateMinor) patch.hourlyRateMinor = minor;
    if (currency !== user.rateCurrency) patch.rateCurrency = currency;
    if (Object.keys(patch).length === 0) return setMsg({ ok: true, text: "Nothing to change." });
    call("profile", `/api/users/${user.id}`, "PATCH", patch);
  }

  return (
    <div className="space-y-5">
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm ${msg.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-700"}`}>
          {msg.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />} {msg.text}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={isSelf || busy !== null} onClick={() => call("active", `/api/users/${user.id}`, "PATCH", { active: !user.active }, user.active ? "Account deactivated and signed out." : "Account activated.")}>
          {user.active ? <UserX className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />} {user.active ? "Deactivate account" : "Activate account"}
        </Button>
        <Button variant="outline" size="sm" disabled={isSelf || busy !== null} onClick={() => call("end", `/api/users/${user.id}/end-sessions`, "POST", undefined, "Open sessions ended.")}>
          <LogOut className="h-4 w-4" /> End all open sessions
        </Button>
      </div>

      {isSuper && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Label>Role</Label>
              <Select value={role} onChange={(e) => setRole(e.target.value as UserRole)} disabled={isSelf}>
                <option value="USER">User</option>
                <option value="ADMIN">Admin (supervisor)</option>
                <option value="SUPER_ADMIN">Super Admin</option>
              </Select>
            </div>
            <div>
              <Label>Supervisor</Label>
              <Select value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                <option value="">No supervisor</option>
                {supervisors
                  .filter((s) => s.id !== user.id)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </Select>
            </div>
            <div>
              <Label>Hourly rate (for approved hours)</Label>
              <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="e.g. 20.00" />
            </div>
            <div>
              <Label>Currency</Label>
              <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <Button size="sm" onClick={saveProfile} disabled={busy !== null}>
            <Save className="h-4 w-4" /> {busy === "profile" ? "Saving…" : "Save account details"}
          </Button>

          <div className="space-y-3 border-t border-slate-100 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <ShieldCheck className="h-4 w-4 text-indigo-600" /> Permissions
                {usesRoleDefault && <span className="rounded bg-slate-100 px-1.5 py-px text-[10px] font-medium text-slate-500">role default</span>}
              </h4>
              {role !== "SUPER_ADMIN" && (
                <Button variant="ghost" size="sm" disabled={busy !== null || usesRoleDefault} onClick={() => call("reset", `/api/users/${user.id}`, "PATCH", { permissions: null }, "Back to the role default.")}>
                  Reset to role default
                </Button>
              )}
            </div>
            <PermissionMatrix role={user.role} value={perms} onChange={setPerms} disabled={isSelf || user.role === "SUPER_ADMIN"} />
            {isSelf && <p className="text-xs text-slate-500">You cannot change your own permissions.</p>}
            {!isSelf && user.role !== "SUPER_ADMIN" && (
              <Button size="sm" onClick={() => call("perms", `/api/users/${user.id}`, "PATCH", { permissions: perms }, "Permissions saved.")} disabled={busy !== null}>
                <Save className="h-4 w-4" /> {busy === "perms" ? "Saving…" : "Save permissions"}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
