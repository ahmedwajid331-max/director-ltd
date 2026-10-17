"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardPlus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";

// Supervisor form: give a staff member a company to work on (by its Companies House number). The API checks the
// permission and that this person is inside the supervisor's team.
export function AssignWorkForm({ assigneeId }: { assigneeId: string }) {
  const router = useRouter();
  const [companyNumber, setCompanyNumber] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    if (!companyNumber.trim()) return setMsg({ ok: false, text: "Enter a company number." });
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigneeId, companyNumber: companyNumber.trim(), ...(dueDate ? { dueDate } : {}), ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setMsg({ ok: false, text: data.error ?? "Could not assign that." });
      setMsg({ ok: true, text: "Assigned." });
      setCompanyNumber("");
      setNote("");
      router.refresh();
    } catch {
      setMsg({ ok: false, text: "Could not reach the server." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-[11rem_10rem_minmax(0,1fr)_auto] sm:items-end">
        <div>
          <Label>Company number</Label>
          <Input value={companyNumber} onChange={(e) => setCompanyNumber(e.target.value)} placeholder="e.g. 09711298" />
        </div>
        <div>
          <Label>Due date (optional)</Label>
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
        <div>
          <Label>Note (optional)</Label>
          <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="What should they do?" />
        </div>
        <Button size="sm" onClick={submit} disabled={busy}>
          <ClipboardPlus className="h-4 w-4" /> {busy ? "Assigning…" : "Assign"}
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
