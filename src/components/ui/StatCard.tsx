import { cn } from "@/lib/cn";
import type { LucideIcon } from "lucide-react";

export function StatCard({
  label,
  value,
  icon: Icon,
  accent = "indigo",
  hint,
}: {
  label: string;
  value: string;
  icon?: LucideIcon;
  accent?: "indigo" | "emerald" | "amber" | "slate";
  hint?: string;
}) {
  const accentClasses: Record<string, string> = {
    indigo: "border-l-indigo-500",
    emerald: "border-l-emerald-500",
    amber: "border-l-amber-500",
    slate: "border-l-slate-400",
  };
  return (
    <div
      className={cn(
        "rounded-xl border border-slate-200 border-l-4 bg-white px-5 py-4",
        accentClasses[accent]
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
        {Icon && <Icon className="h-4 w-4 text-slate-400" />}
      </div>
      <div className="mt-2 text-2xl font-semibold text-slate-900">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}
