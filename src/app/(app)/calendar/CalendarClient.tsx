"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Circle, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { formatDateOnly } from "@/lib/data/format";
import { cn } from "@/lib/cn";
import { calendarStatus } from "@/lib/calendar/status";

interface FollowUpVM {
  id: string;
  dueDate: string;
  note: string | null;
  done: boolean;
  companyId: string;
  companyName: string;
  // Set for assigned work (shown beside follow-ups): it can be completed here but not reopened or deleted.
  kind?: "assignment";
  assignedBy?: string;
}

type View = "month" | "week" | "day";
type Status = "done" | "overdue" | "upcoming";

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

// Follow-ups are date-only, so everything keys off "YYYY-MM-DD" (no timezone drift).
function keyOf(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d: Date, n: number) {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}
function startOfWeek(d: Date) {
  return addDays(d, -((d.getDay() + 6) % 7)); // Monday
}
function statusOf(f: FollowUpVM, todayKey: string): Status {
  return calendarStatus(f, todayKey);
}
const isAssignment = (f: FollowUpVM) => f.kind === "assignment";
// "YYYY-MM-DD" -> a local Date for that calendar day (the grid works in local dates; the day itself comes from the server).
function dateFromKey(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const STATUS_LABEL: Record<Status, string> = { done: "Done", overdue: "Overdue", upcoming: "Scheduled" };
const STATUS_CHIP: Record<Status, string> = {
  done: "bg-emerald-50 text-emerald-700 border-emerald-200",
  overdue: "bg-red-50 text-red-700 border-red-200",
  upcoming: "bg-indigo-50 text-indigo-700 border-indigo-200",
};
const STATUS_DOT: Record<Status, string> = { done: "bg-emerald-500", overdue: "bg-red-500", upcoming: "bg-indigo-500" };

// `todayKey` is today in the application time zone, from the server: the same "today" the hero counts and My work use.
export function CalendarClient({ todayKey }: { todayKey: string }) {
  const router = useRouter();
  // Which completed-follow-up deletion is awaiting confirmation: one item id, "all", or nothing.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [followUps, setFollowUps] = useState<FollowUpVM[]>([]);
  const [loading, setLoading] = useState(true);
  // Collapsed on arrival. The calendar below stays mounted while collapsed, so date / month / view / data are never reset.
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("month");
  // `selected` is the chosen date (header + agenda); `cursor` is the month the grid is showing.
  const [selected, setSelected] = useState(() => dateFromKey(todayKey));
  const [cursor, setCursor] = useState(() => dateFromKey(todayKey));
  const selectedKey = keyOf(selected);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/followups");
        const data = await res.json();
        if (!cancelled) setFollowUps([...(data.followUps ?? []), ...(data.assignments ?? []).map((a: FollowUpVM) => ({ ...a, kind: "assignment" as const }))]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleDone(id: string, done: boolean) {
    const item = followUps.find((f) => f.id === id);
    // Assigned work can only be completed (the assignment API has no "reopen"); a completed one stays completed.
    if (item && isAssignment(item) && !done) return;
    setFollowUps((prev) => prev.map((f) => (f.id === id ? { ...f, done } : f)));
    const res = await (item && isAssignment(item)
      ? fetch(`/api/assignments/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "complete" }) })
      : fetch(`/api/followups/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done }) })
    ).catch(() => null);
    if (!res || !res.ok) setFollowUps((prev) => prev.map((f) => (f.id === id ? { ...f, done: !done } : f)));
  }

  // target is a follow-up id, or "all" to clear every completed one. The server only ever deletes completed items.
  async function deleteCompleted(target: string) {
    setDeleting(true);
    setDeleteError(null);
    const res = await fetch(target === "all" ? "/api/followups" : `/api/followups/${target}`, { method: "DELETE" }).catch(() => null);
    setDeleting(false);
    if (!res || !res.ok) {
      setDeleteError("Could not delete. Nothing was removed.");
      return;
    }
    setFollowUps((prev) => prev.filter((f) => !(!isAssignment(f) && f.done && (target === "all" || f.id === target))));
    setConfirming(null);
    router.refresh(); // keeps the Overdue / Upcoming chips in the hero current
  }

  const byDay = useMemo(() => {
    const map = new Map<string, FollowUpVM[]>();
    for (const f of followUps) {
      const k = f.dueDate.slice(0, 10);
      map.set(k, [...(map.get(k) ?? []), f]);
    }
    return map;
  }, [followUps]);

  function go(delta: number) {
    if (view === "month") {
      setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1));
      return;
    }
    const next = addDays(selected, delta * (view === "week" ? 7 : 1));
    setSelected(next);
    setCursor(next);
  }

  function pick(d: Date) {
    setSelected(d);
    if (d.getMonth() !== cursor.getMonth() || d.getFullYear() !== cursor.getFullYear()) setCursor(d);
  }

  function goToday() {
    const n = dateFromKey(todayKey);
    setSelected(n);
    setCursor(n);
  }

  const title =
    view === "month"
      ? cursor.toLocaleDateString("en-GB", { month: "long", year: "numeric" })
      : view === "week"
        ? (() => {
            const s = startOfWeek(selected);
            const e = addDays(s, 6);
            return `${s.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${e.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
          })()
        : selected.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  const monthCells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = startOfWeek(first);
    const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const weeks = Math.ceil(((last.getTime() - start.getTime()) / 86_400_000 + 1) / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
  }, [cursor]);

  const completedFollowUps = followUps.filter((f) => f.done && !isAssignment(f)).length;
  const groups = [
    { key: "overdue" as const, title: "Overdue", items: followUps.filter((f) => statusOf(f, todayKey) === "overdue"), empty: "Nothing overdue." },
    { key: "upcoming" as const, title: "Upcoming", items: followUps.filter((f) => statusOf(f, todayKey) === "upcoming"), empty: "Nothing upcoming." },
    { key: "done" as const, title: "Completed", items: followUps.filter((f) => f.done), empty: "None completed yet." },
  ];

  const selectedItems = byDay.get(selectedKey) ?? [];
  const selectedOverdue = selectedItems.filter((f) => statusOf(f, todayKey) === "overdue").length;

  function renderDayCell(d: Date, inMonth: boolean) {
    const k = keyOf(d);
    const items = byDay.get(k) ?? [];
    const isSelected = k === selectedKey;
    const isToday = k === todayKey;
    // One dot per status present (overdue first), "+n" when a day is busy, so a cell never grows.
    const present = (["overdue", "upcoming", "done"] as const).filter((st) => items.some((f) => statusOf(f, todayKey) === st));
    return (
      <button
        key={k}
        onClick={() => pick(d)}
        aria-label={`${d.toDateString()}${items.length ? `, ${items.length} item${items.length === 1 ? "" : "s"}` : ""}`}
        aria-pressed={isSelected}
        className="group flex h-9 flex-col items-center justify-center"
      >
        <span
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-full text-[13px] tabular-nums transition-colors",
            isSelected
              ? "bg-indigo-600 font-semibold text-white shadow-sm"
              : isToday
                ? "font-bold text-indigo-700 ring-2 ring-indigo-600"
                : inMonth
                  ? "font-medium text-slate-800 group-hover:bg-slate-100"
                  : "text-slate-300 group-hover:bg-slate-50"
          )}
        >
          {d.getDate()}
        </span>
        <span className="-mt-0.5 flex h-1.5 items-center gap-0.5">
          {present.map((st) => (
            <span key={st} className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[st], !inMonth && "opacity-40")} />
          ))}
          {items.length > 3 && <span className="ml-0.5 text-[9px] font-semibold leading-none text-slate-500">+{items.length - 3}</span>}
        </span>
      </button>
    );
  }

  function renderDayList(d: Date) {
    const items = byDay.get(keyOf(d)) ?? [];
    if (items.length === 0) return <p className="px-4 py-2.5 text-xs text-slate-400">Nothing scheduled on this day.</p>;
    return (
      <ul className="max-h-32 divide-y divide-slate-100 overflow-y-auto">
        {items.map((f) => {
          const st = statusOf(f, todayKey);
          return (
            <li key={f.id} className="flex items-center gap-2.5 px-4 py-1.5">
              <button
                onClick={() => toggleDone(f.id, !f.done)}
                disabled={isAssignment(f) && f.done}
                aria-label={isAssignment(f) && f.done ? "Completed" : f.done ? "Mark as not done" : "Mark as done"}
                className={f.done ? "text-emerald-500 disabled:cursor-default" : "text-slate-300 hover:text-emerald-500"}
              >
                {f.done ? <CheckCircle2 className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
              </button>
              <div className="min-w-0 flex-1">
                <Link href={`/companies/${f.companyId}`} className="block truncate text-sm font-semibold text-indigo-700 hover:underline">
                  {f.companyName}
                </Link>
                <p className="truncate text-xs text-slate-500">
                  {isAssignment(f) ? `Assigned work${f.assignedBy ? ` from ${f.assignedBy}` : ""}` : "Follow-up"} · All day{f.note ? ` · ${f.note}` : ""}
                </p>
              </div>
              <span className={cn("rounded-full border px-1.5 py-px text-[10px] font-semibold", STATUS_CHIP[st])}>{STATUS_LABEL[st]}</span>
            </li>
          );
        })}
      </ul>
    );
  }

  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(selected), i));
  const navBtn = "flex h-8 w-8 items-center justify-center rounded-full text-slate-600 hover:bg-slate-100";

  return (
    <div className="w-full max-w-[770px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="calendar-workspace"
        className="flex w-full items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-left shadow-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 focus-ring"
      >
        <span className="flex items-center gap-2.5 text-sm font-semibold text-slate-900">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-600 text-white">
            <CalendarDays className="h-4 w-4" />
          </span>
          Calendar
        </span>
        <ChevronDown className={cn("h-4 w-4 text-slate-500 transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")} />
      </button>

      <div
        id="calendar-workspace"
        className={cn("grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}
      >
        <div className="-mx-2 min-h-0 overflow-hidden px-2" inert={!open}>
          <div className="pb-3 pt-3">
            {loading ? (
              <p className="text-sm text-slate-400">Loading calendar…</p>
            ) : (
    <div className="mx-auto grid items-start gap-4 md:grid-cols-[340px_minmax(0,1fr)]">
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-md">
        <div className="flex items-center justify-between gap-3 bg-gradient-to-br from-indigo-600 to-indigo-700 px-4 py-2.5 text-white">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">
              {selected.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
            </p>
            <p className="truncate text-[11px] text-indigo-100">
              {selectedItems.length === 0
                ? "No follow-ups"
                : `${selectedItems.length} follow-up${selectedItems.length === 1 ? "" : "s"}${selectedOverdue ? `, ${selectedOverdue} overdue` : ""}`}
            </p>
          </div>
          <div className="inline-flex shrink-0 overflow-hidden rounded-md bg-white/15" role="group" aria-label="Calendar view">
            {(["month", "week", "day"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={cn("px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide", view === v ? "bg-white text-indigo-700" : "text-indigo-50 hover:bg-white/10")}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between px-3 py-1.5">
          <button onClick={() => go(-1)} aria-label={`Previous ${view}`} className={navBtn}>
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
            <button onClick={goToday} className="rounded-full border border-slate-300 px-2 py-0.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">
              Today
            </button>
          </div>
          <button onClick={() => go(1)} aria-label={`Next ${view}`} className={navBtn}>
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        {view !== "day" && (
          <div className="px-3 pb-1.5 pt-0.5">
            <div className="grid grid-cols-7 text-center text-[11px] font-semibold text-slate-500">
              {WEEKDAYS.map((w) => (
                <div key={w} className="py-1">
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {view === "month" ? monthCells.map((d) => renderDayCell(d, d.getMonth() === cursor.getMonth())) : weekDays.map((d) => renderDayCell(d, true))}
            </div>
          </div>
        )}

        {/* Month / Week: the right-hand Overdue / Upcoming / Completed panels carry the follow-ups. Day view has no grid, so it keeps its one day list. */}
        {view === "day" && <div className="border-t border-slate-200">{renderDayList(selected)}</div>}
      </section>

      <aside className="space-y-3">
        {followUps.length === 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-500 shadow-sm">
            <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
            <p>
              <span className="font-semibold text-slate-700">Nothing scheduled.</span> Schedule a follow-up from any company&apos;s page, or wait for assigned work with a due date, and it will appear here.
            </p>
          </div>
        )}
        {groups.map(({ key, title: t, items, empty }) => {
          const open = key !== "done";
          return (
            <section key={key} className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-3 py-1.5">
                <h3 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-700">
                  <span className={cn("h-2 w-2 rounded-full", STATUS_DOT[key])} />
                  {t}
                </h3>
                <span className="flex items-center gap-2">
                  {key === "done" && completedFollowUps > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setDeleteError(null);
                        setConfirming("all");
                      }}
                      className="text-[11px] font-semibold text-slate-500 hover:text-red-600 focus-ring"
                    >
                      Clear completed
                    </button>
                  )}
                  <span className="text-xs font-semibold tabular-nums text-slate-600">{items.length}</span>
                </span>
              </div>
              {key === "done" && confirming !== null && (
                <div role="alertdialog" aria-label="Confirm deletion" className="border-b border-red-100 bg-red-50 px-3 py-2 text-xs text-red-800">
                  <p className="font-medium">
                    {confirming === "all"
                      ? `Delete all ${completedFollowUps} completed follow-up${completedFollowUps === 1 ? "" : "s"}? Pending follow-ups and assigned work are not affected.`
                      : "Delete this completed follow-up?"}
                  </p>
                  {deleteError && <p className="mt-1 font-semibold">{deleteError}</p>}
                  <div className="mt-1.5 flex gap-2">
                    <button type="button" disabled={deleting} onClick={() => deleteCompleted(confirming)} className="rounded-md bg-red-600 px-2 py-1 font-semibold text-white hover:bg-red-700 disabled:opacity-60">
                      {deleting ? "Deleting…" : "Delete"}
                    </button>
                    <button type="button" disabled={deleting} onClick={() => setConfirming(null)} className="rounded-md border border-red-200 bg-white px-2 py-1 font-semibold text-red-700 hover:bg-red-100">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {items.length === 0 ? (
                <p className="px-3 py-1.5 text-xs text-slate-400">{empty}</p>
              ) : (
                <ul className="max-h-44 divide-y divide-slate-100 overflow-y-auto">
                  {items.map((f) => (
                    <li key={f.id} className="flex items-center gap-2 px-3 py-1.5">
                      <button
                        onClick={() => toggleDone(f.id, open)}
                        disabled={isAssignment(f) && !open}
                        aria-label={isAssignment(f) && !open ? "Completed" : open ? "Mark as done" : "Mark as not done"}
                        className={open ? "text-slate-300 hover:text-emerald-500" : "text-emerald-500 disabled:cursor-default"}
                      >
                        {open ? <Circle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      </button>
                      <Link
                        href={`/companies/${f.companyId}`}
                        title={`${isAssignment(f) ? `Assigned work${f.assignedBy ? ` from ${f.assignedBy}` : ""}: ` : ""}${f.companyName}${f.note ? ` — ${f.note}` : ""}`}
                        className={cn("min-w-0 flex-1 truncate text-xs font-medium hover:text-indigo-700", open ? "text-slate-800" : "text-slate-400 line-through")}
                      >
                        {f.companyName}
                      </Link>
                      {isAssignment(f) && <span className="shrink-0 rounded border border-emerald-200 bg-emerald-50 px-1 text-[10px] font-semibold text-emerald-700">Assigned</span>}
                      <span className="shrink-0 text-[11px] tabular-nums text-slate-500">{formatDateOnly(f.dueDate)}</span>
                      {key === "done" && !isAssignment(f) && (
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteError(null);
                            setConfirming(f.id);
                          }}
                          aria-label={`Delete completed follow-up for ${f.companyName}`}
                          title="Delete"
                          className="shrink-0 text-slate-300 hover:text-red-600 focus-ring"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </aside>
    </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
