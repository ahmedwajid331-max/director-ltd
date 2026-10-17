// Reporting periods in ONE configured timezone (APP_TIMEZONE, default Europe/London). Days are calendar days in that
// zone, weeks run Monday to Sunday, and every range is half-open [from, to) in real instants, so an event at 00:00:00
// local belongs to the new day and nothing is counted twice or dropped across midnight or a clock change.

export type PeriodKind = "day" | "week" | "month" | "year" | "custom";
export const PERIOD_KINDS: PeriodKind[] = ["day", "week", "month", "year", "custom"];
export const MAX_CUSTOM_DAYS = 400;

export function appTimezone(): string {
  const tz = process.env.APP_TIMEZONE?.trim() || "Europe/London";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz;
  } catch {
    return "Europe/London";
  }
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isYmd(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = YMD.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function parseYmd(s: string): [number, number, number] {
  const m = YMD.exec(s)!;
  return [+m[1], +m[2], +m[3]];
}

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = parseYmd(ymd);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Offset (ms) of `tz` from UTC at a given instant.
function offsetMs(instant: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(instant));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

// The instant at which calendar day `ymd` begins in `tz`.
export function startOfDay(ymd: string, tz: string): Date {
  const [y, m, d] = parseYmd(ymd);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetMs(guess, tz);
  t = guess - offsetMs(t, tz); // re-check: the offset may differ at the corrected instant (clock change)
  return new Date(t);
}

// The calendar day (YYYY-MM-DD) an instant falls on in `tz`.
export function dayKey(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
  return parts; // en-CA formats as YYYY-MM-DD
}

function weekdayMonday0(ymd: string): number {
  const [y, m, d] = parseYmd(ymd);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
}

export interface ResolvedPeriod {
  kind: PeriodKind;
  from: Date; // inclusive
  to: Date; // exclusive
  fromDay: string;
  toDay: string; // last day INCLUDED
  label: string;
  days: string[]; // every calendar day in the period (tz)
  previous: { from: Date; to: Date; label: string } | null; // same-length period immediately before (null for custom ranges over the limit)
  tz: string;
}

export type PeriodInput = { kind?: string; anchor?: string; from?: string; to?: string };
export type PeriodResult = { ok: true; period: ResolvedPeriod } | { ok: false; error: string };

const fmtDay = (ymd: string, tz: string) => startOfDay(ymd, tz).toLocaleDateString("en-GB", { timeZone: tz, day: "2-digit", month: "short", year: "numeric" });

export function resolvePeriod(input: PeriodInput, now: Date = new Date(), tz: string = appTimezone()): PeriodResult {
  return resolve(input, now, tz, true);
}

function resolve(input: PeriodInput, now: Date, tz: string, withPrevious: boolean): PeriodResult {
  const kind = (PERIOD_KINDS as string[]).includes(input.kind ?? "") ? (input.kind as PeriodKind) : "week";
  const today = dayKey(now, tz);
  const anchor = input.anchor === undefined ? today : input.anchor;
  if (!isYmd(anchor)) return { ok: false, error: "The date is not valid." };

  let fromDay: string;
  let toDayExclusive: string;
  if (kind === "day") {
    fromDay = anchor;
    toDayExclusive = addDays(anchor, 1);
  } else if (kind === "week") {
    fromDay = addDays(anchor, -weekdayMonday0(anchor));
    toDayExclusive = addDays(fromDay, 7);
  } else if (kind === "month") {
    const [y, m] = parseYmd(anchor);
    fromDay = `${y}-${String(m).padStart(2, "0")}-01`;
    toDayExclusive = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  } else if (kind === "year") {
    const [y] = parseYmd(anchor);
    fromDay = `${y}-01-01`;
    toDayExclusive = `${y + 1}-01-01`;
  } else {
    if (!isYmd(input.from) || !isYmd(input.to)) return { ok: false, error: "Choose a start and an end date." };
    if (input.to < input.from) return { ok: false, error: "The end date is before the start date." };
    fromDay = input.from;
    toDayExclusive = addDays(input.to, 1);
  }

  const days: string[] = [];
  for (let d = fromDay; d < toDayExclusive; d = addDays(d, 1)) {
    days.push(d);
    if (days.length > MAX_CUSTOM_DAYS) return { ok: false, error: `Choose a range of at most ${MAX_CUSTOM_DAYS} days.` };
  }

  const from = startOfDay(fromDay, tz);
  const to = startOfDay(toDayExclusive, tz);
  const toDay = addDays(toDayExclusive, -1);

  let previous: ResolvedPeriod["previous"] = null;
  if (!withPrevious) {
    previous = null;
  } else if (kind === "month" || kind === "year") {
    // The calendar month / year before (not "the same number of days": February is shorter than January).
    const p = resolve({ kind, anchor: addDays(fromDay, -1) }, now, tz, false);
    if (p.ok) previous = { from: p.period.from, to: p.period.to, label: p.period.label };
  } else {
    const len = days.length;
    const pFrom = addDays(fromDay, -len);
    previous = { from: startOfDay(pFrom, tz), to: from, label: len === 1 ? fmtDay(pFrom, tz) : `${fmtDay(pFrom, tz)} - ${fmtDay(addDays(fromDay, -1), tz)}` };
  }

  const label =
    kind === "day" ? fmtDay(fromDay, tz) : kind === "month" ? new Date(from).toLocaleDateString("en-GB", { timeZone: tz, month: "long", year: "numeric" }) : kind === "year" ? fromDay.slice(0, 4) : `${fmtDay(fromDay, tz)} - ${fmtDay(toDay, tz)}`;

  return { ok: true, period: { kind, from, to, fromDay, toDay, label, days, previous, tz } };
}
