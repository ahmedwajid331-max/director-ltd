import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { calendar_v3 } from "googleapis";
import { BASE, createUser, db, login, makeCompany, sessionFor, STRONG_PASSWORD, type Session } from "./helpers";
import { createGoogleCalendarProvider, type GoogleDeps } from "../../src/lib/calendar/providers/google";
import { decryptToken } from "../../src/lib/calendar/token-crypto";
import { getActiveConnectionForUser } from "../../src/lib/calendar/registry";
import { syncFollowUpToCalendar, syncOpenFollowUpsForUser } from "../../src/lib/calendar/sync-followup";
import { findChrome, launchPage } from "../support/browser";

// Google Calendar: the provider's own logic (against a fake Google), the follow-up sync fallbacks, the secure connect /
// callback flow over HTTP (server :3213 has FAKE credentials, :3211 has none), and the Settings page in a real browser.
// Nothing here talks to Google. Scratch database only.

const BASE_G = process.env.TEST_BASE_URL_GOOGLE ?? "http://127.0.0.1:3213";

after(async () => {
  await db.$disconnect();
});

// ---- a fake Google ---------------------------------------------------------------------------------------------------
function fakeGoogle(email = "person@example.com") {
  const gone = new Set<string>(); // calendar ids that "do not exist any more"
  const goneEvents = new Set<string>();
  const calls = { calendarsInsert: 0, calendarsGet: 0, eventsInsert: [] as { calendarId: string; summary?: string | null; start?: unknown }[], eventsPatch: 0, eventsDelete: 0 };
  let nCal = 0;
  let nEv = 0;
  let failPatchWith: Error | null = null;
  const notFound = () => Object.assign(new Error("Not Found"), { code: 404 });
  const api = {
    calendars: {
      insert: async () => {
        calls.calendarsInsert++;
        return { data: { id: `cal-${++nCal}` } };
      },
      get: async ({ calendarId }: { calendarId: string }) => {
        calls.calendarsGet++;
        if (gone.has(calendarId)) throw notFound();
        return { data: { id: calendarId } };
      },
    },
    calendarList: { get: async ({ calendarId }: { calendarId: string }) => (gone.has(calendarId) ? Promise.reject(notFound()) : { data: { id: calendarId } }) },
    events: {
      insert: async ({ calendarId, requestBody }: { calendarId: string; requestBody: { summary?: string | null; start?: unknown } }) => {
        if (gone.has(calendarId)) throw notFound();
        calls.eventsInsert.push({ calendarId, summary: requestBody.summary, start: requestBody.start });
        return { data: { id: `ev-${++nEv}` } };
      },
      patch: async ({ eventId }: { calendarId: string; eventId: string }) => {
        calls.eventsPatch++;
        if (failPatchWith) throw failPatchWith;
        if (goneEvents.has(eventId)) throw notFound();
        return { data: {} };
      },
      delete: async ({ eventId }: { eventId: string }) => {
        calls.eventsDelete++;
        if (goneEvents.has(eventId)) throw Object.assign(new Error("Gone"), { code: 410 });
        if (eventId === "boom") throw Object.assign(new Error("Backend Error"), { code: 500 });
      },
    },
  } as unknown as calendar_v3.Calendar;
  let who = email;
  const deps: GoogleDeps = {
    calendarFor: async () => api,
    connectWithCode: async (code) => ({
      tokens: code === "no-refresh" ? { access_token: "ACCESS-x" } : { access_token: `ACCESS-${code}`, refresh_token: `REFRESH-${code}`, expiry_date: Date.now() + 3_600_000 },
      email: who,
      calendar: api,
    }),
  };
  return { deps, calls, gone, goneEvents, setEmail: (e: string) => (who = e), failPatch: (e: Error | null) => (failPatchWith = e) };
}

const connectionOf = (userId: string) => db.calendarConnection.findUniqueOrThrow({ where: { userId_provider: { userId, provider: "GOOGLE" } } });

