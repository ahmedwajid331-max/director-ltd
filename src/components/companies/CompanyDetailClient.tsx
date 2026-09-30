"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Star, Trash2, RotateCcw, Plus, Phone, Mail, UserPlus, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { formatDate, formatDateOnly } from "@/lib/data/format";

interface DirectorVM {
  id: string;
  name: string;
  role: string;
  occupation: string | null;
  email: string | null;
  phone: string | null;
  manuallyAdded: boolean;
  appointedOn: string | null;
}

interface NoteVM {
  id: string;
  body: string;
  authorName: string;
  createdAt: string;
}

interface FollowUpVM {
  id: string;
  dueDate: string;
  note: string | null;
  done: boolean;
}

export function CompanyDetailClient({
  companyId,
  initialFollowed,
  initialTrashed,
  initialDirectors,
  initialNotes,
  initialFollowUps,
}: {
  companyId: string;
  initialFollowed: boolean;
  initialTrashed: boolean;
  initialDirectors: DirectorVM[];
  initialNotes: NoteVM[];
  initialFollowUps: FollowUpVM[];
}) {
  const router = useRouter();
  const [followed, setFollowed] = useState(initialFollowed);
  const [trashed, setTrashed] = useState(initialTrashed);
  const [stateError, setStateError] = useState<string | null>(null);
  const [directors, setDirectors] = useState(initialDirectors);
  const [notes, setNotes] = useState(initialNotes);
  const [followUps, setFollowUps] = useState(initialFollowUps);

  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  const [contact, setContact] = useState({ name: "", role: "", email: "", phone: "", occupation: "" });
  const [savingContact, setSavingContact] = useState(false);

  const [followUpDate, setFollowUpDate] = useState("");
  const [followUpNote, setFollowUpNote] = useState("");
  const [savingFollowUp, setSavingFollowUp] = useState(false);

  async function toggleState(patch: { followed?: boolean; trashed?: boolean }) {
    // Remember the pre-toggle values so a failed write can be reverted
    // instead of leaving the button showing a state that was never saved.
    const previousFollowed = followed;
    const previousTrashed = trashed;

    if (patch.followed !== undefined) setFollowed(patch.followed);
    if (patch.trashed !== undefined) setTrashed(patch.trashed);
    setStateError(null);

    try {
      const res = await fetch(`/api/companies/${companyId}/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      router.refresh();
    } catch (err) {
      // Revert the optimistic update — the write did not actually persist.
      setFollowed(previousFollowed);
      setTrashed(previousTrashed);
      setStateError(err instanceof Error ? err.message : "Could not save — please try again.");
    }
  }

  async function addNote() {
    if (!noteText.trim()) return;
    setSavingNote(true);
    try {
      const res = await fetch(`/api/companies/${companyId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: noteText.trim() }),
      });
      const data = await res.json();
      if (data.note) {
        setNotes((prev) => [{ ...data.note, createdAt: data.note.createdAt }, ...prev]);
        setNoteText("");
      }
    } finally {
      setSavingNote(false);
    }
  }

  async function addContact() {
    if (!contact.name.trim()) return;
    setSavingContact(true);
    try {
      const res = await fetch(`/api/companies/${companyId}/directors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(contact),
      });
      const data = await res.json();
      if (data.director) {
        setDirectors((prev) => [...prev, data.director]);
        setContact({ name: "", role: "", email: "", phone: "", occupation: "" });
      }
    } finally {
      setSavingContact(false);
    }
  }

  async function addFollowUp() {
    if (!followUpDate) return;
    setSavingFollowUp(true);
    try {
      const res = await fetch(`/api/companies/${companyId}/followups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dueDate: followUpDate, note: followUpNote }),
      });
      const data = await res.json();
      if (data.followUp) {
        setFollowUps((prev) => [...prev, data.followUp].sort((a, b) => a.dueDate.localeCompare(b.dueDate)));
        setFollowUpDate("");
        setFollowUpNote("");
      }
    } finally {
      setSavingFollowUp(false);
    }
  }

  async function markFollowUpDone(id: string, done: boolean) {
    setFollowUps((prev) => prev.map((f) => (f.id === id ? { ...f, done } : f)));
    await fetch(`/api/followups/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done }),
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <Button variant={followed ? "primary" : "outline"} size="sm" onClick={() => toggleState({ followed: !followed })}>
          <Star className={`h-4 w-4 ${followed ? "fill-white" : ""}`} />
          {followed ? "Followed" : "Follow"}
        </Button>
        {trashed ? (
          <Button variant="outline" size="sm" onClick={() => toggleState({ trashed: false })}>
            <RotateCcw className="h-4 w-4" /> Restore
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => toggleState({ trashed: true })}>
            <Trash2 className="h-4 w-4" /> Send to trash
          </Button>
        )}
        {stateError && <p className="flex items-center text-sm text-red-600">{stateError}</p>}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* Directors & contacts */}
          <section className="rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-5 py-4">
              <h3 className="text-sm font-semibold text-slate-900">Directors & contacts</h3>
            </div>
            <div className="divide-y divide-slate-100">
              {directors.map((d) => (
                <div key={d.id} className="flex items-start justify-between gap-3 px-5 py-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-900">{d.name}</span>
                      {d.manuallyAdded && <Badge tone="indigo">Manually added</Badge>}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {d.role} {d.occupation ? `· ${d.occupation}` : ""}
                      {d.appointedOn ? ` · appointed ${formatDate(d.appointedOn)}` : ""}
                    </div>
                    <div className="mt-1 flex gap-3 text-xs text-slate-500">
                      {d.email && (
                        <span className="inline-flex items-center gap-1">
                          <Mail className="h-3 w-3" /> {d.email}
                        </span>
                      )}
                      {d.phone && (
                        <span className="inline-flex items-center gap-1">
                          <Phone className="h-3 w-3" /> {d.phone}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {directors.length === 0 && (
                <p className="px-5 py-4 text-sm text-slate-400">No directors on file yet.</p>
              )}
            </div>
            <div className="space-y-2 border-t border-slate-100 bg-slate-50/50 px-5 py-4">
              <p className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
                <UserPlus className="h-3.5 w-3.5" /> Add a director contact manually
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  placeholder="Full name"
                  value={contact.name}
                  onChange={(e) => setContact({ ...contact, name: e.target.value })}
                />
                <Input
                  placeholder="Role (optional)"
                  value={contact.role}
                  onChange={(e) => setContact({ ...contact, role: e.target.value })}
                />
                <Input
                  placeholder="Email (optional)"
                  value={contact.email}
                  onChange={(e) => setContact({ ...contact, email: e.target.value })}
                />
                <Input
                  placeholder="Phone (optional)"
                  value={contact.phone}
                  onChange={(e) => setContact({ ...contact, phone: e.target.value })}
                />
              </div>
              <Button size="sm" variant="outline" onClick={addContact} disabled={savingContact || !contact.name.trim()}>
                <Plus className="h-3.5 w-3.5" /> Add contact
              </Button>
            </div>
          </section>

          {/* Notes */}
          <section className="rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-5 py-4">
              <h3 className="text-sm font-semibold text-slate-900">Notes</h3>
            </div>
            <div className="space-y-2 px-5 py-4">
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="Add a note about this company…"
                rows={2}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-ring focus:border-indigo-400"
              />
              <Button size="sm" onClick={addNote} disabled={savingNote || !noteText.trim()}>
                Add note
              </Button>
            </div>
            <div className="divide-y divide-slate-100 border-t border-slate-100">
              {notes.map((n) => (
                <div key={n.id} className="px-5 py-3">
                  <p className="text-sm text-slate-700">{n.body}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    {n.authorName} · {formatDate(n.createdAt)}
                  </p>
                </div>
              ))}
              {notes.length === 0 && <p className="px-5 py-4 text-sm text-slate-400">No notes yet.</p>}
            </div>
          </section>
        </div>

        {/* Follow-ups */}
        <div className="space-y-6">
          <section className="rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-5 py-4">
              <h3 className="text-sm font-semibold text-slate-900">Follow-ups</h3>
            </div>
            <div className="space-y-2 px-5 py-4">
              <Label>Due date</Label>
              <Input type="date" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} />
              <Input
                className="mt-2"
                placeholder="Reminder note (optional)"
                value={followUpNote}
                onChange={(e) => setFollowUpNote(e.target.value)}
              />
              <Button size="sm" className="mt-1" onClick={addFollowUp} disabled={savingFollowUp || !followUpDate}>
                <Plus className="h-3.5 w-3.5" /> Schedule follow-up
              </Button>
            </div>
            <div className="divide-y divide-slate-100 border-t border-slate-100">
              {followUps.map((f) => (
                <div key={f.id} className="flex items-start justify-between gap-2 px-5 py-3">
                  <div>
                    <p className={`text-sm font-medium ${f.done ? "text-slate-400 line-through" : "text-slate-900"}`}>
                      {formatDateOnly(f.dueDate)}
                    </p>
                    {f.note && <p className="text-xs text-slate-500">{f.note}</p>}
                  </div>
                  <button
                    onClick={() => markFollowUpDone(f.id, !f.done)}
                    className={`rounded-md p-1 ${f.done ? "text-emerald-500" : "text-slate-300 hover:text-emerald-500"}`}
                  >
                    <CheckCircle2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              {followUps.length === 0 && <p className="px-5 py-4 text-sm text-slate-400">No follow-ups scheduled.</p>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
