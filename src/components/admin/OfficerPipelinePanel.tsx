import { Users, Layers, Cpu, Gauge, ShieldAlert, Radio, UserSearch } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { SectionCard, Panel, StatRow, StatusPill } from "./AdminUi";
import { formatDate } from "@/lib/data/format";
import type { OfficerPipelineStatus } from "@/lib/companies-house/officerStatus";
import { OfficerPipelineActions } from "./OfficerPipelineActions";

const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString());

const Row = StatRow;

// Super Admin view of the officer coverage pipeline. Counts and timestamps
// only - no API keys or secrets are ever shown here.
export function OfficerPipelinePanel({ status }: { status: OfficerPipelineStatus }) {
  const { coverage, queue, worker, quota, breakers, requests24h, recentErrors } = status;
  const pct = coverage.total === 0 ? 0 : (coverage.full / coverage.total) * 100;
  const workerTone = worker.status === "success" || worker.status === "running" ? "green" : worker.status === "never" ? "amber" : worker.status === "partial" ? "amber" : "red";
  const breakerTone = (state: string) => (state === "closed" ? "green" : state === "half_open" ? "amber" : "red");

  return (
    <SectionCard
      icon={UserSearch}
      tone="violet"
      title="Officer data pipeline"
      description="Director coverage, queue, worker, Companies House quota and API health."
      action={<StatusPill tone={status.healthy ? "green" : "amber"}>{status.healthy ? "Healthy" : "Needs attention"}</StatusPill>}
    >
      <div className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-3">
        <Panel icon={Users} tone="violet" title="Officer coverage (real companies)">
          <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-violet-100" role="img" aria-label={`${pct.toFixed(1)}% confirmed`}>
            <div className="h-full rounded-full bg-violet-500" style={{ width: `${Math.max(pct, pct > 0 ? 1 : 0)}%` }} />
          </div>
          <Row label="Confirmed (full)">
            {n(coverage.full)} <span className="text-xs font-normal text-slate-400">({pct.toFixed(pct < 1 ? 2 : 1)}%)</span>
          </Row>
          <Row label="Not fetched (none)">{n(coverage.none)}</Row>
          <Row label="Unavailable">{n(coverage.unavailable)}</Row>
          <Row label="Dirty (change filed)">{n(coverage.dirty)}</Row>
          <Row label="Dirty or stale">{n(coverage.staleOrDirty)}</Row>
        </Panel>

        <Panel icon={Layers} tone="blue" title="Queue">
          <Row label="Depth (queued + retry + leased)">{n(queue.depth)}</Row>
          <Row label="Queued">{n(queue.queued)}</Row>
          <Row label="Retry">{n(queue.retry)}</Row>
          <Row label="Leased">{n(queue.leased)}</Row>
          <Row label="Parked" tone={queue.parked > 0 ? "red" : undefined}>{n(queue.parked)}</Row>
          {Object.keys(queue.byPriority).length > 0 && (
            <Row label="By priority">{Object.entries(queue.byPriority).map(([p, c]) => `${p}: ${c.toLocaleString()}`).join(" · ")}</Row>
          )}
        </Panel>

        <Panel icon={Cpu} tone="indigo" title="Worker">
          <Row label="Status">
            <StatusPill tone={workerTone}>{worker.status}</StatusPill>
          </Row>
          <Row label="Enabled in configuration">{worker.enabledByConfig ? (worker.crawlEnabledByConfig ? "Yes, with background crawl" : "Yes, queue only") : "No"}</Row>
          <Row label="Running now" tone={worker.idleWithBacklog ? "amber" : undefined}>{worker.runningNow ? "Yes" : "No"}</Row>
          <Row label="Last run">{worker.lastRunAt ? formatDate(worker.lastRunAt) : "Never"}</Row>
          <Row label="Last successful run">{worker.lastSuccessAt ? formatDate(worker.lastSuccessAt) : "Never"}</Row>
          <Row label="Last stop reason">{worker.lastStopReason ?? "—"}</Row>
          <Row label="Throughput (last run)">{worker.companiesPerMinute === null ? "—" : `${worker.companiesPerMinute}/min`}</Row>
          <Row label="Throughput (24h, active time)">{worker.last24hCompaniesPerHour === null ? "—" : `${worker.last24hCompaniesPerHour.toLocaleString()}/hour (${n(worker.last24hProcessed)} companies)`}</Row>
          {worker.idleWithBacklog && <p className="text-xs text-amber-700">{n(queue.depth)} job(s) are waiting but no worker has run for over a day. Start one with OFFICER_WORKER_ENABLED=1 on the scheduler (add OFFICER_CRAWL_ENABLED=1 for the background crawl), or run npm run ch:officer-worker.</p>}
          {!worker.crawlEnabledByConfig && coverage.none > 0 && <p className="text-xs text-slate-500">The background crawl is not enabled, so the {n(coverage.none)} companies with no officer data are fetched only when someone opens them or a report needs them.</p>}
          {worker.lastError && <p className="text-xs text-red-600">{worker.lastError}</p>}
        </Panel>

        <Panel icon={Gauge} tone="amber" title="Companies House quota (shared)">
          <Row label="Ceiling / headroom">
            {quota.limit} per window / {quota.headroom}
          </Row>
          <Row label="Window ends">{quota.windowEndsAt ? formatDate(quota.windowEndsAt) : "—"}</Row>
          <Row label="Used this window">
            {quota.used ? Object.entries(quota.used).map(([c, v]) => `${c} ${v}`).join(" · ") : "—"}
          </Row>
          <Row label="Reported remaining">{n(quota.headerRemaining)}</Row>
          <Row label="Global cooldown (429)" tone={quota.cooldownUntil ? "amber" : undefined}>{quota.cooldownUntil ? `until ${formatDate(quota.cooldownUntil)}` : "None"}</Row>
          <Row label="Background paused" tone={quota.backgroundPausedUntil ? "amber" : undefined}>{quota.backgroundPausedUntil ? `until ${formatDate(quota.backgroundPausedUntil)}` : "No"}</Row>
          <p className="text-xs text-slate-400">
            Reservations (policy): {Object.entries(quota.reserve).map(([c, v]) => `${c} ${v}`).join(" · ")}
          </p>
        </Panel>

        <Panel icon={ShieldAlert} tone="slate" title="Circuit breakers">
          <Row label="Auth (401/403)">
            <StatusPill tone={breakerTone(breakers.auth.state)}>{breakers.auth.state}</StatusPill>
          </Row>
          {breakers.auth.state !== "closed" && (
            <p className="text-xs text-red-600">
              {breakers.auth.reason ?? "Companies House rejected the API key"}
              {breakers.auth.openUntil ? ` · next probe ${formatDate(breakers.auth.openUntil)}` : ""}
            </p>
          )}
          <Row label="Outage (5xx / network)">
            <StatusPill tone={breakerTone(breakers.outage.state)}>{breakers.outage.state}</StatusPill>
          </Row>
          {breakers.outage.state !== "closed" && (
            <p className="text-xs text-amber-700">
              {breakers.outage.reason ?? "Companies House outage"}
              {breakers.outage.openUntil ? ` · paused until ${formatDate(breakers.outage.openUntil)}` : ""}
            </p>
          )}
        </Panel>

        <Panel icon={Radio} tone="emerald" title="Companies House responses (24h)">
          <Row label="Requests">{n(requests24h.requests)}</Row>
          <Row label="429 rate limited" tone={requests24h.status429 ? "amber" : undefined}>{n(requests24h.status429)}</Row>
          <Row label="401 / 403 auth" tone={requests24h.statusAuth ? "red" : undefined}>{n(requests24h.statusAuth)}</Row>
          <Row label="5xx" tone={requests24h.status5xx ? "red" : undefined}>{n(requests24h.status5xx)}</Row>
          <Row label="Network errors" tone={requests24h.networkErrors ? "amber" : undefined}>{n(requests24h.networkErrors)}</Row>
          <Row label="404">{n(requests24h.status404)}</Row>
        </Panel>
      </div>

      <div className="border-t border-slate-100 px-5 py-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Recent officer errors</p>
        {recentErrors.length === 0 ? (
          <p className="text-sm text-slate-500">No failed or parked companies.</p>
        ) : (
          <div className="divide-y divide-slate-100 text-sm">
            {recentErrors.map((e) => (
              <div key={e.companyId} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span className="font-mono text-xs text-slate-600">{e.companyNumber ?? e.companyId}</span>
                <span className="flex items-center gap-2">
                  <Badge tone={e.status === "parked" ? "red" : "amber"}>{e.status}</Badge>
                  <span className="text-xs text-slate-400">
                    {e.attempts} attempt{e.attempts === 1 ? "" : "s"}
                    {e.lastHttpStatus ? ` · HTTP ${e.lastHttpStatus}` : ""}
                  </span>
                  <span className="max-w-[260px] truncate text-xs text-slate-500" title={e.lastError ?? undefined}>
                    {e.lastError}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
        <OfficerPipelineActions parked={queue.parked} authOpen={breakers.auth.state !== "closed"} outageOpen={breakers.outage.state !== "closed"} />
      </div>
    </SectionCard>
  );
}
