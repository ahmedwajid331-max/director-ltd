import { cn } from "@/lib/cn";

type Tone = "slate" | "green" | "amber" | "red" | "indigo" | "blue";

const toneClasses: Record<Tone, string> = {
  slate: "bg-slate-100 text-slate-700",
  green: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  red: "bg-red-50 text-red-700",
  indigo: "bg-indigo-50 text-indigo-700",
  blue: "bg-blue-50 text-blue-700",
};

export function Badge({
  tone = "slate",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        toneClasses[tone],
        className
      )}
    >
      {children}
    </span>
  );
}
