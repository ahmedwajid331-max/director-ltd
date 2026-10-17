import { google, type calendar_v3 } from "googleapis";
import type { CalendarConnection } from "@prisma/client";
import { db } from "@/lib/db";
import { encryptToken, decryptToken } from "../token-crypto";
import type { CalendarProvider, CalendarEventInput, CalendarHealth } from "../types";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/userinfo.email",
];

const DEDICATED_CALENDAR_NAME = "DIRECTOR.LTD Follow-ups";

// Follow-ups are date-only, so they are sent to Google as ALL-DAY events
// (start.date / end.date, end exclusive) - never as a timed event at
// midnight UTC, which would show at 01:00 in summer for a UK user.
function allDayTimes(startAt: Date) {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const next = new Date(startAt.getTime() + 24 * 60 * 60 * 1000);
  return { start: { date: day(startAt) }, end: { date: day(next) } };
}

function getOAuthClient() {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google Calendar OAuth is not configured (GOOGLE_CALENDAR_CLIENT_ID/SECRET/REDIRECT_URI)");
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// What is still missing on the server for Google Calendar to work (names only, never values). TOKEN_ENCRYPTION_KEY is
// needed because the user's Google tokens are stored encrypted: without it a user could finish Google's consent screen
// and then fail on our side, so it counts as "not configured".
export function googleCalendarSetupIssues(): string[] {
  const missing: string[] = [];
  for (const name of ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_REDIRECT_URI", "TOKEN_ENCRYPTION_KEY"]) {
    if (!process.env[name]) missing.push(name);
  }
  return missing;
}

export function isGoogleCalendarConfigured(): boolean {
  return googleCalendarSetupIssues().length === 0;
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

// The two things that talk to Google. Real implementations below; tests substitute fakes so the provider's own logic
// (calendar reuse, recovery, token storage) can be exercised without Google credentials.
export interface GoogleDeps {
  calendarFor(connection: CalendarConnection): Promise<calendar_v3.Calendar>;
  // Exchanges the authorisation code; returns the tokens, the account's email and an API client for that account.
  connectWithCode(code: string): Promise<{ tokens: { access_token?: string | null; refresh_token?: string | null; expiry_date?: number | null }; email: string | null; calendar: calendar_v3.Calendar }>;
}

const realDeps: GoogleDeps = {
  async calendarFor(connection) {
    return google.calendar({ auth: await authorizedClient(connection), version: "v3" });
  },
  async connectWithCode(code) {
    const client = getOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ auth: client, version: "v2" });
    const { data: profile } = await oauth2.userinfo.get();
    return { tokens, email: profile.email ?? null, calendar: google.calendar({ auth: client, version: "v3" }) };
  },
};

// Google reports a missing calendar / event as 404 (or 410 for an already-deleted event).
export function isGone(err: unknown): boolean {
  const e = err as { code?: number | string; status?: number; response?: { status?: number } } | null;
  const status = Number(e?.response?.status ?? e?.status ?? e?.code);
  return status === 404 || status === 410;
}

async function createDedicatedCalendar(api: calendar_v3.Calendar): Promise<string> {
  const { data } = await api.calendars.insert({ requestBody: { summary: DEDICATED_CALENDAR_NAME } });
  if (!data.id) throw new Error("Google did not return a calendar id");
  return data.id;
}

export function createGoogleCalendarProvider(deps: GoogleDeps = realDeps): CalendarProvider {
  // If the user deleted the dedicated calendar in Google, make a new one and remember it, instead of failing every sync.
  async function recreateCalendar(connection: CalendarConnection, api: calendar_v3.Calendar): Promise<string> {
    const calendarId = await createDedicatedCalendar(api);
    await db.calendarConnection.update({ where: { id: connection.id }, data: { calendarId } });
    connection.calendarId = calendarId;
    return calendarId;
  }

  return {
    name: "GOOGLE",

    // `state` is the one-time random value from oauth-state.ts (never the user id).
    getAuthUrl(state: string): string {
      const client = getOAuthClient();
      return client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES, state });
    },

    async handleCallback(code: string, userId: string): Promise<CalendarConnection> {
      const { tokens, email, calendar } = await deps.connectWithCode(code);
      if (!tokens.access_token || !tokens.refresh_token) {
        throw new Error("Google did not return a refresh token - ensure prompt=consent and access_type=offline");
      }

      // Reconnecting the same Google account reuses the follow-ups calendar it already has (so events created earlier keep
      // working and no duplicate calendar appears); a different account, or a calendar deleted in Google, gets a new one.
      const previous = await db.calendarConnection.findUnique({ where: { userId_provider: { userId, provider: "GOOGLE" } } });
      let calendarId: string | null = null;
      if (previous?.calendarId && previous.accountEmail && previous.accountEmail === email) {
        try {
          await calendar.calendars.get({ calendarId: previous.calendarId });
          calendarId = previous.calendarId;
        } catch (err) {
          if (!isGone(err)) throw err;
        }
      }
      calendarId ??= await createDedicatedCalendar(calendar);

      const data = {
        status: "CONNECTED",
        accountEmail: email,
        calendarId,
        accessTokenEnc: encryptToken(tokens.access_token),
        refreshTokenEnc: encryptToken(tokens.refresh_token),
        tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        lastSyncAt: new Date(),
        lastSyncError: null,
      };
      return db.calendarConnection.upsert({ where: { userId_provider: { userId, provider: "GOOGLE" } }, create: { userId, provider: "GOOGLE", ...data }, update: data });
    },

    async createEvent(connection, input: CalendarEventInput): Promise<string> {
      const api = await deps.calendarFor(connection);
      const body = { summary: input.title, description: input.description, ...allDayTimes(input.startAt) };
      let calendarId = connection.calendarId ?? "primary";
      let data;
      try {
        ({ data } = await api.events.insert({ calendarId, requestBody: body }));
      } catch (err) {
        if (!isGone(err) || !connection.calendarId) throw err;
        calendarId = await recreateCalendar(connection, api);
        ({ data } = await api.events.insert({ calendarId, requestBody: body }));
      }
      if (!data.id) throw new Error("Google Calendar did not return an event id");
      return data.id;
    },

    async updateEvent(connection, externalEventId, input: CalendarEventInput) {
      const api = await deps.calendarFor(connection);
      await api.events.patch({
        calendarId: connection.calendarId ?? "primary",
        eventId: externalEventId,
        requestBody: { summary: input.title, description: input.description, ...allDayTimes(input.startAt) },
      });
    },

    async deleteEvent(connection, externalEventId) {
      const api = await deps.calendarFor(connection);
      try {
        await api.events.delete({ calendarId: connection.calendarId ?? "primary", eventId: externalEventId });
      } catch (err) {
        if (!isGone(err)) throw err; // already gone in Google: nothing left to delete
      }
    },

    async disconnect(connection) {
      try {
        const client = await authorizedClient(connection);
        const token = connection.refreshTokenEnc ? decryptToken(connection.refreshTokenEnc) : null;
        if (token) await client.revokeToken(token);
      } catch {
        // Best-effort revoke - still disconnect locally even if Google's
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
        const api = await deps.calendarFor(connection);
        await api.calendarList.get({ calendarId: connection.calendarId ?? "primary" });
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
}

export const googleCalendarProvider = createGoogleCalendarProvider();
