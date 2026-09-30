import { db } from "@/lib/db";
import type { CalendarConnection } from "@prisma/client";
import type { CalendarProvider } from "./types";
import { internalProvider } from "./providers/internal";
import { googleCalendarProvider, isGoogleCalendarConfigured } from "./providers/google";

const PROVIDERS: Record<string, CalendarProvider> = {
  INTERNAL: internalProvider,
  GOOGLE: googleCalendarProvider,
  // MICROSOFT: microsoftCalendarProvider — add here when built. Nothing
  // else in the app needs to change.
};

export function getProvider(name: string): CalendarProvider {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown calendar provider: ${name}`);
  return provider;
}

export function listAvailableProviders(): { name: string; configured: boolean }[] {
  return [
    { name: "INTERNAL", configured: true },
    { name: "GOOGLE", configured: isGoogleCalendarConfigured() },
  ];
}

// Resolves the provider + connection a user's follow-up syncing should use
// right now. Falls back to the always-on internal provider if nothing is
// connected or the connected provider is in an error state — never
// auto-switches to a *different external* provider without the user
// explicitly reconnecting.
export async function getActiveConnectionForUser(
  userId: string
): Promise<{ provider: CalendarProvider; connection: CalendarConnection }> {
  const connections = await db.calendarConnection.findMany({ where: { userId, status: "CONNECTED" } });
  const external = connections.find((c) => c.provider !== "INTERNAL");

  if (external) {
    return { provider: getProvider(external.provider), connection: external };
  }

  const internal = await db.calendarConnection.upsert({
    where: { userId_provider: { userId, provider: "INTERNAL" } },
    create: { userId, provider: "INTERNAL", status: "CONNECTED" },
    update: {},
  });
  return { provider: internalProvider, connection: internal };
}
