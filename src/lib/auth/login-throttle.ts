import { db } from "@/lib/db";

// Database-backed login throttling (shared by every app instance).
// Two independent limits so neither a single noisy IP nor a distributed
// attack on one account goes unchecked:
//   - per account+IP : LOGIN_MAX_ATTEMPTS_PER_ACCOUNT failures / 15 min (default 8)
//   - per IP         : LOGIN_MAX_ATTEMPTS_PER_IP failures / 15 min (default 40)
// A successful login clears the account+IP counter. The caller must return
// the same generic message whether or not the account exists.
const WINDOW_MS = 15 * 60 * 1000;

function limit(envName: string, fallback: number): number {
  const n = Number(process.env[envName]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const acctKey = (email: string, ip: string) => `acct:${email}|${ip}`;
const ipKey = (ip: string) => `ip:${ip}`;

export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  // Behind a load balancer the left-most entry is the original client.
  return (fwd?.split(",")[0] ?? request.headers.get("x-real-ip") ?? "unknown").trim() || "unknown";
}

export async function isLoginBlocked(email: string, ip: string): Promise<{ blocked: boolean; retryAfterSeconds: number }> {
  const since = new Date(Date.now() - WINDOW_MS);
  const [acct, byIp, oldest] = await Promise.all([
    db.loginAttempt.count({ where: { key: acctKey(email, ip), createdAt: { gt: since } } }),
    db.loginAttempt.count({ where: { key: ipKey(ip), createdAt: { gt: since } } }),
    db.loginAttempt.findFirst({
      where: { key: acctKey(email, ip), createdAt: { gt: since } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const blocked = acct >= limit("LOGIN_MAX_ATTEMPTS_PER_ACCOUNT", 8) || byIp >= limit("LOGIN_MAX_ATTEMPTS_PER_IP", 40);
  const retryAfterSeconds = blocked
    ? Math.max(1, Math.ceil(((oldest?.createdAt.getTime() ?? Date.now()) + WINDOW_MS - Date.now()) / 1000))
    : 0;
  return { blocked, retryAfterSeconds };
}

export async function recordFailedLogin(email: string, ip: string) {
  await db.loginAttempt.createMany({ data: [{ key: acctKey(email, ip) }, { key: ipKey(ip) }] });
  // Opportunistic pruning keeps the table tiny without a scheduled job.
  await db.loginAttempt.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 2 * WINDOW_MS) } } });
}

export async function clearFailedLogins(email: string, ip: string) {
  await db.loginAttempt.deleteMany({ where: { key: acctKey(email, ip) } });
}
