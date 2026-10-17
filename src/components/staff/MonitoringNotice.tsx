import { ShieldCheck } from "lucide-react";

// Plain-language statement of what is recorded. Shown on the sign-in page and in Settings so staff always know.
export const MONITORING_TEXT =
  "DIRECTOR.LTD records when you sign in and out and the actions you take inside the application (searches, opening companies, CRM changes, contacts you log, reports, exports) so supervisors can see work that was done. It does not record your password, keystrokes, screen, location or anything you do outside DIRECTOR.LTD.";

export function MonitoringNotice({ className }: { className?: string }) {
  return (
    <p className={className ?? "flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-600"}>
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" aria-hidden />
      <span>
        <strong className="font-semibold text-slate-700">Activity is recorded. </strong>
        {MONITORING_TEXT}
      </span>
    </p>
  );
}
