// What "Last automatic update" means for ONE report, in one place so every screen agrees.
//
//   not_scheduled - daily refresh is OFF: the scheduled job does not touch this report.
//   not_yet       - daily refresh is ON but the job has not successfully refreshed THIS report yet (for example it was
//                   created after the job last ran, or the only attempts failed). No date is shown, because none is true.
//   at            - the date the scheduled job last successfully refreshed this report (Report.lastAutoRefreshAt).
//
// It is deliberately NOT derived from the global "last daily job run", from when the report was created, or from
// Report.lastRunAt (which any recomputation - creation, edit, manual refresh - also writes).
export type AutoRefreshState = { kind: "not_scheduled" } | { kind: "not_yet" } | { kind: "at"; at: Date | string };

export function autoRefreshState(r: { dailyRefresh: boolean; lastAutoRefreshAt: Date | string | null | undefined }): AutoRefreshState {
  if (!r.dailyRefresh) return { kind: "not_scheduled" };
  if (!r.lastAutoRefreshAt) return { kind: "not_yet" };
  return { kind: "at", at: r.lastAutoRefreshAt };
}

export function autoRefreshText(state: AutoRefreshState, formatDate: (d: Date | string) => string): string {
  return state.kind === "not_scheduled" ? "Not scheduled" : state.kind === "not_yet" ? "Not yet updated" : formatDate(state.at);
}
