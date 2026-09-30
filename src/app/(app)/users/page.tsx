import type { Metadata } from "next";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth/guard";
import type { UserRole } from "@/lib/types";
import { UsersClient } from "./UsersClient";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage() {
  const session = await requireRole("ADMIN");

  const users = await db.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      active: true,
      createdAt: true,
      lastLoginAt: true,
      _count: { select: { reports: true } },
    },
  });

  return (
    <div className="space-y-1">
      <h2 className="text-lg font-semibold text-slate-900">Users</h2>
      <p className="mb-4 text-sm text-slate-500">Create and manage access for your team.</p>
      <UsersClient
        initialUsers={users.map((u) => ({
          ...u,
          role: u.role as UserRole,
          createdAt: u.createdAt.toISOString(),
          lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
        }))}
        canAssignRoles={session.role === "SUPER_ADMIN"}
        currentUserId={session.userId}
      />
    </div>
  );
}
