"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

// Manual recovery actions (Super Admin only; the API enforces it).
export function OfficerPipelineActions({ parked, authOpen, outageOpen }: { parked: number; authOpen: boolean; outageOpen: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function post(body: unknown, done: (json: Record<string, unknown>) => string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/officers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      setMessage(res.ok ? done(json) : (json.error ?? "Action failed."));
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (parked === 0 && !authOpen && !outageOpen) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {parked > 0 && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => post({ action: "retry_parked" }, (j) => `Re-queued ${String(j.requeued)} parked companies.`)}>
          Retry parked companies ({parked.toLocaleString()})
        </Button>
      )}
      {authOpen && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => post({ action: "reset_breaker", breaker: "auth" }, () => "Auth breaker reset. Check the API key first - a wrong key will trip it again.")}>
          Reset auth breaker
        </Button>
      )}
      {outageOpen && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => post({ action: "reset_breaker", breaker: "outage" }, () => "Outage breaker reset.")}>
          Reset outage breaker
        </Button>
      )}
      {message && <span className="text-xs text-slate-600">{message}</span>}
    </div>
  );
}
