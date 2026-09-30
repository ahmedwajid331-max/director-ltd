import { db } from "@/lib/db";
import { getActiveConnectionForUser } from "./registry";

// Syncs a FollowUp to the user's active calendar provider. Never throws —
// a calendar failure must not lose or block a follow-up, which already
// exists safely in our own database regardless of what happens here. Any
// failure is recorded on the connection (lastSyncError) so it surfaces in
// Settings instead of silently disappearing.
export async function syncFollowUpToCalendar(followUpId: string, userId: string) {
  try {
    const followUp = await db.followUp.findUnique({
      where: { id: followUpId },
      include: { userCompanyState: { include: { company: true } } },
    });
    if (!followUp) return;

    const { provider, connection } = await getActiveConnectionForUser(userId);

    const input = {
      title: `Follow up: ${followUp.userCompanyState.company.name}`,
      description: followUp.note ?? undefined,
      startAt: followUp.dueDate,
    };

    const existingLink = await db.calendarEvent.findUnique({ where: { followUpId } });

    let externalEventId: string;
    if (existingLink && existingLink.provider === connection.provider) {
      await provider.updateEvent(connection, existingLink.externalEventId, input);
      externalEventId = existingLink.externalEventId;
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
    await db.calendarConnection
      .updateMany({ where: { userId, status: "CONNECTED" }, data: { lastSyncError: message } })
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
