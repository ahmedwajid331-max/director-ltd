import { requireSession } from "@/lib/auth/guard";
import { AppShell } from "@/components/app-shell/AppShell";
import { db } from "@/lib/db";
import { REAL_COMPANIES_WHERE } from "@/lib/data/scope";

export default async function AppGroupLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const realCompanyCount = await db.company.count({ where: REAL_COMPANIES_WHERE });

  return (
    <AppShell role={session.role} userName={session.name} userEmail={session.email} realCompanyCount={realCompanyCount}>
      {children}
    </AppShell>
  );
}
