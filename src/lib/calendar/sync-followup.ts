import { db } from "@/lib/db";
import { getActiveConnectionForUser } from "./registry";
import { isGone } from "./providers/google";

// Syncs a FollowUp to the user's active calendar provider. Never throws —
// a calendar failure must not lose or block a follow-up, which already
// exists safely in our own database regardless of what happens here. Any
// failure is recorded on the connection (lastSyncError) so it surfaces in
// Settings instead of silently disappearing.
// `resolve` defaults to the user's real active connection; tests pass a fake one.
export async function syncFollowUpToCalendar(followUpId: string, userId: string, resolve: typeof getActiveConnectionForUser = getActiveConnectionForUser) {
  try {
    const followUp = await db.followUp.findUnique({
      where: { id: followUpId },
      include: { userCompanyState: { include: { company: true } } },
    });
    if (!followUp) return;

    const { provider, connection } = await resolve(userId);

    const input = {
      title: `Follow up: ${followUp.userCompanyState.company.name}`,
      description: followUp.note ?? undefined,
      startAt: followUp.dueDate,
    };

    const existingLink = await db.calendarEvent.findUnique({ where: { followUpId } });

    let externalEventId: string;
    if (existingLink && existingLink.provider === connection.provider) {
      try {
        await provider.updateEvent(connection, existingLink.externalEventId, input);
        externalEventId = existingLink.externalEventId;
      } catch (err) {
        // The event was deleted on the provider's side (or its calendar was): make it again instead of failing forever.
        if (!isGone(err)) throw err;
        externalEventId = await provider.createEvent(connection, input);
      }
    } else {
      externalEventId = await provider.createEvent(connection, input);
    }

    await db.calendarEvent.upsert({
      where: { followUpId },
      create: { followUpId, provider: connection.provider, externalEventId, syncStatus: "synced" },
      update: { provider: connection.provider, externalEventId, syncStatus: "synced", lastSyncedAt: new Date() },
    });

    await db.calendarConnection.update({
      where: { id: connection.id },
      data: { lastSyncAt: new Date(), lastSyncError: null },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Calendar sync failed for follow-up", followUpId, message);
    // A revoked / expired Google authorisation can never recover by retrying: mark the connection as needing a reconnect
    // (Settings then offers Connect again, and follow-ups keep working in the internal calendar meanwhile).
    const revoked = /invalid_grant/i.test(message);
    await db.calendarConnection
      .updateMany({
        where: { userId, status: "CONNECTED", provider: { not: "INTERNAL" } },
        data: revoked ? { status: "ERROR", lastSyncError: "Google access was revoked or has expired. Connect Google Calendar again." } : { lastSyncError: message },
      })
      .catch(() => {});
  }
}

export async function deleteFollowUpCalendarEvent(followUpId: string, userId: string) {
  try {
    const link = await db.calendarEvent.findUnique({ where: { followUpId } });
    if (!link) return;
    const { provider, connection } = await getActiveConnectionForUser(userId);
    if (connection.provider === link.provider) {
      await provider.deleteEvent(connection, link.externalEventId);
    }
    await db.calendarEvent.delete({ where: { followUpId } });
  } catch (err) {
    console.error("Failed to delete calendar event for follow-up", followUpId, err);
  }
}

// After a user connects an external calendar: send the follow-ups that are still open (not done, due today or later) so the
// calendar is not empty until the next follow-up is created. Sequential and capped; each one records its own failure.
export async function syncOpenFollowUpsForUser(userId: string, limit = 200, resolve: typeof getActiveConnectionForUser = getActiveConnectionForUser): Promise<number> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const open = await db.followUp.findMany({
    where: { userId, done: false, dueDate: { gte: today } },
    orderBy: { dueDate: "asc" },
    take: limit,
    select: { id: true },
  });
  for (const f of open) await syncFollowUpToCalendar(f.id, userId, resolve);
  return open.length;
}
