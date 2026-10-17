import type { Metadata } from "next";
import { CalendarDays } from "lucide-react";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/auth/permissions";
import { appTimezone, dayKey } from "@/lib/staff/periods";
import { PageHero, HeroChip } from "@/components/admin/AdminUi";
import { CalendarClient } from "./CalendarClient";

export const metadata: Metadata = { title: "Calendar" };

export default async function CalendarPage() {
  const session = await requirePermission("calendar.use");
  const userId = session.userId;
  // "Today" in the application time zone (as on My work), so the chips below and the calendar agree on what is overdue.
  const todayKey = dayKey(new Date(), appTimezone());
  const startOfToday = new Date(`${todayKey}T00:00:00.000Z`);
  const withWork = can(session, "work.assigned");
  const [fOverdue, fUpcoming, aOverdue, aUpcoming] = await Promise.all([
    db.followUp.count({ where: { userId, done: false, dueDate: { lt: startOfToday } } }),
    db.followUp.count({ where: { userId, done: false, dueDate: { gte: startOfToday } } }),
    withWork ? db.assignment.count({ where: { assigneeId: userId, status: "open", dueDate: { lt: startOfToday } } }) : 0,
    withWork ? db.assignment.count({ where: { assigneeId: userId, status: "open", dueDate: { gte: startOfToday } } }) : 0,
  ]);
  const overdue = fOverdue + aOverdue;
  const upcoming = fUpcoming + aUpcoming;

  return (
    <div className="w-full space-y-4">
      <PageHero
        icon={CalendarDays}
        accent="blue"
        compact
        eyebrow="Follow-ups"
        title="Calendar & follow-ups"
        description="Everything you've scheduled to chase, plus work assigned to you, in one place."
      >
        <HeroChip label="Overdue" value={overdue.toLocaleString()} dot={overdue > 0 ? "red" : "green"} />
        <HeroChip label="Upcoming" value={upcoming.toLocaleString()} />
      </PageHero>
      <CalendarClient todayKey={todayKey} />
    </div>
  );
}
