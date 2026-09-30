import { google } from "googleapis";
import type { CalendarConnection } from "@prisma/client";
import { db } from "@/lib/db";
import { encryptToken, decryptToken } from "../token-crypto";
import type { CalendarProvider, CalendarEventInput, CalendarHealth } from "../types";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/userinfo.email",
];

const DEDICATED_CALENDAR_NAME = "DIRECTOR.LTD Follow-ups";

function getOAuthClient() {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google Calendar OAuth is not configured (GOOGLE_CALENDAR_CLIENT_ID/SECRET/REDIRECT_URI)");
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function isGoogleCalendarConfigured(): boolean {
  return !!(
    process.env.GOOGLE_CALENDAR_CLIENT_ID &&
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET &&
    process.env.GOOGLE_CALENDAR_REDIRECT_URI
  );
}

async function authorizedClient(connection: CalendarConnection) {
  const client = getOAuthClient();
  client.setCredentials({
    access_token: connection.accessTokenEnc ? decryptToken(connection.accessTokenEnc) : undefined,
    refresh_token: connection.refreshTokenEnc ? decryptToken(connection.refreshTokenEnc) : undefined,
    expiry_date: connection.tokenExpiresAt?.getTime(),
  });

  // Persist refreshed access tokens so the next call doesn't need to
  // refresh again, without ever logging the token value.
  client.on("tokens", async (tokens) => {
    if (!tokens.access_token) return;
    await db.calendarConnection.update({
      where: { id: connection.id },
      data: {
        accessTokenEnc: encryptToken(tokens.access_token),
        tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
      },
    });
  });

  return client;
}

export const googleCalendarProvider: CalendarProvider = {
  name: "GOOGLE",

  getAuthUrl(userId: string): string {
    const client = getOAuthClient();
    return client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: SCOPES,
      state: userId,
    });
  },

  async handleCallback(code: string, state: string): Promise<CalendarConnection> {
    const userId = state;
    const client = getOAuthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error("Google did not return a refresh token — ensure prompt=consent and access_type=offline");
    }
    client.setCredentials(tokens);

    const oauth2 = google.oauth2({ auth: client, version: "v2" });
    const { data: profile } = await oauth2.userinfo.get();

    const calendarApi = google.calendar({ auth: client, version: "v3" });
    const { data: created } = await calendarApi.calendars.insert({
      requestBody: { summary: DEDICATED_CALENDAR_NAME },
    });

    return db.calendarConnection.upsert({
      where: { userId_provider: { userId, provider: "GOOGLE" } },
      create: {
        userId,
        provider: "GOOGLE",
        status: "CONNECTED",
        accountEmail: profile.email ?? null,
        calendarId: created.id ?? null,
        accessTokenEnc: encryptToken(tokens.access_token),
        refreshTokenEnc: encryptToken(tokens.refresh_token),
        tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        lastSyncAt: new Date(),
        lastSyncError: null,
      },
      update: {
        status: "CONNECTED",
        accountEmail: profile.email ?? null,
        calendarId: created.id ?? null,
        accessTokenEnc: encryptToken(tokens.access_token),
        refreshTokenEnc: encryptToken(tokens.refresh_token),
        tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        lastSyncAt: new Date(),
        lastSyncError: null,
      },
    });
  },

  async createEvent(connection, input: CalendarEventInput): Promise<string> {
    const client = await authorizedClient(connection);
    const calendarApi = google.calendar({ auth: client, version: "v3" });
    const duration = input.durationMinutes ?? 30;
    const end = new Date(input.startAt.getTime() + duration * 60000);

    const { data } = await calendarApi.events.insert({
      calendarId: connection.calendarId ?? "primary",
      requestBody: {
        summary: input.title,
        description: input.description,
        start: { dateTime: input.startAt.toISOString() },
        end: { dateTime: end.toISOString() },
      },
    });
    if (!data.id) throw new Error("Google Calendar did not return an event id");
    return data.id;
  },

  async updateEvent(connection, externalEventId, input: CalendarEventInput) {
    const client = await authorizedClient(connection);
    const calendarApi = google.calendar({ auth: client, version: "v3" });
    const duration = input.durationMinutes ?? 30;
    const end = new Date(input.startAt.getTime() + duration * 60000);

    await calendarApi.events.patch({
      calendarId: connection.calendarId ?? "primary",
      eventId: externalEventId,
      requestBody: {
        summary: input.title,
        description: input.description,
        start: { dateTime: input.startAt.toISOString() },
        end: { dateTime: end.toISOString() },
      },
    });
  },

  async deleteEvent(connection, externalEventId) {
    const client = await authorizedClient(connection);
    const calendarApi = google.calendar({ auth: client, version: "v3" });
    await calendarApi.events.delete({
      calendarId: connection.calendarId ?? "primary",
      eventId: externalEventId,
    });
  },

  async disconnect(connection) {
    try {
      const client = await authorizedClient(connection);
      const token = connection.refreshTokenEnc ? decryptToken(connection.refreshTokenEnc) : null;
      if (token) await client.revokeToken(token);
    } catch {
      // Best-effort revoke — still disconnect locally even if Google's
      // revoke call fails (token already invalid, network issue, etc).
    }
    await db.calendarConnection.update({
      where: { id: connection.id },
      data: {
        status: "DISCONNECTED",
        accessTokenEnc: null,
        refreshTokenEnc: null,
        tokenExpiresAt: null,
      },
    });
  },

  async checkHealth(connection): Promise<CalendarHealth> {
    try {
      const client = await authorizedClient(connection);
      const calendarApi = google.calendar({ auth: client, version: "v3" });
      await calendarApi.calendarList.get({ calendarId: connection.calendarId ?? "primary" });
      await db.calendarConnection.update({
        where: { id: connection.id },
        data: { lastSyncAt: new Date(), lastSyncError: null, status: "CONNECTED" },
      });
      return { ok: true, status: "CONNECTED", lastSyncAt: new Date(), lastSyncError: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.calendarConnection.update({
        where: { id: connection.id },
        data: { lastSyncError: message, status: "ERROR" },
      });
      return { ok: false, status: "ERROR", lastSyncAt: connection.lastSyncAt, lastSyncError: message };
    }
  },
};
