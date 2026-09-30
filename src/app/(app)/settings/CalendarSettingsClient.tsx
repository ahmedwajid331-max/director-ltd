"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarDays, Check, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { formatDate } from "@/lib/data/format";

interface ConnectionVM {
  provider: string;
  status: string;
  accountEmail: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

export function CalendarSettingsClient({
  googleConfigured,
  initialConnections,
}: {
  googleConfigured: boolean;
  initialConnections: ConnectionVM[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [connections, setConnections] = useState(initialConnections);
  const [disconnecting, setDisconnecting] = useState(false);

  const google = connections.find((c) => c.provider === "GOOGLE" && c.status === "CONNECTED");
  const connectedMsg = searchParams.get("calendarConnected");
  const errorMsg = searchParams.get("calendarError");

  async function disconnectGoogle() {
    setDisconnecting(true);
    try {
      await fetch("/api/calendar/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "GOOGLE" }),
      });
      setConnections((prev) => prev.filter((c) => c.provider !== "GOOGLE"));
      router.refresh();
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="space-y-3 px-5 py-4">
      {connectedMsg && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          <Check className="h-4 w-4" /> Google Calendar connected.
        </div>
      )}
      {errorMsg && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <X className="h-4 w-4" /> Calendar connection failed: {errorMsg}
        </div>
      )}

      <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-slate-400" />
          <div>
            <p className="text-sm font-medium text-slate-800">Google Calendar</p>
            {google ? (
              <p className="text-xs text-slate-500">
                Connected as {google.accountEmail} · last synced {formatDate(google.lastSyncAt)}
              </p>
            ) : (
              <p className="text-xs text-slate-500">
                {googleConfigured ? "Not connected" : "Not configured on the server yet"}
              </p>
            )}
            {google?.lastSyncError && <p className="text-xs text-red-600">Last error: {google.lastSyncError}</p>}
          </div>
        </div>
        {google ? (
          <Button variant="outline" size="sm" onClick={disconnectGoogle} disabled={disconnecting}>
            Disconnect
          </Button>
        ) : googleConfigured ? (
          // Plain <a>, not next/link — this hits an API route that issues a
          // real HTTP redirect to Google's OAuth consent screen, not an
          // internal Next.js page.
          <a
            href="/api/calendar/connect/google"
            className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
          >
            Connect
          </a>
        ) : (
          <Button size="sm" disabled>
            Connect
          </Button>
        )}
      </div>

      <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5">
        <div>
          <p className="text-sm font-medium text-slate-800">Internal DIRECTOR.LTD calendar</p>
          <p className="text-xs text-slate-500">Always available — follow-ups are never lost if an external provider fails.</p>
        </div>
        <Badge tone="green">Always on</Badge>
      </div>

      <p className="text-xs text-slate-500">
        Microsoft/Outlook Calendar is supported by the same provider interface and can be added without changing the
        CRM or follow-up code — it just isn&apos;t wired up yet.
      </p>
    </div>
  );
}
