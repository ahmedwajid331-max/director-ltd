"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarDays, Check, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { StatusPill } from "@/components/admin/AdminUi";
import { formatDate } from "@/lib/data/format";

interface ConnectionVM {
  provider: string;
  status: string;
  accountEmail: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

// Fixed sentences for the codes the callback can return (provider error text is never shown or put in a URL).
const CALENDAR_ERRORS: Record<string, string> = {
  access_denied: "Google access was not granted, so nothing was connected.",
  invalid_callback: "The connection could not be verified (the link expired or was not started from this browser). Please try Connect again.",
  no_refresh_token: "Google did not give permission to keep syncing. Please try Connect again and accept all requested access.",
  not_permitted: "Your account is not allowed to use the calendar.",
  connection_failed: "Google Calendar could not be connected. Please try again.",
};

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
    <div className="space-y-3 p-5">
      {connectedMsg && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          <Check className="h-4 w-4" /> Google Calendar connected. Your open follow-ups are being added to the &ldquo;DIRECTOR.LTD Follow-ups&rdquo; calendar.
        </div>
      )}
      {errorMsg && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <X className="h-4 w-4" /> {CALENDAR_ERRORS[errorMsg] ?? CALENDAR_ERRORS.connection_failed}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm transition-colors hover:border-indigo-200">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
            <CalendarDays className="h-[18px] w-[18px]" />
          </span>
          <div>
            <p className="text-sm font-medium text-slate-800">Google Calendar</p>
            {google ? (
              <p className="text-xs text-slate-500">
                Connected as {google.accountEmail} · last synced {formatDate(google.lastSyncAt)}
              </p>
            ) : (
              <p className="text-xs text-slate-500">
                {googleConfigured ? "Not connected" : "Not configured on the server yet. Ask a Super Admin to add the Google credentials."}
              </p>
            )}
            {!google && googleConfigured && (
              <p className="text-xs text-slate-400">Follow-ups you schedule then appear as all-day events in a &ldquo;DIRECTOR.LTD Follow-ups&rdquo; calendar in your own Google account.</p>
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
            className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-700"
          >
            Connect
          </a>
        ) : (
          <Button size="sm" disabled>
            Connect
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200/70 bg-gradient-to-r from-emerald-50/60 to-white px-4 py-3">
        <div>
          <p className="text-sm font-medium text-slate-800">Internal DIRECTOR.LTD calendar</p>
          <p className="text-xs text-slate-500">Always available — follow-ups are never lost if an external provider fails.</p>
        </div>
        <StatusPill tone="green">Always on</StatusPill>
      </div>

      <p className="text-xs text-slate-500">
        Microsoft/Outlook Calendar is supported by the same provider interface and can be added without changing the
        CRM or follow-up code — it just isn&apos;t wired up yet.
      </p>
    </div>
  );
}
