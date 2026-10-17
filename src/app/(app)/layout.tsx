import { requireSession } from "@/lib/auth/guard";
import { AppShell } from "@/components/app-shell/AppShell";
import { countRealCompanies } from "@/lib/data/companies";
import { avatarUrl, findAvatar } from "@/lib/avatar";

export default async function AppGroupLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const [realCompanyCount, avatar] = await Promise.all([countRealCompanies(), findAvatar(session.userId)]);

  return (
    <AppShell role={session.role} permissions={session.permissions} userName={session.name} userEmail={session.email} avatarSrc={avatar ? avatarUrl(session.userId, avatar.mtimeMs) : null} realCompanyCount={realCompanyCount}>
      {children}
    </AppShell>
  );
}
