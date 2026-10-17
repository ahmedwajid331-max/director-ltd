import type { Metadata } from "next";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth/guard";
import { userScopeWhere } from "@/lib/staff/scope";
import type { UserRole } from "@/lib/types";
import { Users } from "lucide-react";
import { PageHero, HeroChip } from "@/components/admin/AdminUi";
import { avatarUrl, findAvatar } from "@/lib/avatar";
import { UsersClient } from "./UsersClient";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage() {
  const session = await requirePermission("staff.manage");

  const isSuper = session.role === "SUPER_ADMIN";
  const supervisors = isSuper ? await db.user.findMany({ where: { active: true, role: { in: ["ADMIN", "SUPER_ADMIN"] } }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [];
  const users = await db.user.findMany({
    where: userScopeWhere(session),
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

  // Same secure, versioned picture URL the header uses (null when the person has none).
  const avatars = await Promise.all(users.map((u) => findAvatar(u.id)));

  return (
    <div className="space-y-6">
      <PageHero icon={Users} eyebrow="Team management" title="Users" description={isSuper ? "Create accounts, set what each person may do, and manage access." : "Create and manage accounts for your team."}>
        <HeroChip label="Users" value={users.length.toLocaleString()} />
        <HeroChip label="Active" value={users.filter((u) => u.active).length.toLocaleString()} dot="green" />
        <HeroChip label="Admins" value={users.filter((u) => u.role !== "USER").length.toLocaleString()} />
      </PageHero>
      <UsersClient
        initialUsers={users.map((u, i) => ({
          ...u,
          avatarSrc: avatars[i] ? avatarUrl(u.id, avatars[i]!.mtimeMs) : null,
          role: u.role as UserRole,
          createdAt: u.createdAt.toISOString(),
          lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
        }))}
        canAssignRoles={isSuper}
        supervisors={supervisors}
        currentUserId={session.userId}
      />
    </div>
  );
}
