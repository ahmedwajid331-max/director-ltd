"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, PhoneCall, ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Input";
import { CHANNEL_LABEL, CONTACT_CHANNELS, CONTACT_OUTCOMES, OUTCOME_LABEL, type ContactChannel, type ContactOutcome } from "@/lib/staff/contact";
import { formatDate } from "@/lib/data/format";

export interface ContactEntry {
  id: string;
  channel: ContactChannel;
  outcome: ContactOutcome;
  note: string | null;
  createdAt: string;
}

export interface MyAssignment {
  id: string;
  dueDate: string | null;
  note: string | null;
  assignedByName: string;
}

// Where a "contact" is actually recorded. Opening, searching or following a company never counts as contacting it; only
// an entry made here does - and reports show attempts and people reached separately.
export function ContactLogPanel({ companyId, canLog, entries, assignments }: { companyId: string; canLog: boolean; entries: ContactEntry[]; assignments: MyAssignment[] }) {
  const router = useRouter();
  const [channel, setChannel] = useState<ContactChannel>("call");
  const [outcome, setOutcome] = useState<ContactOutcome>("reached");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/contact-log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, outcome, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not record the contact.");
        return;
      }
      setNote("");
      router.refresh();
    } catch {
      setError("Could not record the contact. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function complete(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/assignments/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "complete" }) });
      if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? "Could not complete that.");
      else router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!canLog && entries.length === 0 && assignments.length === 0) return null;

  return (
    <section aria-label="Contact log and assigned work" className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      {assignments.map((a) => (
        <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-[13px] text-indigo-900">
          <span className="flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4 shrink-0" />
            <span>
              Assigned to you by <strong>{a.assignedByName}</strong>
              {a.dueDate && <> · due {formatDate(a.dueDate)}</>}
              {a.note && <> · {a.note}</>}
            </span>
          </span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => complete(a.id)}>
            <CheckCircle2 className="h-4 w-4" /> Mark complete
          </Button>
        </div>
      ))}

      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-900">
          <PhoneCall className="h-4 w-4 text-indigo-600" /> Contact log
          <span className="text-xs font-normal text-slate-500">Only contacts recorded here count as contacted.</span>
        </h3>
        {canLog && (
          <div className="grid gap-3 sm:grid-cols-[10rem_14rem_minmax(0,1fr)_auto] sm:items-end">
            <div>
              <Label>How</Label>
              <Select value={channel} onChange={(e) => setChannel(e.target.value as ContactChannel)}>
                {CONTACT_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABEL[c]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>What happened</Label>
              <Select value={outcome} onChange={(e) => setOutcome(e.target.value as ContactOutcome)}>
                {CONTACT_OUTCOMES.map((o) => (
                  <option key={o} value={o}>
                    {OUTCOME_LABEL[o]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Note (optional)</Label>
              <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Asked us to call back Monday" />
            </div>
            <Button size="sm" onClick={submit} disabled={busy}>
              {busy ? "Saving…" : "Record contact"}
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs font-medium text-red-600">
            {error}
          </p>
        )}
        {entries.length === 0 ? (
          <p className="mt-3 text-xs text-slate-500">No contact recorded for this company yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 text-[13px]">
            {entries.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5">
                <span className="text-slate-800">
                  <strong className="font-medium">{CHANNEL_LABEL[e.channel]}</strong> · {OUTCOME_LABEL[e.outcome]}
                  {e.note && <span className="text-slate-500"> — {e.note}</span>}
                </span>
                <span className="text-xs text-slate-400">{formatDate(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
