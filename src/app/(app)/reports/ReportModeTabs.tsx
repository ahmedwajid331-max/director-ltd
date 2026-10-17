import Link from "next/link";
import { FilePlus2, Pencil } from "lucide-react";
import { cn } from "@/lib/cn";

// The two report workflows, always visible at the top of the Report Builder.
export function ReportModeTabs({ active }: { active: "create" | "edit" }) {
  const tabs = [
    { key: "create", href: "/reports/new", label: "Create report", sub: "Start a new report from scratch", Icon: FilePlus2 },
    { key: "edit", href: "/reports/new?mode=edit", label: "Edit existing", sub: "Change a saved report's criteria", Icon: Pencil },
  ] as const;
  return (
    <div className="grid max-w-[640px] gap-3 sm:grid-cols-2">
      {tabs.map(({ key, href, label, sub, Icon }) => (
        <Link
          key={key}
          href={href}
          aria-current={active === key ? "page" : undefined}
          className={cn(
            "flex items-center gap-3 rounded-lg border px-4 py-2 transition-colors",
            active === key
              ? "border-indigo-600 bg-indigo-50 ring-1 ring-indigo-600"
              : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
          )}
        >
          <span
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-md",
              active === key ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500"
            )}
          >
            <Icon className="h-4 w-4" />
          </span>
          <span>
            <span className="block text-sm font-semibold uppercase tracking-wide text-slate-900">{label}</span>
            <span className="block text-xs text-slate-500">{sub}</span>
          </span>
        </Link>
      ))}
    </div>
  );
}
