"use client";

import { useState } from "react";
import Link from "next/link";
import { Search, ListChecks, Users, Tag, FileSpreadsheet, RefreshCw, Star, ArrowRight, CheckCircle2, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: { id: T; label: string; icon: React.ComponentType<{ className?: string }> }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="mx-auto inline-flex flex-wrap justify-center gap-1 rounded-full border border-slate-200 bg-white p-1.5 shadow-sm">
      {items.map(({ id, label: l, icon: Icon }) => (
        <button
          key={id}
          role="tab"
          aria-selected={value === id}
          onClick={() => onChange(id)}
          className={cn(
            "inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-colors",
            value === id ? "bg-indigo-900 text-white" : "text-indigo-900 hover:bg-slate-100"
          )}
        >
          <Icon className="h-4 w-4" />
          {l}
        </button>
      ))}
    </div>
  );
}

const SEARCH_TABS = [
  { id: "company", label: "Company search", icon: Search, hint: "Search UK companies by name, company number or postcode", fields: ["Company name", "Company number", "Postcode", "Status", "Company type"] },
  { id: "filings", label: "Filings", icon: ListChecks, hint: "Find companies by filing position", fields: ["DS01 strike-off filed", "Late accounts", "Late confirmation statement", "Accounts next due", "Dormant"] },
  { id: "directors", label: "Directors", icon: Users, hint: "Filter by confirmed director data from Companies House", fields: ["Director count", "Single director", "Officer coverage state"] },
  { id: "sic", label: "SIC code", icon: Tag, hint: "Filter by UK SIC code, then combine with location and age", fields: ["SIC code", "Town / city", "County", "Postcode prefix", "Company age"] },
] as const;

// Visual search/exploration block. The box is a doorway to the real search (sign-in), not a fake live query.
export function SearchShowcase() {
  const [tab, setTab] = useState<(typeof SEARCH_TABS)[number]["id"]>("company");
  const current = SEARCH_TABS.find((t) => t.id === tab)!;
  return (
    <div>
      <Segmented items={SEARCH_TABS.map(({ id, label, icon }) => ({ id, label, icon }))} value={tab} onChange={setTab} label="What to search" />
      <div className="mx-auto mt-6 max-w-4xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg shadow-slate-200/60">
        <Link href="/login?next=/companies" className="flex items-center gap-3 px-6 py-5 text-lg text-slate-400 hover:bg-slate-50">
          <Search className="h-5 w-5" />
          <span className="flex-1 truncate">{current.hint}</span>
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-indigo-600 text-white">
            <ArrowRight className="h-5 w-5" />
          </span>
        </Link>
        <div className="grid gap-2 border-t border-slate-100 p-3 sm:grid-cols-2">
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3 text-sm font-medium text-indigo-900">
            United Kingdom <ChevronDown className="h-4 w-4 text-slate-400" />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3 text-sm font-medium text-indigo-900">
            All company types <ChevronDown className="h-4 w-4 text-slate-400" />
          </div>
        </div>
        <div className="border-t border-slate-100 px-6 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Fields you can use</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {current.fields.map((f) => (
              <span key={f} className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700">
                {f}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const WORKFLOW_TABS = [
  {
    id: "lists",
    label: "Lead lists",
    icon: ListChecks,
    badge: "Lead lists",
    title: "Build a target list in minutes",
    text: "Combine status, age, location, SIC, director and filing filters with AND / OR logic, review the results, then export the list as CSV.",
    bullets: ["Nested AND / OR groups", "Server-side search over the whole register", "CSV export that respects your filters", "Preview before you save"],
  },
  {
    id: "reports",
    label: "Saved reports",
    icon: FileSpreadsheet,
    badge: "Saved reports",
    title: "Reports that keep themselves current",
    text: "Save any search as a report. With daily refresh on, the automatic daily update recounts it, so the list stays current without you re-running it.",
    bullets: ["Daily refresh with a visible last-update time", "Edit existing reports in place", "Criteria summary on every report", "Open, edit or export in one click"],
  },
  {
    id: "crm",
    label: "CRM",
    icon: Star,
    badge: "CRM",
    title: "Follow up where you found the company",
    text: "Follow, save or red-flag a company from the results table, add notes and contacts, and schedule follow-ups that land on a compact calendar.",
    bullets: ["Watches, Saved, Red flags and Trash", "Notes and manual contacts, kept apart from Companies House directors", "Follow-ups with overdue / upcoming / done", "Recently viewed companies"],
  },
] as const;

// Which step of the flow each tab is about (0-based).
const ACTIVE_STEP = { lists: 1, reports: 3, crm: 4 } as const;

export function WorkflowShowcase() {
  const [tab, setTab] = useState<(typeof WORKFLOW_TABS)[number]["id"]>("lists");
  const t = WORKFLOW_TABS.find((x) => x.id === tab)!;
  return (
    <div>
      <Segmented items={WORKFLOW_TABS.map(({ id, label, icon }) => ({ id, label, icon }))} value={tab} onChange={setTab} label="Workflow" />
      <div className="mt-12 grid items-center gap-12 lg:grid-cols-2">
        <div>
          <span className="inline-block rounded-full border border-indigo-100 bg-indigo-50 px-3.5 py-1 text-sm font-medium text-indigo-700">{t.badge}</span>
          <h3 className="mt-5 text-4xl font-bold tracking-tight text-indigo-900">{t.title}</h3>
          <p className="mt-4 text-lg leading-relaxed text-slate-600">{t.text}</p>
          <ul className="mt-6 space-y-3">
            {t.bullets.map((b) => (
              <li key={b} className="flex items-start gap-3 text-[15px] text-indigo-900">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-indigo-600" />
                {b}
              </li>
            ))}
          </ul>
          <Link href="/login" className="mt-8 inline-flex items-center gap-2 rounded-md bg-indigo-600 px-6 py-3.5 text-base font-semibold text-white hover:bg-indigo-700">
            Sign in to try it <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-lg shadow-slate-200/60">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">How it fits together</p>
          <ol className="mt-4 space-y-3">
            {["Search UK companies", "Filter with AND / OR", "Save as report", "Daily refresh", "Follow, note, schedule"].map((s, i) => (
              <li key={s} className={cn("flex items-center gap-3 rounded-lg border px-4 py-3 text-sm font-semibold", i === ACTIVE_STEP[tab] ? "border-indigo-200 bg-indigo-50 text-indigo-900" : "border-slate-200 text-slate-700")}>
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-900 text-xs text-white">{i + 1}</span>
                {s}
                {i === 3 && <RefreshCw className="ml-auto h-4 w-4 text-slate-400" />}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
