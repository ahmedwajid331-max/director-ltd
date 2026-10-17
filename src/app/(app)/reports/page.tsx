import type { Metadata } from "next";
import Link from "next/link";
import { FileSearch, Plus, Pencil, Archive } from "lucide-react";
import { PageHero, HeroChip, EmptyPanel } from "@/components/admin/AdminUi";
import { formatDate } from "@/lib/data/format";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth/guard";
import { LinkButton } from "@/components/ui/Button";
import { ReportsArchive } from "./ReportsArchive";
import { describeFilter } from "@/lib/filters/describe";

function criteriaOf(filterJson: string): string {
  try {
    return describeFilter(JSON.parse(filterJson));
  } catch {
    return "";
  }
}

export const metadata: Metadata = { title: "Saved Reports" };

export default async function ReportsPage() {
  const session = await requirePermission("reports.viewOwn");
  const [reports, lastDaily] = await Promise.all([
    db.report.findMany({ where: { ownerId: session.userId }, orderBy: { createdAt: "desc" } }),
    // The job-level time (the whole system's last daily run). A report's OWN last automatic update is Report.lastAutoRefreshAt.
    db.ingestionRun.findFirst({
      where: { kind: "daily_update", status: { in: ["success", "partial"] } },
      orderBy: { startedAt: "desc" },
      select: { finishedAt: true },
    }),
  ]);

  const refreshOn = reports.filter((r) => r.dailyRefresh).length;
  const heroBtn = "inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors";

  return (
    <div className="space-y-5">
      <PageHero
        icon={Archive}
        accent="violet"
        eyebrow="Report archive"
        title="Report archive"
        description="Your saved reports. Reports with daily refresh ON update automatically from the live company data every day."
        aside={
          <div className="flex gap-2">
            <Link href="/reports/new?mode=edit" className={`${heroBtn} bg-white/10 text-white ring-1 ring-white/20 hover:bg-white/20`}>
              <Pencil className="h-4 w-4" /> Edit existing
            </Link>
            <Link href="/reports/new" className={`${heroBtn} bg-white text-indigo-700 hover:bg-indigo-50`}>
              <Plus className="h-4 w-4" /> Create report
            </Link>
          </div>
        }
      >
        <HeroChip label="Saved reports" value={reports.length.toLocaleString()} />
        <HeroChip label="Daily refresh on" value={refreshOn.toLocaleString()} dot={refreshOn > 0 ? "green" : undefined} />
        {lastDaily?.finishedAt && <HeroChip label="Daily update job last ran" value={formatDate(lastDaily.finishedAt)} />}
      </PageHero>

      {reports.length === 0 ? (
        <EmptyPanel
          icon={FileSearch}
          tone="violet"
          title="No saved reports yet"
          description="Create a report, add your conditions, preview the results and save it. It will appear here."
          action={
            <LinkButton href="/reports/new" size="sm">
              Create your first report
            </LinkButton>
          }
        />
      ) : (
        <ReportsArchive
          lastAutomaticUpdate={lastDaily?.finishedAt?.toISOString() ?? null}
          reports={reports.map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            criteria: criteriaOf(r.filterJson),
            resultCount: r.resultCount,
            dailyRefresh: r.dailyRefresh,
            lastRefreshError: r.lastRefreshError,
            createdAt: r.createdAt.toISOString(),
            lastRunAt: r.lastRunAt?.toISOString() ?? null,
            lastAutoRefreshAt: r.lastAutoRefreshAt?.toISOString() ?? null,
          }))}
        />
      )}
    </div>
  );
}