test("connecting stores the tokens ENCRYPTED, creates one follow-ups calendar, and reconnecting reuses it", async () => {
  const user = await createUser("USER", "gcal");
  const g = fakeGoogle("person@example.com");
  const provider = createGoogleCalendarProvider(g.deps);

  const first = await provider.handleCallback!("code1", user.id);
  assert.equal(first.status, "CONNECTED");
  assert.equal(first.accountEmail, "person@example.com");
  assert.equal(first.calendarId, "cal-1");
  const row = await connectionOf(user.id);
  assert.ok(row.accessTokenEnc && row.refreshTokenEnc);
  assert.ok(!row.accessTokenEnc.includes("ACCESS-code1") && !row.refreshTokenEnc.includes("REFRESH-code1"), "no plaintext token in the database");
  assert.equal(decryptToken(row.accessTokenEnc), "ACCESS-code1");
  assert.equal(decryptToken(row.refreshTokenEnc), "REFRESH-code1");

  // reconnect with the same Google account: same calendar, no duplicate
  await provider.handleCallback!("code2", user.id);
  assert.equal(g.calls.calendarsInsert, 1, "no second calendar was created");
  assert.equal((await connectionOf(user.id)).calendarId, "cal-1");
  assert.equal(decryptToken((await connectionOf(user.id)).refreshTokenEnc!), "REFRESH-code2", "new tokens stored");

  // a DIFFERENT Google account gets its own calendar
  g.setEmail("other@example.com");
  await provider.handleCallback!("code3", user.id);
  assert.equal(g.calls.calendarsInsert, 2);
  assert.equal((await connectionOf(user.id)).calendarId, "cal-2");

  // the calendar was deleted in Google meanwhile: a new one is made
  g.gone.add("cal-2");
  await provider.handleCallback!("code4", user.id);
  assert.equal(g.calls.calendarsInsert, 3);
  assert.equal((await connectionOf(user.id)).calendarId, "cal-3");
  assert.equal(await db.calendarConnection.count({ where: { userId: user.id, provider: "GOOGLE" } }), 1, "one connection row per user");
});

test("Google refusing a refresh token is a failed connection and changes nothing", async () => {
  const user = await createUser("USER", "gcal2");
  const g = fakeGoogle();
  await assert.rejects(createGoogleCalendarProvider(g.deps).handleCallback!("no-refresh", user.id), /refresh token/i);
  assert.equal(await db.calendarConnection.count({ where: { userId: user.id, provider: "GOOGLE" } }), 0);
  assert.equal(g.calls.calendarsInsert, 0);
});

test("a follow-up becomes an all-day event; a deleted calendar is recreated; a missing event deletes quietly", async () => {
  const user = await createUser("USER", "gcal3");
  const g = fakeGoogle();
  const provider = createGoogleCalendarProvider(g.deps);
  const conn = await provider.handleCallback!("c", user.id);

  const id = await provider.createEvent(conn, { title: "Follow up: ACME LTD", description: "call back", startAt: new Date("2026-11-05T00:00:00Z") });
  assert.equal(id, "ev-1");
  assert.deepEqual(g.calls.eventsInsert[0], { calendarId: "cal-1", summary: "Follow up: ACME LTD", start: { date: "2026-11-05" } }, "all-day, on the right date, in the follow-ups calendar");

  // the user deletes the dedicated calendar in Google: the next event makes a new one and remembers it
  g.gone.add("cal-1");
  const id2 = await provider.createEvent(conn, { title: "Follow up: B LTD", startAt: new Date("2026-11-06T00:00:00Z") });
  assert.equal(id2, "ev-2");
  assert.equal(g.calls.eventsInsert.at(-1)!.calendarId, "cal-2");
  assert.equal((await connectionOf(user.id)).calendarId, "cal-2");
  assert.equal(conn.calendarId, "cal-2", "the connection in use is updated too");

  // deleting an event that is already gone is fine; a real failure is still an error
  g.goneEvents.add("ev-1");
  await provider.deleteEvent(conn, "ev-1");
  await assert.rejects(provider.deleteEvent(conn, "boom"), /Backend Error/);
});

