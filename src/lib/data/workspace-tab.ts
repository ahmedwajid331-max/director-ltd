// Tabs of the company workspace. Plain module (no "use client") so both the server page and the client UI can use it.
export type WorkspaceTab = "overview" | "notes" | "contacts" | "followups" | "activity";
export const WORKSPACE_TABS: WorkspaceTab[] = ["overview", "notes", "contacts", "followups", "activity"];

export function parseWorkspaceTab(value: string | undefined): WorkspaceTab {
  return WORKSPACE_TABS.includes(value as WorkspaceTab) ? (value as WorkspaceTab) : "overview";
}
