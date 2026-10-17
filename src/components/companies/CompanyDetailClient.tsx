"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Star,
  Trash2,
  RotateCcw,
  Plus,
  Phone,
  Mail,
  UserPlus,
  CheckCircle2,
  Circle,
  Bookmark,
  Flag,
  CalendarPlus,
  CalendarDays,
  CalendarCheck,
  Check,
  MoreHorizontal,
  Pencil,
  StickyNote,
  Users,
  Building2,
  History,
  ClipboardList,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Avatar } from "@/components/profile/Avatar";
import { ShareMenu } from "@/components/companies/ShareMenu";
import { Badge } from "@/components/ui/Badge";
import { formatDateOnly } from "@/lib/data/format";
import { cn } from "@/lib/cn";
import { SectionHeader, sectionCard } from "@/components/companies/WorkspaceSection";
import type { WorkspaceTab } from "@/lib/data/workspace-tab";

interface OfficerVM {
  id: string;
  name: string;
  role: string;
  occupation: string | null;
  appointedOn: string | null;
  resignedOn: string | null;
}

interface ContactVM {
  id: string;
  name: string;
  role: string;
  occupation: string | null;
  email: string | null;
  phone: string | null;
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

type ActivityKind = "saved" | "flag" | "follow" | "trash" | "note" | "contact" | "followup" | "done";
interface ActivityVM {
  id: string;
  text: string;
  kind: ActivityKind;
  createdAt: string;
}

// Official Companies House panels, built on the server and handed over as ready-made nodes.
interface OverviewNodes {
  identity: React.ReactNode;
  status: React.ReactNode;
  address: React.ReactNode;
  industry: React.ReactNode;
  accounts: React.ReactNode;
  officerSummary: React.ReactNode;
  structure: React.ReactNode;
  provenance: React.ReactNode;
}

const TZ = "Europe/London"; // fixed zone: server render and browser render always print the same text
const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });

// "Today · 10:42", "Yesterday · 16:05", "3 Oct 2026 · 09:12"
function formatNoteTime(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86_400_000);
  const k = dayKey(d);
  const day = k === dayKey(now) ? "Today" : k === dayKey(yesterday) ? "Yesterday" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: TZ });
  return `${day} · ${time}`;
}

const todayKey = () => new Date().toISOString().slice(0, 10);
function daysFromToday(dueIso: string): number {
  const due = Date.parse(dueIso.slice(0, 10) + "T00:00:00Z");
  const today = Date.parse(todayKey() + "T00:00:00Z");
  return Math.round((due - today) / 86_400_000);
}
function relativeDue(done: boolean, dueIso: string): string {
  if (done) return "Completed";
  const n = daysFromToday(dueIso);
  if (n === 0) return "Due today";
  if (n === 1) return "Due tomorrow";
  if (n > 1) return `In ${n} days`;
  return n === -1 ? "1 day overdue" : `${-n} days overdue`;
}

const emptyContact = { name: "", role: "", email: "", phone: "", occupation: "" };

function PanelHeader({ title, icon, count, crm, right }: { title: string; icon: React.ElementType; count?: number; crm?: boolean; right?: React.ReactNode }) {
  return <SectionHeader title={title} icon={icon} count={count} source={crm ? "crm" : "companies-house"} right={right} />;
}

function EmptyState({ icon: Icon, title, hint, crm }: { icon: React.ElementType; title: string; hint: string; crm?: boolean }) {
  return (
    <div className="flex items-center gap-3 px-4 py-5">
      <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1", crm ? "bg-violet-50 text-violet-400 ring-violet-100" : "bg-indigo-50 text-indigo-400 ring-indigo-100")}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-700">{title}</p>
        <p className="text-xs text-slate-500">{hint}</p>
      </div>
    </div>
  );
}

const inputCls =
  "h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-[13px] text-slate-900 placeholder:text-slate-400 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100";
const labelCls = "mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-500";

