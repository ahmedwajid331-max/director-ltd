import type { CalendarConnection } from "@prisma/client";

export interface CalendarEventInput {
  title: string;
  description?: string;
  startAt: Date;
  durationMinutes?: number;
}

export interface CalendarHealth {
  ok: boolean;
  status: "CONNECTED" | "DISCONNECTED" | "ERROR";
  lastSyncAt: Date | null;
  lastSyncError: string | null;
}

// Every calendar provider (internal fallback, Google, and — later —
// Microsoft/Outlook) implements exactly this interface. Nothing else in the
// app (follow-up creation, Settings) talks to a provider's SDK directly, so
// adding a new provider never requires touching the CRM/follow-up code.
export interface CalendarProvider {
  name: "GOOGLE" | "MICROSOFT" | "INTERNAL";

  // OAuth providers only — the internal provider is always "connected" and
  // returns null here. `state` is the one-time random value from oauth-state.ts;
  // handleCallback receives the signed-in user's id (already verified by the route).
  getAuthUrl?(state: string): string;
  handleCallback?(code: string, userId: string): Promise<CalendarConnection>;

  createEvent(connection: CalendarConnection, input: CalendarEventInput): Promise<string>; // returns externalEventId
  updateEvent(connection: CalendarConnection, externalEventId: string, input: CalendarEventInput): Promise<void>;
  deleteEvent(connection: CalendarConnection, externalEventId: string): Promise<void>;

  disconnect(connection: CalendarConnection): Promise<void>;
  checkHealth(connection: CalendarConnection): Promise<CalendarHealth>;
}
