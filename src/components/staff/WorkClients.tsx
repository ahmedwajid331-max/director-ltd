"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Send } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";

export function CompleteAssignmentButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/assignments/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "complete" }) });
      if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? "Could not complete that.");
      else router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" disabled={busy} onClick={go}>
        <CheckCircle2 className="h-4 w-4" /> {busy ? "Saving…" : "Mark complete"}
      </Button>
      {error && (
        <span role="alert" className="text-[11px] font-medium text-red-600">
          {error}
        </span>
      )}
    </span>
  );
}

// Staff report their own hours for a day. This is a claim for a supervisor to approve; nothing is calculated from login time.
export function TimesheetForm({ today, minDate }: { today: string; minDate: string }) {
  const router = useRouter();
  const [workDate, setWorkDate] = useState(today);
  const [hours, setHours] = useState("");
  const [mins, setMins] = useState("0");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    const h = Number(hours || 0);
    const m = Number(mins || 0);
    const minutes = h * 60 + m;
    if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || m > 59 || minutes < 1 || minutes > 1440) {
      return setMsg({ ok: false, text: "Enter hours and minutes (minutes 0-59), up to 24 hours in total." });
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/timesheets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workDate, minutes, ...(note.trim() ? { note: note.trim() } : {}) }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setMsg({ ok: false, text: data.error ?? "Could not submit that." });
      setMsg({ ok: true, text: "Submitted for approval." });
      setHours("");
      setMins("0");
      setNote("");
      router.refresh();
    } catch {
      setMsg({ ok: false, text: "Could not reach the server." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[10rem_6rem_6rem_minmax(0,1fr)_auto] sm:items-end">
        <div>
          <Label>Day worked</Label>
          <Input type="date" value={workDate} min={minDate} max={today} onChange={(e) => setWorkDate(e.target.value)} />
        </div>
        <div>
          <Label>Hours</Label>
          <Input inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="0" />
        </div>
        <div>
          <Label>Minutes</Label>
          <Input inputMode="numeric" value={mins} onChange={(e) => setMins(e.target.value)} placeholder="0" />
        </div>
        <div>
          <Label>What you worked on (optional)</Label>
          <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </div>
        <Button size="sm" onClick={submit} disabled={busy}>
          <Send className="h-4 w-4" /> {busy ? "Submitting…" : "Submit"}
        </Button>
      </div>
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={`text-xs font-medium ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