async function followUpFor(userId: string, dueDate: string, over: { done?: boolean } = {}) {
  const company = await makeCompany({ name: `GCAL ${Math.random().toString(36).slice(2, 7).toUpperCase()} LTD` });
  const state = await db.userCompanyState.upsert({ where: { userId_companyId: { userId, companyId: company.id } }, create: { userId, companyId: company.id }, update: {} });
  return db.followUp.create({ data: { userCompanyStateId: state.id, userId, dueDate: new Date(`${dueDate}T00:00:00Z`), note: "n", done: over.done ?? false } });
}

test("follow-up sync: creates, updates, recreates an event deleted in Google, and reports a revoked authorisation", async () => {
  const user = await createUser("USER", "gcal4");
  const g = fakeGoogle();
  const provider = createGoogleCalendarProvider(g.deps);
  await provider.handleCallback!("c", user.id);
  const resolve = async () => ({ provider, connection: await connectionOf(user.id) });
  const fu = await followUpFor(user.id, "2026-12-01");

  await syncFollowUpToCalendar(fu.id, user.id, resolve);
  const link1 = await db.calendarEvent.findUniqueOrThrow({ where: { followUpId: fu.id } });
  assert.equal(link1.provider, "GOOGLE");
  assert.equal(link1.externalEventId, "ev-1");

  await syncFollowUpToCalendar(fu.id, user.id, resolve); // second time: an update, not a duplicate
  assert.equal(g.calls.eventsInsert.length, 1);
  assert.equal(g.calls.eventsPatch, 1);

  g.goneEvents.add("ev-1"); // someone deleted the event in Google
  await syncFollowUpToCalendar(fu.id, user.id, resolve);
  const link2 = await db.calendarEvent.findUniqueOrThrow({ where: { followUpId: fu.id } });
  assert.notEqual(link2.externalEventId, "ev-1", "the event was created again");
  assert.equal((await connectionOf(user.id)).lastSyncError, null, "no error left behind");

  // Google says the authorisation is revoked: the connection is marked as needing a reconnect, and follow-ups fall back to the internal calendar
  g.failPatch(Object.assign(new Error("invalid_grant"), { code: 400 }));
  await syncFollowUpToCalendar(fu.id, user.id, resolve);
  const after = await connectionOf(user.id);
  assert.equal(after.status, "ERROR");
  assert.match(after.lastSyncError ?? "", /Connect Google Calendar again/);
  assert.equal((await getActiveConnectionForUser(user.id)).provider.name, "INTERNAL", "the internal calendar takes over");
  assert.equal(await db.followUp.count({ where: { id: fu.id } }), 1, "the follow-up itself is untouched");
});

test("connecting sends the follow-ups that are still open (not done, not past) and nothing else", async () => {
  const user = await createUser("USER", "gcal5");
  const g = fakeGoogle();
  const provider = createGoogleCalendarProvider(g.deps);
  await provider.handleCallback!("c", user.id);
  const resolve = async () => ({ provider, connection: await connectionOf(user.id) });
  const soon = await followUpFor(user.id, "2099-01-10");
  const later = await followUpFor(user.id, "2099-02-20");
  const done = await followUpFor(user.id, "2099-03-01", { done: true });
  const past = await followUpFor(user.id, "2020-01-01");

  assert.equal(await syncOpenFollowUpsForUser(user.id, 200, resolve), 2);
  assert.equal(g.calls.eventsInsert.length, 2);
  for (const f of [soon, later]) assert.ok(await db.calendarEvent.findUnique({ where: { followUpId: f.id } }), "open follow-up synced");
  for (const f of [done, past]) assert.equal(await db.calendarEvent.findUnique({ where: { followUpId: f.id } }), null, "done / past follow-up not sent");
});

// ---- HTTP: unconfigured server -------------------------------------------------------------------------------------------
const hit = (s: Session | null, path: string, base = BASE, extraHeaders: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { redirect: "manual", headers: { ...(s ? { cookie: `director_session=${s.cookie}` } : {}), ...extraHeaders } });

