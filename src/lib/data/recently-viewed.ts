import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { visibleCompaniesWhere } from "./scope";

// Per-user "recently viewed" list. One row per (user, company); opening a company again only moves viewedAt
// forward, so the table grows with distinct companies a person has opened, never with page views.
export async function recordCompanyView(userId: string, companyId: string): Promise<void> {
  await db.recentlyViewed.upsert({
    where: { userId_companyId: { userId, companyId } },
    create: { userId, companyId },
    update: { viewedAt: new Date() },
  });
}

export const RECENTLY_VIEWED_MAX = 20;

// P2021 = "the table does not exist": this database has not had the 20261007120000_recently_viewed migration applied
// yet. That is a deployment step, not a reason for the dashboard to fail, so it degrades to an empty list (and says so
// once in the server log). Every other error still throws.
let warnedMissingTable = false;
function isMissingTable(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2021";
}
function warnMissingTable() {
  if (warnedMissingTable) return;
  warnedMissingTable = true;
  console.warn('[recently-viewed] table "RecentlyViewed" is missing: run `npx prisma migrate deploy` to apply 20261007120000_recently_viewed.');
}

// Newest first, hard-capped (default 10): an indexed (userId, viewedAt) read joined to at most `limit` companies.
export async function listRecentlyViewed(userId: string, limit = 10) {
  const take = Math.min(Math.max(1, Math.trunc(limit)), RECENTLY_VIEWED_MAX);
  try {
    const rows = await db.recentlyViewed.findMany({
      where: { userId, company: visibleCompaniesWhere() },
      orderBy: { viewedAt: "desc" },
      take,
      select: {
        viewedAt: true,
        company: { select: { id: true, name: true, companyNumber: true, status: true, registeredPostcode: true } },
      },
    });
    return rows.map((r) => ({ ...r.company, viewedAt: r.viewedAt }));
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    warnMissingTable();
    return [];
  }
}
