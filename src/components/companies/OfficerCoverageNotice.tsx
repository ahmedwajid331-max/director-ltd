"use client";

import { useState } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/Button";

export interface OfficerCoverageSummary {
  hasDirectorRules: boolean;
  confirmed: number;
  unknown: number;
}

// Shown whenever a filter/report contains a director rule: how many companies
// match for certain, and how many MORE could not be evaluated yet because
// their officer data is not confirmed. Never presented as a complete result
// while unknown > 0. The action only QUEUES the fetch (the officer worker does
// it within the shared quota); it makes no Companies House calls itself.
export function OfficerCoverageNotice({
  summary,
  request,
}: {
  summary: OfficerCoverageSummary | null;
  // What to send to /api/officers/enqueue (the same filter / report as the results).
  request: { filter?: unknown; q?: string; scope?: string; reportId?: string };
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (!summary || !summary.hasDirectorRules) return null;

  async function enqueue() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/officers/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error ?? "Could not queue the officer fetch.");
      } else if (data.truncated) {
        setMessage(`Queued ${data.queued.toLocaleString()} companies (the limit per request is ${data.cap.toLocaleString()}). Narrow the filter to queue the rest.`);
      } else {
        setMessage(
          data.queued + data.alreadyQueued === 0
            ? "Nothing to queue: the remaining companies have no officer data available from Companies House."
            : `Queued ${data.queued.toLocaleString()} companies${data.alreadyQueued ? ` (${data.alreadyQueued.toLocaleString()} were already queued)` : ""}. Results update as officer data arrives.`
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 print:hidden">
      <Info className="mt-0.5 h-4 w-4 flex-none text-slate-400" />
      <div className="min-w-[240px] flex-1">
        <p>
          <span className="font-medium">{summary.confirmed.toLocaleString()}</span> {summary.confirmed === 1 ? "company matches" : "companies match"}.
          {summary.unknown > 0 && (
            <>
              {" "}
              <span className="font-medium">{summary.unknown.toLocaleString()}</span> additional {summary.unknown === 1 ? "company" : "companies"} could not be
              evaluated because officer data is not available yet.
            </>
          )}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          Director filters only evaluate companies with confirmed officer data. Unfetched or unavailable companies are never counted as zero directors, so this
          result is {summary.unknown > 0 ? "not complete" : "complete for the companies we can evaluate"}.
        </p>
        {message && <p className="mt-1 text-xs text-slate-600">{message}</p>}
      </div>
      {summary.unknown > 0 && (
        <Button variant="outline" size="sm" onClick={enqueue} disabled={busy}>
          {busy ? "Queueing…" : "Fetch officer data for these companies"}
        </Button>
      )}
    </div>
  );
}