test("not configured: connect says so (naming only the missing settings), status shows it, callback refuses", async () => {
  const s = await sessionFor("USER", "gcal6");
  assert.equal((await hit(null, "/api/calendar/connect/google")).status, 401);
  const r = await hit(s, "/api/calendar/connect/google");
  assert.equal(r.status, 503);
  const body = await r.json();
  assert.match(body.error, /not configured/i);
  assert.ok(body.missing.includes("GOOGLE_CALENDAR_CLIENT_ID") && body.missing.includes("GOOGLE_CALENDAR_CLIENT_SECRET"));
  assert.ok(!JSON.stringify(body).includes("test-client"), "no values in the answer");

  const status = await (await hit(s, "/api/calendar/status")).json();
  assert.equal(status.providers.find((p: { name: string }) => p.name === "GOOGLE").configured, false);
  assert.equal(status.providers.find((p: { name: string }) => p.name === "INTERNAL").configured, true);

  const cb = await hit(s, "/api/calendar/callback/google?code=abc&state=whatever");
  assert.equal(cb.status, 307);
  assert.match(cb.headers.get("location") ?? "", /\/settings\?calendarError=invalid_callback$/);
  const anon = await hit(null, "/api/calendar/callback/google?code=abc&state=x");
  assert.match(anon.headers.get("location") ?? "", /\/login$/);
});

// ---- HTTP: configured server (fake credentials) -------------------------------------------------------------------------
const cookiePair = (res: Response) => {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith("dl_cal_oauth="));
  return { raw, pair: raw?.split(";")[0] };
};

