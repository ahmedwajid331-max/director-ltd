"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { UserPlus, ShieldCheck, Shield, User as UserIcon, Clock, FileText, AlertCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { StatusPill, SectionCard } from "@/components/admin/AdminUi";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { formatDate } from "@/lib/data/format";
import type { UserRole } from "@/lib/types";
import { Avatar } from "@/components/profile/Avatar";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { PermissionMatrix } from "@/components/staff/PermissionMatrix";
import { ALL_PERMISSION_KEYS, NEW_ACCOUNT_DEFAULT, type PermissionKey } from "@/lib/auth/permissions";
import { CURRENCIES, parseRateToMinor } from "@/lib/staff/money";

interface UserVM {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  _count: { reports: number };
  avatarSrc: string | null;
}

const ROLE_TONE: Record<UserRole, "indigo" | "blue" | "slate"> = {
  SUPER_ADMIN: "indigo",
  ADMIN: "blue",
  USER: "slate",
};

const ROLE_ICON = { SUPER_ADMIN: ShieldCheck, ADMIN: Shield, USER: UserIcon } as const;
const AVATAR: Record<UserRole, string> = {
  SUPER_ADMIN: "bg-indigo-600 text-white",
  ADMIN: "bg-violet-100 text-violet-700",
  USER: "bg-slate-200 text-slate-600",
};

