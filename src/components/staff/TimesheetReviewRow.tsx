"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

// Approve (optionally with fewer minutes than claimed), return for correction, or reject - the last two with a reason. The API enforces who may review whom;
// the approved figure can never exceed what the person claimed.
export function TimesheetReviewRow({ id, submittedMinutes }: { id: string; submittedMinutes: number }) {
  const router = useRouter();
  const [minutes, setMinutes] = useState(String(submittedMinutes));
  const [reason, setReason] = useState("");
  const [reasonFor, setReasonFor] = useState<"reject" | "return" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/timesheets/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error ?? "Could not save that.");
      else router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const n = Number(minutes);
  const valid = Number.isInteger(n) && n >= 0 && n <= submittedMinutes;
  return (
    <div className="space-y-1.5">
      {reasonFor ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input className="max-w-64" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder={reasonFor === "reject" ? "Reason (required)" : "What to correct (required)"} aria-label={reasonFor === "reject" ? "Reason for rejecting" : "What needs correcting"} />
          <Button size="sm" variant={reasonFor === "reject" ? "danger" : "primary"} disabled={busy || !reason.trim()} onClick={() => send({ action: reasonFor, reviewNote: reason.trim() })}>
            {reasonFor === "reject" ? "Reject" : "Return"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setReasonFor(null)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            Approve
            <Input className="w-20 py-1" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="Approved minutes" />
            min
          </label>
          <Button size="sm" disabled={busy || !valid} onClick={() => send({ action: "approve", approvedMinutes: n })}>
            <Check className="h-4 w-4" /> Approve
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setReasonFor("return")}>
            <Undo2 className="h-4 w-4" /> Return
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setReasonFor("reject")}>
            <X className="h-4 w-4" /> Reject
          </Button>
        </div>
      )}
      {!valid && !reasonFor && <p className="text-[11px] text-amber-700">Approved minutes must be a whole number from 0 to {submittedMinutes}.</p>}
      {error && (
        <p role="alert" className="text-xs font-medium text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

// Correct an already-approved day. The reason is mandatory and the original decision stays in the audit trail; the pay rate
// stays the one captured when the day was first approved.
export function TimesheetAmendRow({ id, submittedMinutes, approvedMinutes }: { id: string; submittedMinutes: number; approvedMinutes: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState(String(approvedMinutes));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = Number(minutes);
  const valid = Number.isInteger(n) && n >= 0 && n <= submittedMinutes && n !== approvedMinutes && reason.trim().length > 0;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/timesheets/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "amend", approvedMinutes: n, reviewNote: reason.trim() }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error ?? "Could not save that.");
      else {
        setOpen(false);
        router.refresh();
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (!open)
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Amend
      </Button>
    );
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="w-20 py-1" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="Amended approved minutes" />
        <span className="text-xs text-slate-500">min</span>
        <Input className="max-w-56" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" aria-label="Reason for amending" />
        <Button size="sm" disabled={busy || !valid} onClick={save}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs font-medium text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
