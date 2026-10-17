"use client";

import { cn } from "@/lib/cn";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

// Company-name directory index. Selecting a letter is a real server-side filter
// (names beginning with that letter) - nothing is loaded into the browser.
export function AlphabetBar({ value, onChange }: { value: string | null; onChange: (letter: string | null) => void }) {
  const base = "h-6 min-w-6 rounded px-1.5 text-xs font-semibold transition-colors focus-ring";
  return (
    <nav aria-label="Browse companies by first letter" className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Company name</span>
      <div className="flex flex-wrap items-center gap-0.5">
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-pressed={value === null}
          className={cn(base, "px-2", value === null ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-200")}
        >
          ALL
        </button>
        <span className="mx-1 h-4 w-px bg-slate-300" aria-hidden />
        {LETTERS.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => onChange(value === l ? null : l)}
            aria-pressed={value === l}
            title={`Company names starting with ${l}`}
            className={cn(base, value === l ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-indigo-100 hover:text-indigo-800")}
          >
            {l}
          </button>
        ))}
      </div>
    </nav>
  );
}
