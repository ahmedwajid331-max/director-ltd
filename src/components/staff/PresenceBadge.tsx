import { StatusPill } from "@/components/admin/AdminUi";
import { presenceLabel, type PresenceStatus } from "@/lib/staff/stats";

const TONE: Record<PresenceStatus, "green" | "amber" | "red" | "blue" | "slate"> = {
  active: "green",
  idle: "amber",
  unresolved: "slate",
  ended: "slate",
  expired: "slate",
  never: "slate",
  untracked: "slate",
};

// A session state, never a claim about work: "Recently active" means a request was seen a few minutes ago; "No logout
// recorded" means nothing was seen for a while and the person did not sign out (browser closed, device asleep, network).
export function PresenceBadge({ status }: { status: PresenceStatus }) {
  return (
    <span title={status === "untracked" ? "This person has signed in, but before session tracking began, so no session was recorded. It resolves the next time they sign in." : undefined}>
      <StatusPill tone={TONE[status]}>{presenceLabel(status)}</StatusPill>
    </span>
  );
}