test("configured: connect redirects to Google with a random state and a signed HttpOnly cookie; the callback refuses every forged attempt", async () => {
  const s = await sessionFor("USER", "gcal7", BASE_G);
  const other = await sessionFor("USER", "gcal8", BASE_G);
  const r = await hit(s, "/api/calendar/connect/google", BASE_G);
  assert.equal(r.status, 307);
  const loc = new URL(r.headers.get("location")!);
  assert.equal(loc.origin + loc.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(loc.searchParams.get("client_id"), "test-client-id.apps.googleusercontent.com");
  assert.equal(loc.searchParams.get("redirect_uri"), "http://127.0.0.1:3213/api/calendar/callback/google");
  assert.equal(loc.searchParams.get("response_type"), "code");
  assert.equal(loc.searchParams.get("access_type"), "offline");
  assert.equal(loc.searchParams.get("prompt"), "consent");
  assert.ok((loc.searchParams.get("scope") ?? "").includes("auth/calendar"));
  const state = loc.searchParams.get("state")!;
  assert.ok(state.length >= 30 && !state.includes(s.userId), "random state, not the user id");
  assert.ok(!r.headers.get("location")!.includes("test-client-secret"), "the secret never leaves the server");
  const { raw, pair } = cookiePair(r);
  assert.ok(raw && /HttpOnly/i.test(raw) && /SameSite=lax/i.test(raw) && /Path=\/api\/calendar/i.test(raw) && /Max-Age=600/i.test(raw), raw);

  const refuse = async (who: Session, qs: string, cookie?: string, label = qs) => {
    const res = await hit(who, `/api/calendar/callback/google?${qs}`, BASE_G, cookie ? { cookie: `director_session=${who.cookie}; ${cookie}` } : {});
    assert.equal(res.status, 307, label);
    assert.match(res.headers.get("location") ?? "", /\/settings\?calendarError=invalid_callback$/, label);
    return res;
  };
  await refuse(s, `code=abc&state=${state}`, undefined, "no cookie");
  await refuse(s, `code=abc&state=${s.userId}`, pair, "the old scheme (state = user id)");
  await refuse(s, `code=abc&state=${state}x`, pair, "different state value");
  await refuse(other, `code=abc&state=${state}`, pair, "cookie issued to another user");
  await refuse(s, `code=abc&state=${state}`, pair!.replace(/.$/, (c) => (c === "A" ? "B" : "A")), "tampered cookie");
  assert.equal(await db.calendarConnection.count({ where: { userId: { in: [s.userId, other.userId] }, provider: "GOOGLE" } }), 0, "nothing was connected by any of them");

  // The user said no at Google: a clear code, the one-time cookie is cleared, nothing connected.
  const denied = await hit(s, `/api/calendar/callback/google?error=access_denied&state=${state}`, BASE_G, { cookie: `director_session=${s.cookie}; ${pair}` });
  assert.match(denied.headers.get("location") ?? "", /\/settings\?calendarError=access_denied$/);
  assert.match(denied.headers.getSetCookie().find((c) => c.startsWith("dl_cal_oauth=")) ?? "", /Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  // Provider error text is never put into the URL
  const odd = await hit(s, `/api/calendar/callback/google?error=%3Cscript%3Ealert(1)%3C/script%3E&state=${state}`, BASE_G, { cookie: `director_session=${s.cookie}; ${pair}` });
  assert.match(odd.headers.get("location") ?? "", /calendarError=connection_failed$/);
  assert.equal(await db.calendarConnection.count({ where: { userId: s.userId, provider: "GOOGLE" } }), 0);
});

test("a user without the calendar permission cannot start or finish a connection", async () => {
  const user = await createUser("USER", "gcal9");
  await db.user.update({ where: { id: user.id }, data: { permissions: JSON.stringify(["companies.view", "reports.viewOwn"]) } });
  const r = await login(user.email, STRONG_PASSWORD, BASE_G);
  const s: Session = { cookie: r.cookie!, userId: user.id, email: user.email };
  assert.equal((await hit(s, "/api/calendar/connect/google", BASE_G)).status, 403);
  const cb = await hit(s, "/api/calendar/callback/google?code=a&state=b", BASE_G);
  assert.match(cb.headers.get("location") ?? "", /calendarError=not_permitted$/);
});

// ---- Settings page, real browser -------------------------------------------------------------------------------------------
const chrome = findChrome();
test("Settings shows the right Google Calendar state, with fixed messages and no leaked details", { skip: chrome ? false : "Chrome is not installed", timeout: 240_000 }, async () => {
  const me = await sessionFor("USER", "gcalui");
  const page = await launchPage(9335);
  const text = () => page.eval<string>(`document.body.innerText`);
  const connectBtn = `[...document.querySelectorAll("button, a")].find((e) => e.textContent.trim() === "Connect")`;
  try {
    await page.setViewport(1440, 1000);
    // --- server WITHOUT Google credentials
    await page.goto(`${BASE}/login`);
    await page.type('input[type="email"]', me.email);
    await page.type('input[type="password"]', STRONG_PASSWORD);
    await page.eval(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Sign in")).click()`);
    await page.waitFor(`location.pathname !== "/login"`);
    await page.goto(`${BASE}/settings`);
    await page.waitFor(`document.body.innerText.includes("Internal DIRECTOR.LTD calendar")`);
    assert.match(await text(), /Google Calendar\s*Not configured on the server yet\. Ask a Super Admin to add the Google credentials\./);
    assert.equal(await page.eval<boolean>(`(${connectBtn}).tagName === "BUTTON" && (${connectBtn}).disabled`), true, "Connect is disabled until the server is configured");

    // --- server WITH (fake) credentials
    // (cookies are per host, not per port, and both servers share the session secret: the same sign-in works here)
    await page.goto(`${BASE_G}/settings`);
    await page.waitFor(`document.body.innerText.includes("Internal DIRECTOR.LTD calendar")`);
    assert.match(await text(), /Google Calendar\s*Not connected/);
    assert.match(await text(), /all-day events in a .DIRECTOR\.LTD Follow-ups. calendar in your own Google account/);
    assert.equal(await page.eval<string>(`(${connectBtn}).getAttribute("href")`), "/api/calendar/connect/google");
    assert.equal(await page.eval<boolean>(`!document.body.innerText.includes("test-client")`), true, "no credentials on the page");

    // fixed sentences for the callback codes, nothing from the URL echoed
    await page.goto(`${BASE_G}/settings?calendarError=invalid_callback`);
    await page.waitFor(`document.body.innerText.includes("could not be verified")`);
    await page.goto(`${BASE_G}/settings?calendarError=%3Cb%3Eevil%3C%2Fb%3E`);
    await page.waitFor(`document.body.innerText.includes("could not be connected")`);
    assert.equal(await page.eval<boolean>(`!document.body.innerText.includes("evil")`), true);
    await page.goto(`${BASE_G}/settings?calendarConnected=google`);
    await page.waitFor(`document.body.innerText.includes("Google Calendar connected.")`);
    assert.match(await text(), /open follow-ups are being added/);
  } finally {
    await page.close();
  }
});
