import { db } from "@/lib/db";

// Database-backed login throttling (shared by every app instance). Three
// independent limits, so no single trick defeats all of them:
//   - per account + IP : LOGIN_MAX_ATTEMPTS_PER_ACCOUNT failures / 15 min (default 8)
//   - per account only : LOGIN_MAX_ATTEMPTS_PER_ACCOUNT_GLOBAL / 15 min (default 30) - holds even if the
//                        attacker rotates IPs or spoofs X-Forwarded-For
//   - per IP           : LOGIN_MAX_ATTEMPTS_PER_IP failures / 15 min (default 40) - only when the client IP is trusted
// X-Forwarded-For is honoured ONLY when TRUST_PROXY=1 (set it when the app runs behind a load
// balancer that overwrites the header); otherwise it is ignored and every client shares the
// "direct" bucket, so the per-account limits are what protect an account.
// A successful login clears that account's counters. The caller must return the same generic
// message whether or not the account exists.
const WINDOW_MS = 15 * 60 * 1000;

function limit(envName: string, fallback: number): number {
  const n = Number(process.env[envName]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const acctKey = (email: string, ip: string) => `acct:${email}|${ip}`;
const acctGlobalKey = (email: string) => `acctg:${email}`;
const ipKey = (ip: string) => `ip:${ip}`;

export function clientIp(request: Request): string {
  if (process.env.TRUST_PROXY !== "1") return "direct";
  const fwd = request.headers.get("x-forwarded-for");
  // Behind a load balancer the right-most entry is the one the balancer itself appended.
  const parts = fwd?.split(",").map((p) => p.trim()).filter(Boolean) ?? [];
  return (parts[parts.length - 1] ?? request.headers.get("x-real-ip") ?? "unknown").trim() || "unknown";
}

export async function isLoginBlocked(email: string, ip: string): Promise<{ blocked: boolean; retryAfterSeconds: number }> {
  const since = new Date(Date.now() - WINDOW_MS);
  const countFor = (key: string) => db.loginAttempt.count({ where: { key, createdAt: { gt: since } } });
  const trustIp = process.env.TRUST_PROXY === "1";
  const [acct, acctGlobal, byIp, oldest] = await Promise.all([
    countFor(acctKey(email, ip)),
    countFor(acctGlobalKey(email)),
    trustIp ? countFor(ipKey(ip)) : Promise.resolve(0),
    db.loginAttempt.findFirst({ where: { key: acctGlobalKey(email), createdAt: { gt: since } }, orderBy: { createdAt: "asc" } }),
  ]);
  const blocked =
    acct >= limit("LOGIN_MAX_ATTEMPTS_PER_ACCOUNT", 8) ||
    acctGlobal >= limit("LOGIN_MAX_ATTEMPTS_PER_ACCOUNT_GLOBAL", 30) ||
    byIp >= limit("LOGIN_MAX_ATTEMPTS_PER_IP", 40);
  const retryAfterSeconds = blocked
    ? Math.max(1, Math.ceil(((oldest?.createdAt.getTime() ?? Date.now()) + WINDOW_MS - Date.now()) / 1000))
    : 0;
  return { blocked, retryAfterSeconds };
}

export async function recordFailedLogin(email: string, ip: string) {
  await db.loginAttempt.createMany({ data: [{ key: acctKey(email, ip) }, { key: acctGlobalKey(email) }, { key: ipKey(ip) }] });
  // Opportunistic pruning keeps the table tiny without a scheduled job.
  await db.loginAttempt.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 2 * WINDOW_MS) } } });
}

export async function clearFailedLogins(email: string, ip: string) {
  await db.loginAttempt.deleteMany({ where: { key: { in: [acctKey(email, ip), acctGlobalKey(email)] } } });
}
