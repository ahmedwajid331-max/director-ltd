import type { CalendarConnection } from "@prisma/client";
import type { CalendarProvider, CalendarEventInput, CalendarHealth } from "../types";

// Always-available fallback. A "follow-up" already *is* a calendar entry in
// our own Calendar page (src/app/(app)/calendar) — this provider exists
// purely so the rest of the app can treat "no external calendar connected"
// as just another provider rather than a special case, and so follow-ups
// are never lost if Google/Microsoft is unavailable.
export const internalProvider: CalendarProvider = {
  name: "INTERNAL",

  async createEvent(_connection, input: CalendarEventInput) {
    // No external event to create — the FollowUp row itself is the event.
    return `internal:${input.startAt.toISOString()}`;
  },

  async updateEvent() {
    // Nothing external to update.
  },

  async deleteEvent() {
    // Nothing external to delete.
  },

  async disconnect() {
    // The internal provider can't be disconnected — it's the fallback.
  },

  async checkHealth(connection: CalendarConnection): Promise<CalendarHealth> {
    return { ok: true, status: "CONNECTED", lastSyncAt: connection.lastSyncAt, lastSyncError: null };
  },
};
