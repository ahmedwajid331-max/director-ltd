"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Circle } from "lucide-react";
import { formatDateOnly } from "@/lib/data/format";
import { EmptyState } from "@/components/ui/EmptyState";
import { CalendarDays } from "lucide-react";

interface FollowUpVM {
  id: string;
  dueDate: string;
  note: string | null;
  done: boolean;
  companyId: string;
  companyName: string;
}

function isOverdue(dueDate: string, done: boolean) {
  return !done && new Date(dueDate) < new Date(new Date().toDateString());
}

export function CalendarClient() {
  const [followUps, setFollowUps] = useState<FollowUpVM[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/followups");
      const data = await res.json();
      setFollowUps(data.followUps ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount
    load();
  }, []);

  async function toggleDone(id: string, done: boolean) {
    setFollowUps((prev) => prev.map((f) => (f.id === id ? { ...f, done } : f)));
    await fetch(`/api/followups/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done }),
    });
  }

  if (loading) return <p className="text-sm text-slate-400">Loading follow-ups…</p>;

  if (followUps.length === 0) {
    return (
      <EmptyState
        icon={CalendarDays}
        title="No follow-ups scheduled"
        description="Schedule a follow-up from any company's page to see it here."
      />
    );
  }

  const upcoming = followUps.filter((f) => !f.done);
  const done = followUps.filter((f) => f.done);

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-900">Upcoming ({upcoming.length})</h3>
        </div>
        <ul className="divide-y divide-slate-100">
          {upcoming.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="flex items-start gap-3">
                <button onClick={() => toggleDone(f.id, true)} className="mt-0.5 text-slate-300 hover:text-emerald-500">
                  <Circle className="h-4 w-4" />
                </button>
                <div>
                  <Link href={`/companies/${f.companyId}`} className="text-sm font-medium text-slate-900 hover:text-indigo-600">
                    {f.companyName}
                  </Link>
                  {f.note && <p className="text-xs text-slate-500">{f.note}</p>}
                </div>
              </div>
              <span className={`text-xs font-medium ${isOverdue(f.dueDate, f.done) ? "text-red-600" : "text-slate-500"}`}>
                {formatDateOnly(f.dueDate)}
                {isOverdue(f.dueDate, f.done) && " · overdue"}
              </span>
            </li>
          ))}
          {upcoming.length === 0 && <li className="px-5 py-4 text-sm text-slate-400">All caught up.</li>}
        </ul>
      </section>

      {done.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-5 py-3">
            <h3 className="text-sm font-semibold text-slate-900">Completed ({done.length})</h3>
          </div>
          <ul className="divide-y divide-slate-100">
            {done.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="flex items-start gap-3">
                  <button onClick={() => toggleDone(f.id, false)} className="mt-0.5 text-emerald-500">
                    <CheckCircle2 className="h-4 w-4" />
                  </button>
                  <div>
                    <Link
                      href={`/companies/${f.companyId}`}
                      className="text-sm font-medium text-slate-400 line-through hover:text-indigo-600"
                    >
                      {f.companyName}
                    </Link>
                  </div>
                </div>
                <span className="text-xs text-slate-400">{formatDateOnly(f.dueDate)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
