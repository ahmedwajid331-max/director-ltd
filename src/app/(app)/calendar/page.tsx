import type { Metadata } from "next";
import { CalendarClient } from "./CalendarClient";

export const metadata: Metadata = { title: "Calendar" };

export default function CalendarPage() {
  return (
    <div className="space-y-1">
      <h2 className="text-lg font-semibold text-slate-900">Calendar & follow-ups</h2>
      <p className="mb-4 text-sm text-slate-500">Everything you&apos;ve scheduled to chase, in one place.</p>
      <CalendarClient />
    </div>
  );
}
