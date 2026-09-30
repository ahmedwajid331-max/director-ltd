import { requireSession } from "@/lib/auth/guard";
import { AppShell } from "@/components/app-shell/AppShell";
import { db } from "@/lib/db";

export default async function AppGroupLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const realCompanyCount = await db.company.count({ where: { source: { not: "seed" } } });

  return (
    <AppShell role={session.role} userName={session.name} userEmail={session.email} hasRealData={realCompanyCount > 0}>
      {children}
    </AppShell>
  );
}
