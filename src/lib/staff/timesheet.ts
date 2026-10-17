import { payAmountMinor } from "./money";

// Timesheet rules and the payable-amount breakdown. Pure functions, unit-tested.
//
// Five different numbers are kept apart everywhere they are shown:
//   session time (elapsed, from sign-in records)  ·  recorded actions (events in DIRECTOR.LTD)
//   claimed minutes (the staff member's claim)    ·  approved minutes (a reviewer's decision)
//   calculated pay (approved minutes x the rate captured when they were approved).
// Only APPROVED minutes ever reach a pay figure. Submitted, returned and rejected sheets contribute nothing.

export type TimesheetStatus = "submitted" | "approved" | "rejected" | "returned";

export const TIMESHEET_STATUS_LABEL: Record<string, string> = {
  submitted: "Waiting for approval",
  approved: "Approved",
  rejected: "Rejected",
  returned: "Returned for correction",
};

// A person may (re)submit a day unless it is approved. Corrections to an approved day go through the reviewer's amend action.
export function canResubmit(status: string): boolean {
  return status !== "approved";
}

export interface ApprovedSheet {
  userId: string;
  status: string;
  approvedMinutes: number | null;
  rateMinorAtApproval: number | null;
  rateCurrencyAtApproval: string | null;
}

export interface PayLine {
  userId: string;
  currency: string | null; // null: approved before a rate was set
  rateMinor: number | null;
  approvedMinutes: number;
  amountMinor: number | null; // null when there was no rate: not zero, unknown
}

// One line per person per distinct (rate, currency): a rate change mid-period gives two lines, each at the rate that
// applied when those hours were approved. The amount is rounded once per line, so "hours x rate = amount" holds exactly.
export function payLines(sheets: ApprovedSheet[]): PayLine[] {
  const map = new Map<string, PayLine>();
  for (const s of sheets) {
    if (s.status !== "approved" || s.approvedMinutes === null) continue;
    const key = `${s.userId}|${s.rateMinorAtApproval ?? "none"}|${s.rateCurrencyAtApproval ?? ""}`;
    const line = map.get(key) ?? { userId: s.userId, currency: s.rateMinorAtApproval === null ? null : s.rateCurrencyAtApproval, rateMinor: s.rateMinorAtApproval, approvedMinutes: 0, amountMinor: null };
    line.approvedMinutes += s.approvedMinutes;
    map.set(key, line);
  }
  const lines = [...map.values()];
  for (const l of lines) l.amountMinor = l.rateMinor === null ? null : payAmountMinor(l.approvedMinutes, l.rateMinor);
  return lines;
}

export interface CurrencyTotal {
  currency: string;
  approvedMinutes: number;
  amountMinor: number;
}

// Totals per currency. Different currencies are never added together, and hours approved without a rate are reported
// separately rather than priced at zero.
export function totalsByCurrency(lines: PayLine[]): { byCurrency: CurrencyTotal[]; unratedMinutes: number } {
  const totals = new Map<string, CurrencyTotal>();
  let unratedMinutes = 0;
  for (const l of lines) {
    if (l.amountMinor === null || l.currency === null) {
      unratedMinutes += l.approvedMinutes;
      continue;
    }
    const t = totals.get(l.currency) ?? { currency: l.currency, approvedMinutes: 0, amountMinor: 0 };
    t.approvedMinutes += l.approvedMinutes;
    t.amountMinor += l.amountMinor;
    totals.set(l.currency, t);
  }
  return { byCurrency: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)), unratedMinutes };
}

export interface EvidenceInput {
  claimedMinutes: number;
  sessionMs: number; // elapsed session time that day (not working time)
  recordedActions: number; // meaningful recorded actions that day
}

// Plain-language flags where the claim and the recorded evidence disagree. They prompt a closer look; they never decide
// anything. Absence of recorded actions does not prove no work was done (offline calls, research elsewhere).
export function evidenceWarnings(e: EvidenceInput): string[] {
  const out: string[] = [];
  const claimedMs = e.claimedMinutes * 60_000;
  if (e.sessionMs === 0) out.push("No session recorded that day");
  else if (e.sessionMs < claimedMs * 0.5) out.push("Session time is well below the claim");
  if (e.recordedActions === 0) out.push("No recorded actions that day");
  return out;
}
