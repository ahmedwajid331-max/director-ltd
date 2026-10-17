import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

// Presentation-only building blocks shared by the Users, Super Admin and Settings pages.
// They reuse the Dashboard hero's palette (indigo-950 -> indigo-700, 36px grid) and accent tones.

export type Tone = "indigo" | "emerald" | "amber" | "violet" | "slate" | "red" | "blue";

const CHIP: Record<Tone, string> = {
  indigo: "bg-indigo-600 text-white",
  blue: "bg-blue-600 text-white",
  emerald: "bg-emerald-600 text-white",
  amber: "bg-amber-500 text-white",
  violet: "bg-violet-600 text-white",
  slate: "bg-slate-600 text-white",
  red: "bg-red-600 text-white",
};
const SOFT: Record<Tone, string> = {
  indigo: "bg-indigo-50 text-indigo-700",
  blue: "bg-blue-50 text-blue-700",
  emerald: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  violet: "bg-violet-50 text-violet-700",
  slate: "bg-slate-100 text-slate-600",
  red: "bg-red-50 text-red-700",
};
const TINT: Record<Tone, string> = {
  indigo: "from-indigo-50/80",
  blue: "from-blue-50/80",
  emerald: "from-emerald-50/80",
  amber: "from-amber-50/80",
  violet: "from-violet-50/80",
  slate: "from-slate-100/80",
  red: "from-red-50/80",
};
const EDGE: Record<Tone, string> = {
  indigo: "border-indigo-200/70",
  blue: "border-blue-200/70",
  emerald: "border-emerald-200/70",
  amber: "border-amber-200/70",
  violet: "border-violet-200/70",
  slate: "border-slate-200",
  red: "border-red-200/70",
};
const MARK: Record<Tone, string> = {
  indigo: "text-indigo-200/60",
  blue: "text-blue-200/60",
  emerald: "text-emerald-200/60",
  amber: "text-amber-200/70",
  violet: "text-violet-200/60",
  slate: "text-slate-200",
  red: "text-red-200/60",
};

const ACCENT_PILL: Record<Tone, string> = {
  indigo: "bg-white/10 ring-white/15",
  blue: "bg-blue-400/25 ring-blue-300/30",
  emerald: "bg-emerald-400/20 ring-emerald-300/30",
  amber: "bg-amber-400/20 ring-amber-300/30",
  violet: "bg-violet-400/25 ring-violet-300/30",
  slate: "bg-white/10 ring-white/15",
  red: "bg-red-400/20 ring-red-300/30",
};

export function PageHero({
  icon: Icon,
  eyebrow,
  title,
  description,
  aside,
  accent,
  compact,
  children,
}: {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  description: string;
  aside?: React.ReactNode;
  accent?: Tone;
  compact?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <header
      className={cn("relative overflow-hidden rounded-2xl px-6 text-white shadow-lg shadow-indigo-950/20 sm:px-8", compact ? "py-5" : "py-7")}
      style={{
        backgroundImage:
          "linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(135deg, var(--color-indigo-950), var(--color-indigo-900) 55%, var(--color-indigo-700))",
        backgroundSize: "36px 36px, 36px 36px, auto",
      }}
    >
      <svg aria-hidden className="pointer-events-none absolute -right-12 -top-20 hidden h-80 w-80 text-white/10 md:block" viewBox="0 0 400 400" fill="none" stroke="currentColor" strokeWidth="1.2">
        <circle cx="200" cy="200" r="190" />
        <circle cx="200" cy="200" r="130" />
        <circle cx="200" cy="200" r="70" />
        <path d="M200 10v380M10 200h380" strokeOpacity=".5" />
      </svg>
      <div className="relative flex flex-wrap items-center justify-between gap-5">
        <div className="min-w-0">
          <span className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold text-indigo-100 ring-1", accent ? ACCENT_PILL[accent] : "bg-white/10 ring-white/15")}>
            <Icon className="h-3.5 w-3.5" aria-hidden /> {eyebrow}
          </span>
          <h2 className={cn("mt-3 font-bold tracking-tight", compact ? "text-2xl" : "text-3xl")}>{title}</h2>
          <p className={cn("max-w-2xl text-indigo-100", compact ? "mt-1 text-sm" : "mt-1.5 text-[15px]")}>{description}</p>
          {children && <div className={cn("flex flex-wrap gap-2 text-xs", compact ? "mt-3" : "mt-4")}>{children}</div>}
        </div>
        {aside}
      </div>
    </header>
  );
}

