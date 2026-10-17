// Pay arithmetic in integer minor units (pence / cents) - never floating point money.
// Pay is ALWAYS approvedMinutes x the configured rate. Login or session time never feeds into it.

export const CURRENCIES = ["GBP", "USD", "EUR"] as const;
export type Currency = (typeof CURRENCIES)[number];
export const MAX_RATE_MINOR = 100_000_00; // 100,000.00 per hour: a typo guard, not a business rule

export function isCurrency(c: unknown): c is Currency {
  return typeof c === "string" && (CURRENCIES as readonly string[]).includes(c);
}

// Rounded to the nearest minor unit, half up. 90 min at 20.00/h = 30.00.
export function payAmountMinor(approvedMinutes: number, rateMinorPerHour: number): number {
  if (!Number.isInteger(approvedMinutes) || approvedMinutes < 0 || !Number.isInteger(rateMinorPerHour) || rateMinorPerHour < 0) throw new RangeError("minutes and rate must be non-negative integers");
  return Math.floor((approvedMinutes * rateMinorPerHour + 30) / 60);
}

export function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100);
}

// "20", "20.5", "20.50" -> 2000 / 2050 / 2050. Returns null for anything else (no silent rounding of typos).
export function parseRateToMinor(input: string): number | null {
  const m = /^\s*(\d{1,6})(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!m) return null;
  const minor = Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, "0")) : 0);
  return minor <= MAX_RATE_MINOR ? minor : null;
}

export function formatHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}