export function CompanyDetailClient({
  companyId,
  companyName,
  identity,
  kpis,
  overview,
  initialTab = "overview",
  initialFollowed,
  initialTrashed,
  initialSaved = false,
  initialRedFlagged = false,
  officers,
  initialContacts,
  initialNotes,
  initialFollowUps,
  activity: allActivity,
  authorAvatarSrc = null,
}: {
  companyId: string;
  companyName: string;
  identity: React.ReactNode;
  kpis: React.ReactNode;
  overview: OverviewNodes;
  initialTab?: WorkspaceTab;
  initialFollowed: boolean;
  initialTrashed: boolean;
  initialSaved?: boolean;
  initialRedFlagged?: boolean;
  officers: OfficerVM[];
  initialContacts: ContactVM[];
  initialNotes: NoteVM[];
  initialFollowUps: FollowUpVM[];
  activity: ActivityVM[];
  // Notes are private to their owner, so every note here was written by the signed-in user: one avatar covers them all.
  authorAvatarSrc?: string | null;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<WorkspaceTab>(initialTab);
  const [followed, setFollowed] = useState(initialFollowed);
  const [trashed, setTrashed] = useState(initialTrashed);
  const [saved, setSaved] = useState(initialSaved);
  const [redFlagged, setRedFlagged] = useState(initialRedFlagged);
  const [stateError, setStateError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [contacts, setContacts] = useState(initialContacts);
  const [notes, setNotes] = useState(initialNotes);
  const [followUps, setFollowUps] = useState(initialFollowUps);
  const [showFormer, setShowFormer] = useState(false);

  // Activity entries removed in this session. The server is the source of truth (a refresh no longer returns them); this
  // only hides them straight away, and never resurrects one if the server list is refreshed.
  const [removedActivity, setRemovedActivity] = useState<Set<string>>(new Set());
  const [activityConfirm, setActivityConfirm] = useState<string | "all" | null>(null);
  const [activityBusy, setActivityBusy] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const activity = allActivity.filter((a) => !removedActivity.has(a.id));

  async function deleteActivity(target: string | "all") {
    setActivityBusy(true);
    setActivityError(null);
    const url = target === "all" ? `/api/companies/${companyId}/activity` : `/api/companies/${companyId}/activity/${target}`;
    const res = await fetch(url, { method: "DELETE" }).catch(() => null);
    setActivityBusy(false);
    if (!res || !res.ok) {
      setActivityError("Could not delete. Nothing was removed.");
      return;
    }
    const gone = target === "all" ? activity.map((a) => a.id) : [target];
    setRemovedActivity((prev) => new Set([...prev, ...gone]));
    setActivityConfirm(null);
  }

  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [contact, setContact] = useState(emptyContact);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [confirmDeleteContactId, setConfirmDeleteContactId] = useState<string | null>(null);
  const [savingContact, setSavingContact] = useState(false);
  const [contactError, setContactError] = useState<string | null>(null);

  const [followUpDate, setFollowUpDate] = useState("");
  const [followUpNote, setFollowUpNote] = useState("");
  const [savingFollowUp, setSavingFollowUp] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);

  function selectTab(next: WorkspaceTab) {
    setTab(next);
    // Keep the tab in the address so a refresh / shared link lands on the same tab (no navigation, no reload).
    const url = new URL(window.location.href);
    if (next === "overview") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  }

  async function toggleState(patch: { followed?: boolean; trashed?: boolean; saved?: boolean; redFlagged?: boolean }) {
    // Remember the pre-toggle values so a failed write can be reverted
    // instead of leaving the button showing a state that was never saved.
    const previousFollowed = followed;
    const previousTrashed = trashed;
    const previousSaved = saved;
    const previousRedFlagged = redFlagged;

    if (patch.followed !== undefined) setFollowed(patch.followed);
    if (patch.trashed !== undefined) setTrashed(patch.trashed);
    if (patch.saved !== undefined) setSaved(patch.saved);
    if (patch.redFlagged !== undefined) setRedFlagged(patch.redFlagged);
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
      setSaved(previousSaved);
      setRedFlagged(previousRedFlagged);
      setStateError(err instanceof Error ? err.message : "Could not save — please try again.");
    }
  }

  async function addNote() {
    if (!noteText.trim()) return;
    setSavingNote(true);
    setNoteError(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: noteText.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.note) throw new Error(data.error || "Could not save the note.");
      setNotes((prev) => [data.note, ...prev]);
      setNoteText("");
      router.refresh();
    } catch (err) {
      setNoteError(err instanceof Error ? err.message : "Could not save the note.");
    } finally {
      setSavingNote(false);
    }
  }

  async function saveEdit(id: string) {
    if (!editText.trim()) return;
    setNoteError(null);
    const res = await fetch(`/api/notes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: editText.trim() }),
    }).catch(() => null);
    if (!res || !res.ok) {
      setNoteError("Could not update the note.");
      return;
    }
    const data = await res.json();
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, body: data.note.body } : n)));
    setEditingId(null);
    router.refresh();
  }

  async function deleteNote(id: string) {
    setNoteError(null);
    const res = await fetch(`/api/notes/${id}`, { method: "DELETE" }).catch(() => null);
    if (!res || !res.ok) {
      setNoteError("Could not delete the note.");
      return;
    }
    setNotes((prev) => prev.filter((n) => n.id !== id));
    setConfirmDeleteId(null);
    router.refresh();
  }

  async function saveContact() {
    if (!contact.name.trim()) return;
    setSavingContact(true);
    setContactError(null);
    try {
      const editing = editingContactId;
      const res = await fetch(editing ? `/api/contacts/${editing}` : `/api/companies/${companyId}/directors`, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(contact),
      });
      const data = await res.json().catch(() => ({}));
      const row = editing ? data.contact : data.director;
      if (!res.ok || !row) throw new Error(data.error || "Could not save the contact.");
      const vm: ContactVM = { id: row.id, name: row.name, role: row.role, occupation: row.occupation ?? null, email: row.email ?? null, phone: row.phone ?? null };
      setContacts((prev) => (editing ? prev.map((c) => (c.id === editing ? vm : c)) : [...prev, vm]));
      setContact(emptyContact);
      setEditingContactId(null);
      router.refresh();
    } catch (err) {
      setContactError(err instanceof Error ? err.message : "Could not save the contact.");
    } finally {
      setSavingContact(false);
    }
  }

  async function deleteContact(id: string) {
    const res = await fetch(`/api/contacts/${id}`, { method: "DELETE" }).catch(() => null);
    if (!res || !res.ok) {
      setContactError("Could not delete the contact.");
      return;
    }
    setContacts((prev) => prev.filter((c) => c.id !== id));
    setConfirmDeleteContactId(null);
    if (editingContactId === id) {
      setEditingContactId(null);
      setContact(emptyContact);
    }
    router.refresh();
  }

  async function addFollowUp() {
    if (!followUpDate) return;
    setSavingFollowUp(true);
    setFollowUpError(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/followups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dueDate: followUpDate, note: followUpNote }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.followUp) throw new Error(data.error || "Could not schedule the follow-up.");
      setFollowUps((prev) => [...prev, data.followUp].sort((a, b) => a.dueDate.localeCompare(b.dueDate)));
      setFollowUpDate("");
      setFollowUpNote("");
      router.refresh();
    } catch (err) {
      setFollowUpError(err instanceof Error ? err.message : "Could not schedule the follow-up.");
    } finally {
      setSavingFollowUp(false);
    }
  }

  async function markFollowUpDone(id: string, done: boolean) {
    setFollowUps((prev) => prev.map((f) => (f.id === id ? { ...f, done } : f)));
    const res = await fetch(`/api/followups/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done }),
    }).catch(() => null);
    if (!res || !res.ok) setFollowUps((prev) => prev.map((f) => (f.id === id ? { ...f, done: !done } : f)));
    else router.refresh();
  }

  const today = todayKey();
  const overdueFollowUps = followUps.filter((f) => !f.done && f.dueDate.slice(0, 10) < today);
  const scheduledFollowUps = followUps.filter((f) => !f.done && f.dueDate.slice(0, 10) >= today);
  const completedFollowUps = followUps.filter((f) => f.done);
  const openFollowUps = overdueFollowUps.length + scheduledFollowUps.length;
  const currentOfficers = officers.filter((o) => !o.resignedOn);
  const formerOfficers = officers.filter((o) => o.resignedOn);

  const tabs: { key: WorkspaceTab; label: string; icon: React.ElementType; count?: number }[] = [
    { key: "overview", label: "Overview", icon: Building2 },
    { key: "notes", label: "Notes & comments", icon: StickyNote, count: notes.length },
    { key: "contacts", label: "Contacts", icon: Users, count: contacts.length },
    { key: "followups", label: "Follow-ups", icon: CalendarCheck, count: openFollowUps },
    { key: "activity", label: "Activity", icon: History, count: activity.length },
  ];

  const tool = "inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors focus-ring";
  const toolIdle = "border-white/20 bg-white/10 text-white hover:bg-white/20";

  return (
    <div className="space-y-4">
      {/* Company identity + CRM toolbar. Sits above every tab so the user always knows which company they are in. */}
      <section className="rounded-2xl border border-slate-200 bg-white shadow-lg shadow-indigo-950/10">
        <div
          className="relative rounded-t-2xl text-white"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(135deg, var(--color-indigo-950), var(--color-indigo-900) 55%, var(--color-indigo-700))",
            backgroundSize: "36px 36px, 36px 36px, auto",
          }}
        >
          <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-t-2xl" aria-hidden>
            <svg className="absolute -right-10 -top-20 hidden h-72 w-72 text-white/10 md:block" viewBox="0 0 400 400" fill="none" stroke="currentColor" strokeWidth="1.2">
              <circle cx="200" cy="200" r="190" />
              <circle cx="200" cy="200" r="130" />
              <circle cx="200" cy="200" r="70" />
              <path d="M200 10v380M10 200h380" strokeOpacity=".5" />
            </svg>
          </div>
        <div className="relative flex max-w-full flex-col items-start gap-y-4 px-5 py-5">
          {identity}
          <div className="flex max-w-full flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => toggleState({ saved: !saved })}
              aria-pressed={saved}
              title={saved ? "Remove from Saved" : "Save: keep this company for later"}
              className={cn(tool, saved ? "border-white bg-white text-indigo-700" : toolIdle)}
            >
              <Bookmark className={cn("h-3.5 w-3.5", saved && "fill-indigo-600")} />
              {saved ? "Saved" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => toggleState({ followed: !followed })}
              aria-pressed={followed}
              title={followed ? "Unfollow" : "Follow: monitor this company and keep it on your Watches"}
              className={cn(tool, followed ? "border-amber-300 bg-amber-100 text-amber-900" : toolIdle)}
            >
              <Star className={cn("h-3.5 w-3.5", followed && "fill-amber-400 text-amber-500")} />
              {followed ? "Followed" : "Follow"}
            </button>
            <button type="button" onClick={() => selectTab("followups")} title="Follow-up: create a task / reminder (appears in your Calendar)" className={cn(tool, toolIdle)}>
              <CalendarPlus className="h-3.5 w-3.5" /> Follow-up
            </button>
            <ShareMenu companyId={companyId} companyName={companyName} buttonClassName={cn(tool, toolIdle)} />
            <span className="mx-0.5 hidden h-5 w-px bg-white/20 sm:block" aria-hidden />
            <button
              type="button"
              onClick={() => toggleState({ redFlagged: !redFlagged })}
              aria-pressed={redFlagged}
              aria-label={redFlagged ? "Remove red flag" : "Red flag"}
              title={redFlagged ? "Remove red flag" : "Red flag: mark as important / needs attention"}
              className={cn(tool, redFlagged ? "border-red-300 bg-red-50 text-red-700" : "border-white/20 bg-white/5 text-red-100 hover:bg-red-500/30")}
            >
              <Flag className={cn("h-3.5 w-3.5", redFlagged && "fill-red-500")} />
              <span className="hidden sm:inline">{redFlagged ? "Red flagged" : "Red flag"}</span>
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                aria-expanded={moreOpen}
                aria-haspopup="menu"
                aria-label="More actions"
                title="More actions"
                className={cn(tool, "w-9 justify-center px-0", toolIdle)}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {moreOpen && (
                <div role="menu" className="absolute right-0 z-20 mt-1 w-48 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      toggleState({ trashed: !trashed });
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
                  >
                    {trashed ? <RotateCcw className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                    {trashed ? "Restore from trash" : "Send to trash"}
                  </button>
                </div>
              )}
            </div>
          </div>
          {stateError && <p className="basis-full rounded-md bg-red-50 px-2 py-1 text-xs text-red-700">{stateError}</p>}
        </div>
        </div>
        <div className="rounded-b-2xl bg-white px-5 py-4">{kpis}</div>
      </section>

      <div role="tablist" aria-label="Company workspace" className="flex gap-1 overflow-x-auto overflow-y-hidden rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              role="tab"
              id={`tab-${t.key}`}
              aria-selected={tab === t.key}
              aria-controls={`panel-${t.key}`}
              onClick={() => selectTab(t.key)}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors focus-ring",
                tab === t.key ? "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
              {t.count !== undefined && t.count > 0 && (
                <span className={cn("rounded-full px-1.5 py-px text-[10px] font-semibold", tab === t.key ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-600")}>{t.count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* ---------------- OVERVIEW ---------------- */}
      {tab === "overview" && (
        <div id="panel-overview" role="tabpanel" aria-labelledby="tab-overview" className="space-y-4">
          {/* Two INDEPENDENT column stacks (not row pairs): every section keeps its own natural height, so a short card
              never inherits its neighbour's height. Columns are composed to carry roughly equal total height, and the
              long Officers list sits full width beneath them, so no column is left with a hole beside it. */}
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              {overview.identity}
              {overview.address}
              {overview.accounts}
            </div>
            <div className="space-y-4">
              {overview.status}
              {overview.industry}
              {overview.structure}
              {overview.provenance}
            </div>
          </div>

          <section className={sectionCard}>
            <PanelHeader title="Officers" icon={Users} count={currentOfficers.length} />
            <div className="border-b border-slate-100 px-4 py-2">{overview.officerSummary}</div>
            {currentOfficers.length > 0 ? (
              <ul className="grid max-h-[22rem] grid-cols-1 overflow-y-auto lg:grid-cols-2">
                {currentOfficers.map((o) => (
                  <li key={o.id} className="flex items-baseline justify-between gap-3 border-b border-slate-100 px-4 py-1.5">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-slate-900">{o.name}</p>
                      <p className="truncate text-[11px] capitalize text-slate-500">
                        {o.role.replace(/-/g, " ")}
                        {o.occupation ? ` · ${o.occupation}` : ""}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11px] tabular-nums text-slate-400">{o.appointedOn ? `Appointed ${formatDateOnly(o.appointedOn)}` : ""}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-5 text-[13px] text-slate-400">No current officers on file. Officer data is fetched from Companies House when available.</p>
            )}
            {formerOfficers.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowFormer((v) => !v)}
                  aria-expanded={showFormer}
                  className="flex w-full items-center justify-between px-4 py-2 text-left text-xs font-medium text-indigo-700 hover:bg-indigo-50/50"
                >
                  {showFormer ? "Hide" : "Show"} {formerOfficers.length} former officer{formerOfficers.length === 1 ? "" : "s"} (resigned)
                </button>
                {showFormer && (
                  <ul className="grid max-h-72 grid-cols-1 overflow-y-auto border-t border-slate-100 bg-slate-50/40 lg:grid-cols-2">
                    {formerOfficers.map((o) => (
                      <li key={o.id} className="flex items-baseline justify-between gap-3 border-b border-slate-100 px-4 py-1.5">
                        <div className="min-w-0">
                          <p className="truncate text-[13px] text-slate-700">{o.name}</p>
                          <p className="truncate text-[11px] capitalize text-slate-400">{o.role.replace(/-/g, " ")}</p>
                        </div>
                        <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
                          {o.appointedOn ? formatDateOnly(o.appointedOn) : "?"} – {formatDateOnly(o.resignedOn)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {/* ---------------- NOTES & COMMENTS ---------------- */}
      {tab === "notes" && (
        <div id="panel-notes" role="tabpanel" aria-labelledby="tab-notes" className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          <section className={sectionCard}>
            <PanelHeader title="Add a note" icon={Pencil} crm />
            <div className="space-y-2 p-4">
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") addNote();
                }}
                aria-label="Write a note or comment"
                placeholder="Add a note about this company…"
                rows={3}
                className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-[13px] leading-relaxed text-slate-900 placeholder:text-slate-400 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-slate-400"><kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-sans">Ctrl</kbd> + <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-sans">Enter</kbd> to add</span>
                <Button size="sm" onClick={addNote} disabled={savingNote || !noteText.trim()}>
                  Add note
                </Button>
              </div>
              {noteError && <p className="text-xs text-red-600">{noteError}</p>}
            </div>
          </section>

          <section className={sectionCard}>
            <PanelHeader title="Notes & comments" icon={StickyNote} count={notes.length} crm />
            {notes.length === 0 ? (
              <EmptyState crm icon={StickyNote} title="No notes yet" hint="Keep important observations, client requests and follow-up context here." />
            ) : (
              <ul className="px-4 py-1">
                {notes.map((n) => (
                  <li key={n.id} className="flex gap-3 border-b border-slate-100 px-1 py-3 transition-colors last:border-b-0 hover:bg-violet-50/30">
                    <Avatar
                      src={authorAvatarSrc}
                      initials={n.authorName.slice(0, 1).toUpperCase()}
                      className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-violet-100 text-[11px] font-semibold text-violet-700"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-xs font-semibold text-slate-900">{n.authorName}</span>
                        <span className="text-[11px] text-slate-400">{formatNoteTime(n.createdAt)}</span>
                      </div>
                      {editingId === n.id ? (
                        <div className="mt-1.5 space-y-2">
                          <textarea
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            aria-label="Edit note"
                            rows={3}
                            className="w-full resize-y rounded-md border border-slate-300 px-2.5 py-2 text-[13px] leading-relaxed outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                          />
                          <div className="flex gap-2">
                            <Button size="sm" onClick={() => saveEdit(n.id)} disabled={!editText.trim()}>
                              Save
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-slate-700">{n.body}</p>
                          <div className="mt-1.5 flex items-center gap-3 text-[11px]">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(n.id);
                                setEditText(n.body);
                                setConfirmDeleteId(null);
                              }}
                              aria-label="Edit note"
                              className="inline-flex items-center gap-1 font-medium text-slate-400 hover:text-indigo-700"
                            >
                              <Pencil className="h-3 w-3" /> Edit
                            </button>
                            {confirmDeleteId === n.id ? (
                              <span className="inline-flex items-center gap-1.5 text-slate-500">
                                Delete this note?
                                <button type="button" onClick={() => deleteNote(n.id)} className="rounded bg-red-600 px-1.5 py-0.5 font-semibold text-white">
                                  Yes
                                </button>
                                <button type="button" onClick={() => setConfirmDeleteId(null)} className="rounded border border-slate-300 px-1.5 py-0.5">
                                  No
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(n.id)}
                                aria-label="Delete note"
                                className="inline-flex items-center gap-1 font-medium text-slate-400 hover:text-red-600"
                              >
                                <Trash2 className="h-3 w-3" /> Delete
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {/* ---------------- CONTACTS ---------------- */}
      {tab === "contacts" && (
        <div id="panel-contacts" role="tabpanel" aria-labelledby="tab-contacts" className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className={cn("min-w-0", sectionCard)}>
            <PanelHeader title="Contacts" icon={Users} count={contacts.length} crm />
            <p className="border-b border-slate-100 bg-violet-50/40 px-4 py-2 text-[11px] text-slate-500">
              Companies House does not publish email addresses or phone numbers. Contacts here are people you add yourself.
            </p>
            {contacts.length === 0 ? (
              <EmptyState crm icon={Users} title="No contacts added yet" hint="Add the people you deal with at this company." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-[13px]">
                  <thead className="border-b border-slate-100 text-[10px] uppercase tracking-wider text-slate-400">
                    <tr>
                      <th className="px-4 py-2 font-semibold">Name</th>
                      <th className="px-2 py-2 font-semibold">Role</th>
                      <th className="px-2 py-2 font-semibold">Email</th>
                      <th className="px-2 py-2 font-semibold">Phone</th>
                      <th className="px-4 py-2 text-right font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {contacts.map((c) => (
                      <tr key={c.id} className={cn("hover:bg-slate-50/60", editingContactId === c.id && "bg-indigo-50/50")}>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2.5">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-100 text-[11px] font-semibold text-violet-700">
                              {c.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase()}
                            </span>
                            <div className="min-w-0">
                              <p className="font-semibold text-slate-900">{c.name}</p>
                              {c.occupation && <p className="text-[11px] text-slate-400">{c.occupation}</p>}
                            </div>
                          </div>
                        </td>
                        <td className="px-2 py-2.5">{c.role && c.role !== "contact" ? <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium capitalize text-violet-700">{c.role}</span> : <span className="text-slate-300">—</span>}</td>
                        <td className="px-2 py-2">
                          {c.email ? (
                            <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1 text-indigo-700 hover:underline">
                              <Mail className="h-3 w-3" /> {c.email}
                            </a>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2">
                          {c.phone ? (
                            <a href={`tel:${c.phone}`} className="inline-flex items-center gap-1 text-slate-700 hover:text-indigo-700">
                              <Phone className="h-3 w-3" /> {c.phone}
                            </a>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex items-center justify-end gap-1">
                            {confirmDeleteContactId === c.id ? (
                              <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
                                Delete?
                                <button type="button" onClick={() => deleteContact(c.id)} className="rounded bg-red-600 px-1.5 py-0.5 font-semibold text-white">
                                  Yes
                                </button>
                                <button type="button" onClick={() => setConfirmDeleteContactId(null)} className="rounded border border-slate-300 px-1.5 py-0.5">
                                  No
                                </button>
                              </span>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingContactId(c.id);
                                    setContact({ name: c.name, role: c.role === "contact" ? "" : c.role, email: c.email ?? "", phone: c.phone ?? "", occupation: c.occupation ?? "" });
                                    setContactError(null);
                                  }}
                                  aria-label={`Edit ${c.name}`}
                                  title="Edit contact"
                                  className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-indigo-700"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteContactId(c.id)}
                                  aria-label={`Delete ${c.name}`}
                                  title="Delete contact"
                                  className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={sectionCard}>
            <PanelHeader title={editingContactId ? "Edit contact" : "Add a contact"} icon={UserPlus} crm />
            <div className="space-y-2.5 bg-gradient-to-b from-violet-50/40 to-white p-4">
              <div>
                <label className={labelCls}>Full name</label>
                <input className={inputCls} aria-label="Contact name" placeholder="e.g. Jordan Ellis" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Role (optional)</label>
                <input className={inputCls} aria-label="Contact role" placeholder="e.g. Company Secretary" value={contact.role} onChange={(e) => setContact({ ...contact, role: e.target.value })} />
              </div>
              <div className="grid grid-cols-1 gap-2.5">
                <div>
                  <label className={labelCls}>Email</label>
                  <input className={inputCls} aria-label="Contact email" placeholder="Optional" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
                </div>
                <div>
                  <label className={labelCls}>Phone</label>
                  <input className={inputCls} aria-label="Contact phone" placeholder="Optional" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
                </div>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" onClick={saveContact} disabled={savingContact || !contact.name.trim()}>
                  {editingContactId ? <Check className="h-3.5 w-3.5" /> : <UserPlus className="h-3.5 w-3.5" />}
                  {editingContactId ? "Save changes" : "Add contact"}
                </Button>
                {editingContactId && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditingContactId(null);
                      setContact(emptyContact);
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </div>
              {contactError && <p className="text-xs text-red-600">{contactError}</p>}
            </div>
          </section>
        </div>
      )}

      {/* ---------------- FOLLOW-UPS ---------------- */}
      {tab === "followups" && (
        <div id="panel-followups" role="tabpanel" aria-labelledby="tab-followups" className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <section className={sectionCard}>
            <PanelHeader title="New follow-up" icon={CalendarPlus} crm />
            <div className="space-y-2.5 bg-gradient-to-b from-violet-50/40 to-white p-4">
              <div>
                <label className={labelCls}>Due date</label>
                <input type="date" aria-label="Follow-up due date" className={inputCls} value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} />
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {(
                    [
                      ["Tomorrow", 1],
                      ["In 1 week", 7],
                      ["In 1 month", 30],
                    ] as const
                  ).map(([label, days]) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => {
                        const d = new Date();
                        d.setDate(d.getDate() + days);
                        setFollowUpDate(d.toLocaleDateString("en-CA"));
                      }}
                      className="rounded-full border border-violet-200 bg-white px-2.5 py-0.5 text-[11px] font-medium text-violet-700 transition-colors hover:bg-violet-50 focus-ring"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className={labelCls}>Reminder note (optional)</label>
                <input className={inputCls} aria-label="Follow-up note" placeholder="What do you need to do?" value={followUpNote} onChange={(e) => setFollowUpNote(e.target.value)} />
              </div>
              <Button size="sm" onClick={addFollowUp} disabled={savingFollowUp || !followUpDate}>
                <Plus className="h-3.5 w-3.5" /> Schedule follow-up
              </Button>
              {followUpError && <p className="text-xs text-red-600">{followUpError}</p>}
              <p className="text-[11px] text-slate-400">Follow-ups are all-day and appear in your Calendar.</p>
            </div>
          </section>

          <section className={sectionCard}>
            <PanelHeader
              title="Follow-ups"
              icon={CalendarCheck}
              count={followUps.length}
              crm
              right={
                <Link href="/calendar" className="inline-flex items-center gap-1 rounded-md border border-violet-200 bg-white px-2 py-1 text-xs font-semibold text-violet-700 transition-colors hover:bg-violet-50 focus-ring">
                  <CalendarDays className="h-3.5 w-3.5" /> Open Calendar
                </Link>
              }
            />
            {followUps.length === 0 ? (
              <EmptyState crm icon={CalendarCheck} title="No follow-ups scheduled" hint="Schedule a reminder to chase this company; it will show in your Calendar." />
            ) : (
              <div>
                {(
                  [
                    { key: "overdue", title: "Overdue", items: overdueFollowUps, dot: "bg-red-500", row: "border-l-red-500 bg-red-50/30" },
                    { key: "scheduled", title: "Scheduled", items: scheduledFollowUps, dot: "bg-indigo-500", row: "border-l-indigo-400" },
                    { key: "done", title: "Completed", items: completedFollowUps, dot: "bg-emerald-500", row: "border-l-emerald-400" },
                  ] as const
                )
                  .filter((g) => g.items.length > 0)
                  .map((g) => (
                    <div key={g.key} className="border-b border-slate-100 last:border-b-0">
                      <p className={cn("flex items-center gap-1.5 px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider", g.key === "overdue" ? "bg-red-50 text-red-700" : g.key === "done" ? "bg-emerald-50/70 text-emerald-700" : "bg-slate-50/70 text-slate-500")}>
                        <span className={cn("h-1.5 w-1.5 rounded-full", g.dot)} /> {g.title} · {g.items.length}
                      </p>
                      <ul className="divide-y divide-slate-100">
                        {g.items.map((f) => (
                          <li key={f.id} className={cn("flex items-center gap-3 border-l-[3px] px-4 py-2", g.row)}>
                            <button
                              type="button"
                              onClick={() => markFollowUpDone(f.id, !f.done)}
                              aria-label={f.done ? "Mark as not done" : "Mark as done"}
                              title={f.done ? "Mark as not done" : "Mark as done"}
                              className={f.done ? "text-emerald-500" : "text-slate-300 hover:text-emerald-500"}
                            >
                              {f.done ? <CheckCircle2 className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
                            </button>
                            <div className="min-w-0 flex-1">
                              <p className={cn("truncate text-[13px] font-medium", f.done ? "text-slate-400 line-through" : "text-slate-900")}>{f.note || "Follow-up"}</p>
                              <p className="text-[11px] text-slate-500">{formatDateOnly(f.dueDate)} · All day</p>
                            </div>
                            <Badge tone={f.done ? "green" : g.key === "overdue" ? "red" : "indigo"}>{relativeDue(f.done, f.dueDate)}</Badge>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* ---------------- ACTIVITY ---------------- */}
      {tab === "activity" && (
        <div id="panel-activity" role="tabpanel" aria-labelledby="tab-activity" className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
          <section className={sectionCard}>
            <PanelHeader
              title="Activity"
              icon={History}
              count={activity.length}
              crm
              right={
                activity.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setActivityError(null);
                      setActivityConfirm("all");
                    }}
                    className="rounded-md border border-violet-200 bg-white px-2 py-1 text-xs font-semibold text-violet-700 transition-colors hover:bg-violet-50 focus-ring"
                  >
                    Clear all activities
                  </button>
                ) : undefined
              }
            />
            {activityConfirm !== null && (
              <div role="alertdialog" aria-label="Confirm activity deletion" className="border-b border-red-100 bg-red-50 px-4 py-2.5 text-xs text-red-800">
                <p className="font-medium">
                  {activityConfirm === "all"
                    ? `Remove ${activity.length >= 50 ? "all (50 or more)" : `all ${activity.length}`} activity entr${activity.length === 1 ? "y" : "ies"} for this company? Your notes, contacts, follow-ups and company status are not changed.`
                    : "Remove this activity entry? The action itself is not undone."}
                </p>
                {activityError && <p className="mt-1 font-semibold">{activityError}</p>}
                <div className="mt-1.5 flex gap-2">
                  <button type="button" disabled={activityBusy} onClick={() => deleteActivity(activityConfirm)} className="rounded-md bg-red-600 px-2 py-1 font-semibold text-white hover:bg-red-700 disabled:opacity-60">
                    {activityBusy ? "Removing…" : "Remove"}
                  </button>
                  <button type="button" disabled={activityBusy} onClick={() => setActivityConfirm(null)} className="rounded-md border border-red-200 bg-white px-2 py-1 font-semibold text-red-700 hover:bg-red-100">
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {activity.length === 0 ? (
              <EmptyState crm icon={History} title="No activity yet" hint="Saving, flagging, adding notes or contacts and scheduling follow-ups will appear here." />
            ) : (
              <ol className="px-5 py-4">
                {activity.map((a, i) => {
                  const Icon = { saved: Bookmark, flag: Flag, follow: Star, trash: Trash2, note: StickyNote, contact: UserPlus, followup: CalendarPlus, done: CheckCircle2 }[a.kind];
                  const tone = {
                    saved: "bg-indigo-100 text-indigo-600",
                    flag: "bg-red-100 text-red-600",
                    follow: "bg-amber-100 text-amber-600",
                    trash: "bg-slate-100 text-slate-500",
                    note: "bg-sky-100 text-sky-600",
                    contact: "bg-violet-100 text-violet-600",
                    followup: "bg-indigo-100 text-indigo-600",
                    done: "bg-emerald-100 text-emerald-600",
                  }[a.kind];
                  return (
                    <li key={a.id} className="relative flex gap-3.5 pb-4 last:pb-0">
                      {i < activity.length - 1 && <span className="absolute -bottom-0 left-[13px] top-7 w-px bg-violet-100" aria-hidden />}
                      <span className={cn("relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-2 ring-white", tone)}>
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <div className="min-w-0 flex-1 pt-px">
                        <p className="text-[13px] font-medium text-slate-800">{a.text}</p>
                        <p className="text-[11px] text-slate-400">{formatNoteTime(a.createdAt)}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setActivityError(null);
                          setActivityConfirm(a.id);
                        }}
                        aria-label={`Delete activity: ${a.text}`}
                        title="Delete this entry"
                        className="relative z-10 h-fit shrink-0 rounded p-1 text-slate-300 hover:text-red-600 focus-ring"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
            <p className="border-t border-slate-100 bg-slate-50/60 px-4 py-2 text-[11px] text-slate-400">Recorded from now on; actions taken before activity tracking was added are not listed.</p>
          </section>

          <section className={sectionCard}>
            <PanelHeader title="CRM snapshot" icon={ClipboardList} crm />
            <dl className="divide-y divide-slate-100 text-[13px]">
              {(
                [
                  ["Saved", saved],
                  ["Red flagged", redFlagged],
                  ["Followed", followed],
                  ["In trash", trashed],
                ] as const
              ).map(([label, on]) => (
                <div key={label} className="flex items-center justify-between px-4 py-1.5">
                  <dt className="text-slate-500">{label}</dt>
                  <dd className={cn("font-medium", on ? "text-indigo-700" : "text-slate-400")}>{on ? "Yes" : "No"}</dd>
                </div>
              ))}
              <div className="flex items-center justify-between px-4 py-2">
                <dt className="text-slate-500">Notes</dt>
                <dd className="font-medium text-slate-900">{notes.length}</dd>
              </div>
              <div className="flex items-center justify-between px-4 py-2">
                <dt className="text-slate-500">Contacts</dt>
                <dd className="font-medium text-slate-900">{contacts.length}</dd>
              </div>
              <div className="flex items-center justify-between px-4 py-2">
                <dt className="text-slate-500">Open follow-ups</dt>
                <dd className="font-medium text-slate-900">
                  {openFollowUps}
                  {overdueFollowUps.length > 0 && <span className="ml-1.5 text-xs font-semibold text-red-600">{overdueFollowUps.length} overdue</span>}
                </dd>
              </div>
            </dl>
          </section>
        </div>
      )}
      <span className="sr-only">Workspace for {companyName}</span>
    </div>
  );
}