// Compact stat chip for use inside PageHero.
export function HeroChip({ label, value, dot }: { label: string; value: React.ReactNode; dot?: "green" | "amber" | "red" }) {
  const dotCls = dot === "green" ? "bg-emerald-400" : dot === "amber" ? "bg-amber-400" : dot === "red" ? "bg-red-400" : null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-indigo-200 ring-1 ring-white/10">
      {dotCls && <span className={cn("h-1.5 w-1.5 rounded-full", dotCls)} aria-hidden />}
      {label}: <span className="font-semibold text-white">{value}</span>
    </span>
  );
}

export function SectionCard({
  icon: Icon,
  tone = "indigo",
  title,
  description,
  action,
  className,
  children,
}: {
  icon: LucideIcon;
  tone?: Tone;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm", className)}>
      <div className={cn("flex items-center justify-between gap-4 border-b border-slate-100 bg-gradient-to-r to-white px-5 py-3.5", TINT[tone])}>
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", CHIP[tone])}>
            <Icon className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
            {description && <p className="text-xs text-slate-500">{description}</p>}
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function MetricTile({ label, value, icon: Icon, tone, hint }: { label: string; value: string; icon: LucideIcon; tone: Tone; hint?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-2xl border bg-gradient-to-br to-white px-5 py-4 shadow-sm", TINT[tone], EDGE[tone])}>
      <Icon aria-hidden className={cn("pointer-events-none absolute -right-3 -top-3 h-20 w-20", MARK[tone])} strokeWidth={1.25} />
      <span className={cn("relative flex h-9 w-9 items-center justify-center rounded-lg", CHIP[tone])}>
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <div className="relative mt-3 text-3xl font-bold tracking-tight text-slate-900 tabular-nums">{value}</div>
      <div className="relative mt-0.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      {hint && <div className="relative mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

// Labelled sub-panel inside a section card.
export function Panel({ icon: Icon, tone = "slate", title, right, className, children }: { icon?: LucideIcon; tone?: Tone; title: string; right?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("rounded-xl border border-slate-200 bg-slate-50/60 p-4", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {Icon && (
            <span className={cn("flex h-6 w-6 items-center justify-center rounded-md", SOFT[tone])}>
              <Icon className="h-3.5 w-3.5" aria-hidden />
            </span>
          )}
          {title}
        </p>
        {right}
      </div>
      {children}
    </div>
  );
}

const ROW_TONE: Record<string, string> = { amber: "text-amber-700", red: "text-red-600", green: "text-emerald-700" };

export function StatRow({ label, children, tone }: { label: string; children: React.ReactNode; tone?: "amber" | "red" | "green" }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-200/70 py-1.5 text-sm last:border-b-0">
      <span className="text-slate-600">{label}</span>
      <span className={cn("text-right font-semibold tabular-nums", tone ? ROW_TONE[tone] : "text-slate-900")}>{children}</span>
    </div>
  );
}

// Status pill with a leading dot. Tone must come from the real status, never decoration.
export function StatusPill({ tone, children }: { tone: "green" | "amber" | "red" | "blue" | "slate"; children: React.ReactNode }) {
  const map = {
    green: ["bg-emerald-50 text-emerald-700 ring-emerald-200", "bg-emerald-500"],
    amber: ["bg-amber-50 text-amber-700 ring-amber-200", "bg-amber-500"],
    red: ["bg-red-50 text-red-700 ring-red-200", "bg-red-500"],
    blue: ["bg-blue-50 text-blue-700 ring-blue-200", "bg-blue-500"],
    slate: ["bg-slate-100 text-slate-600 ring-slate-200", "bg-slate-400"],
  } as const;
  const [cls, dot] = map[tone];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset", cls)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", dot)} aria-hidden />
      {children}
    </span>
  );
}

// Friendly empty state for lists: tinted icon chip, short explanation and an optional action.
export function EmptyPanel({ icon: Icon, tone = "indigo", title, description, action }: { icon: LucideIcon; tone?: Tone; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className={cn("flex flex-col items-center rounded-2xl border border-dashed bg-gradient-to-b to-white px-6 py-14 text-center", TINT[tone], EDGE[tone])}>
      <span className={cn("flex h-12 w-12 items-center justify-center rounded-xl shadow-sm", CHIP[tone])}>
        <Icon className="h-6 w-6" aria-hidden />
      </span>
      <p className="mt-4 text-base font-semibold text-slate-900">{title}</p>
      <p className="mt-1 max-w-md text-sm text-slate-500">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