export function UsersClient({ initialUsers, canAssignRoles, currentUserId, supervisors }: { initialUsers: UserVM[]; canAssignRoles: boolean; currentUserId: string; supervisors: { id: string; name: string }[] }) {
  const router = useRouter();
  const [users, setUsers] = useState(initialUsers);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "USER" as UserRole });
  // Super Admin only: what the new account may do, who supervises it, and its pay rate. Starts least-privilege.
  const [perms, setPerms] = useState<PermissionKey[]>(NEW_ACCOUNT_DEFAULT);
  const [managerId, setManagerId] = useState("");
  const [rate, setRate] = useState("");
  const [currency, setCurrency] = useState("GBP");

  function changeRole(role: UserRole) {
    setForm({ ...form, role });
    setPerms(role === "ADMIN" ? ALL_PERMISSION_KEYS : NEW_ACCOUNT_DEFAULT);
  }
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function createUser() {
    setError(null);
    if (!form.name.trim() || !form.email.trim() || form.password.length < MIN_PASSWORD_LENGTH) {
      setError(`Name, email and a password of at least ${MIN_PASSWORD_LENGTH} characters are required.`);
      return;
    }
    const minor = rate.trim() === "" ? null : parseRateToMinor(rate);
    if (canAssignRoles && rate.trim() !== "" && minor === null) {
      setError("Enter the hourly rate like 20 or 20.50.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          ...(canAssignRoles && form.role !== "SUPER_ADMIN" ? { permissions: perms } : {}),
          ...(canAssignRoles ? { managerId: managerId || null, hourlyRateMinor: minor, rateCurrency: currency } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not create user.");
        return;
      }
      setUsers((prev) => [{ ...data.user, createdAt: data.user.createdAt, lastLoginAt: null, _count: { reports: 0 } }, ...prev]);
      setForm({ name: "", email: "", password: "", role: "USER" });
      setPerms(NEW_ACCOUNT_DEFAULT);
      setManagerId("");
      setRate("");
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  async function updateUser(id: string, patch: { active?: boolean; role?: UserRole }) {
    const previous = users;
    setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));
    const res = await fetch(`/api/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      // The server is the authority - roll the optimistic change back.
      setUsers(previous);
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "That change was not allowed.");
      return;
    }
    setError(null);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <SectionCard icon={UserPlus} tone="violet" title="Create a user" description="New users sign in with the password you set here (at least 8 characters).">
        <form onSubmit={(e) => { e.preventDefault(); void createUser(); }} className="bg-gradient-to-b from-violet-50/40 to-white p-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Label>Full name</Label>
              <Input autoComplete="off" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <Label>Email</Label>
              <Input type="email" autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <Label>Strong Password</Label>
              <PasswordInput autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </div>
            <div>
              <Label>Role</Label>
              <Select value={form.role} onChange={(e) => changeRole(e.target.value as UserRole)} disabled={!canAssignRoles}>
                <option value="USER">User</option>
                <option value="ADMIN">Admin</option>
                <option value="SUPER_ADMIN">Super Admin</option>
              </Select>
            </div>
          </div>
          {canAssignRoles ? (
            <div className="mt-5 space-y-4 border-t border-violet-100 pt-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <Label>Supervisor</Label>
                  <Select value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                    <option value="">No supervisor</option>
                    {supervisors.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label>Hourly rate (optional)</Label>
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
              <div>
                <p className="mb-2 text-sm font-semibold text-slate-900">What can this person do?</p>
                <p className="mb-3 text-xs text-slate-500">Starts with the minimum for everyday work. Tick more only where needed; you can change this later on their staff profile.</p>
                <PermissionMatrix role={form.role} value={perms} onChange={setPerms} />
              </div>
            </div>
          ) : (
            <p className="mt-4 text-xs text-slate-500">New accounts join your team with standard everyday permissions. A Super Admin can widen them later.</p>
          )}
          {error && (
            <p className="mt-3 flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertCircle className="h-4 w-4 shrink-0" /> {error}
            </p>
          )}
          <Button type="submit" size="sm" className="mt-4" disabled={saving}>
            <UserPlus className="h-4 w-4" /> {saving ? "Creating…" : "Create user"}
          </Button>
        </form>
      </SectionCard>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-gradient-to-r from-indigo-50/70 to-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-3 font-semibold">User</th>
                <th className="px-4 py-3 font-semibold">Role</th>
                <th className="px-4 py-3 font-semibold">
                  <span className="inline-flex items-center gap-1">
                    <FileText className="h-3.5 w-3.5" /> Reports
                  </span>
                </th>
                <th className="px-4 py-3 font-semibold">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" /> Last login
                  </span>
                </th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-5 py-3 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((u) => {
                const RoleIcon = ROLE_ICON[u.role];
                return (
                  <tr key={u.id} className="transition-colors even:bg-slate-50/50 hover:bg-indigo-50/40">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <Avatar src={u.avatarSrc} initials={u.name.slice(0, 2).toUpperCase()} className={cn("flex h-9 w-9 items-center justify-center rounded-full text-xs font-semibold", AVATAR[u.role])} />
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-900">
                            <Link href={`/admin/staff/${u.id}`} className="hover:text-indigo-600">
                              {u.name}
                            </Link>
                            {u.id === currentUserId && <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-px text-[10px] font-medium text-slate-500">You</span>}
                          </div>
                          <div className="truncate text-xs text-slate-500">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      {canAssignRoles ? (
                        <Select
                          value={u.role}
                          onChange={(e) => updateUser(u.id, { role: e.target.value as UserRole })}
                          className="w-auto"
                          disabled={u.id === currentUserId}
                        >
                          <option value="USER">User</option>
                          <option value="ADMIN">Admin</option>
                          <option value="SUPER_ADMIN">Super Admin</option>
                        </Select>
                      ) : (
                        <Badge tone={ROLE_TONE[u.role]}>
                          <RoleIcon className="h-3 w-3" /> {u.role.replace("_", " ")}
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3.5 tabular-nums text-slate-700">{u._count.reports}</td>
                    <td className="px-4 py-3.5 text-slate-600">{u.lastLoginAt ? formatDate(u.lastLoginAt) : "Never"}</td>
                    <td className="px-4 py-3.5">
                      <StatusPill tone={u.active ? "green" : "slate"}>{u.active ? "Active" : "Inactive"}</StatusPill>
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <Button variant="outline" size="sm" disabled={u.id === currentUserId} onClick={() => updateUser(u.id, { active: !u.active })}>
                        {u.active ? "Deactivate" : "Activate"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
