"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { formatDate } from "@/lib/data/format";
import type { UserRole } from "@/lib/types";

interface UserVM {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  _count: { reports: number };
}

const ROLE_TONE: Record<UserRole, "indigo" | "blue" | "slate"> = {
  SUPER_ADMIN: "indigo",
  ADMIN: "blue",
  USER: "slate",
};

export function UsersClient({ initialUsers, canAssignRoles, currentUserId }: { initialUsers: UserVM[]; canAssignRoles: boolean; currentUserId: string }) {
  const router = useRouter();
  const [users, setUsers] = useState(initialUsers);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "USER" as UserRole });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function createUser() {
    setError(null);
    if (!form.name.trim() || !form.email.trim() || form.password.length < 12) {
      setError("Name, email and a 12+ character password are required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not create user.");
        return;
      }
      setUsers((prev) => [{ ...data.user, createdAt: data.user.createdAt, lastLoginAt: null, _count: { reports: 0 } }, ...prev]);
      setForm({ name: "", email: "", password: "", role: "USER" });
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
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-slate-900">
          <UserPlus className="h-4 w-4" /> Create a user
        </h3>
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <Label>Full name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label>Email</Label>
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <Label>Temporary password</Label>
            <Input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </div>
          <div>
            <Label>Role</Label>
            <Select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}
              disabled={!canAssignRoles}
            >
              <option value="USER">User</option>
              <option value="ADMIN">Admin</option>
              <option value="SUPER_ADMIN">Super Admin</option>
            </Select>
          </div>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <Button size="sm" className="mt-3" onClick={createUser} disabled={saving}>
          {saving ? "Creating…" : "Create user"}
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-100 bg-slate-50/60 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">User</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Reports</th>
              <th className="px-4 py-3 font-medium">Last login</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {users.map((u) => (
              <tr key={u.id} className="hover:bg-slate-50/60">
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-900">{u.name}</div>
                  <div className="text-xs text-slate-500">{u.email}</div>
                </td>
                <td className="px-4 py-3">
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
                    <Badge tone={ROLE_TONE[u.role]}>{u.role.replace("_", " ")}</Badge>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-600">{u._count.reports}</td>
                <td className="px-4 py-3 text-slate-600">{u.lastLoginAt ? formatDate(u.lastLoginAt) : "Never"}</td>
                <td className="px-4 py-3">
                  <Badge tone={u.active ? "green" : "slate"}>{u.active ? "Active" : "Inactive"}</Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={u.id === currentUserId}
                    onClick={() => updateUser(u.id, { active: !u.active })}
                  >
                    {u.active ? "Deactivate" : "Activate"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
