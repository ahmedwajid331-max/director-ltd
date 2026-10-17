import { cn } from "@/lib/cn";

// The single section primitive of the company workspace. Every information block (official Companies House data on the
// Overview tab, and the private CRM tabs) uses the same header, so "blue heading = a major information section".
//
//   [icon chip]  SECTION TITLE  [count]                         SOURCE
//   ----------------------------------------------------------------   (thin blue accent line)
//
// Level 1 = this heading (DIRECTOR.LTD blue), level 2 = field label (muted blue-grey), level 3 = value (dark navy).
// Plain module (no "use client") so server pages and client components can both use it.

export const sectionCard = "rounded-2xl border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md";

export type SectionSource = "companies-house" | "crm" | "none";

export function SectionHeader({
  title,
  icon: Icon,
  count,
  source = "companies-house",
  right,
}: {
  title: string;
  icon?: React.ElementType;
  count?: number;
  source?: SectionSource;
  right?: React.ReactNode;
}) {
  const crm = source === "crm";
  return (
    <header
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-t-2xl border-b bg-gradient-to-r to-white px-4 py-3",
        crm ? "border-violet-100 from-violet-50/80" : "border-indigo-100 from-indigo-50/80"
      )}
    >
      <h3 className={cn("flex items-center gap-2.5 text-xs font-bold uppercase tracking-wider", crm ? "text-violet-700" : "text-indigo-800")}>
        {Icon && (
          <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white shadow-sm", crm ? "bg-violet-600" : "bg-indigo-600")} aria-hidden>
            <Icon className="h-3.5 w-3.5" />
          </span>
        )}
        <span>{title}</span>
        {count !== undefined && <span className={cn("rounded-full px-1.5 py-px text-[10px] font-semibold tracking-normal", crm ? "bg-violet-100 text-violet-700" : "bg-indigo-100 text-indigo-700")}>{count}</span>}
      </h3>
      <div className="ml-auto flex items-center gap-3">
        {right}
        {source !== "none" &&
          (crm ? (
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700">Your CRM · private to you</span>
          ) : (
            <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Companies House</span>
          ))}
      </div>
    </header>
  );
}

// Compact label/value used by the header indicators and every Overview panel.
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words text-[13px] font-medium text-slate-900">{children}</dd>
    </div>
  );
}

// Overview panel: section header + a compact grid of Fields.
export function DataSection({ title, icon, cols = 2, children }: { title: string; icon: React.ElementType; cols?: 2 | 4; children: React.ReactNode }) {
  return (
    <section className={sectionCard}>
      <SectionHeader title={title} icon={icon} />
      <dl className={cn("grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-3", cols === 4 && "lg:grid-cols-4")}>{children}</dl>
    </section>
  );
}
