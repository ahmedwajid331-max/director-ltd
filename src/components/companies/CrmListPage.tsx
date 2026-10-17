import Link from "next/link";
import { Star, Bookmark, Flag, Trash2, CalendarClock, Info } from "lucide-react";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth/guard";
import { loadUserColumns } from "@/lib/columns/store";
import { PageHero, HeroChip } from "@/components/admin/AdminUi";
import { CompanyExplorer } from "./CompanyExplorer";

type Scope = "followed" | "saved" | "redFlagged" | "trashed";

const CONFIG = {
  followed: {
    icon: Star,
    accent: "blue",
    eyebrow: "Watchlist",
    title: "Followed companies",
    description: "Companies you are watching. Follow a company from UK Companies to keep it here and attach follow-ups to it.",
  },
  saved: {
    icon: Bookmark,
    accent: "violet",
    eyebrow: "Working list",
    title: "Saved companies",
    description: "Your private shortlist of companies worth coming back to, kept separate from follows and red flags.",
  },
  redFlagged: {
    icon: Flag,
    accent: "red",
    eyebrow: "Your red flags",
    title: "Red-flagged companies",
    description: "Companies you have marked as a concern. A red flag is your own private marker, not an official Companies House status.",
  },
  trashed: {
    icon: Trash2,
    accent: "amber",
    eyebrow: "Trash",
    title: "Trash",
    description: "Companies you have moved here are never permanently deleted. Restore any of them at any time.",
  },
} as const;

// Hero + the shared company explorer for the four CRM views. Counts use the same rules as the Dashboard
// (saved and red-flagged exclude trashed companies) and as each view's own query.
export async function CrmListPage({ scope }: { scope: Scope }) {
  const session = await requirePermission("crm.manage");
  const userId = session.userId;
  const c = CONFIG[scope];

  const [columnState, followed, saved, flagged, trashed, openFollowUps] = await Promise.all([
    loadUserColumns(userId),
    db.userCompanyState.count({ where: { userId, followed: true } }),
    db.userCompanyState.count({ where: { userId, saved: true, trashed: false } }),
    db.userCompanyState.count({ where: { userId, redFlagged: true, trashed: false } }),
    db.userCompanyState.count({ where: { userId, trashed: true } }),
    scope === "followed" ? db.followUp.count({ where: { userId, done: false } }) : Promise.resolve(0),
  ]);

  const count = { followed, saved, redFlagged: flagged, trashed }[scope];
  const noun = scope === "trashed" ? "In Trash" : scope === "followed" ? "Followed" : scope === "saved" ? "Saved" : "Red-flagged";

  return (
    <div className="space-y-5">
      <PageHero icon={c.icon} accent={c.accent} compact eyebrow={c.eyebrow} title={c.title} description={c.description}>
        <HeroChip label={noun} value={count.toLocaleString()} dot={scope === "redFlagged" && count > 0 ? "red" : undefined} />
        {scope === "followed" && (
          <Link href="/calendar" className="rounded-md bg-white/10 px-3 py-1.5 text-indigo-200 ring-1 ring-white/10 transition-colors hover:bg-white/15">
            <CalendarClock className="mr-1 inline h-3.5 w-3.5" aria-hidden /> Open follow-ups: <span className="font-semibold text-white">{openFollowUps.toLocaleString()}</span>
          </Link>
        )}
        {scope === "trashed" && (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-400/15 px-3 py-1.5 text-amber-100 ring-1 ring-amber-300/20">
            <Info className="h-3.5 w-3.5" aria-hidden /> Nothing here is permanently deleted
          </span>
        )}
      </PageHero>
      <CompanyExplorer scope={scope} initialColumns={columnState.columns} columnsNotice={columnState.recommendedChanged} />
    </div>
  );
}
