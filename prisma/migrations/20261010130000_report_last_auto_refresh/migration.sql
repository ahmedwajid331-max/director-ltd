-- Per-report timestamp of the last SUCCESSFUL automatic (scheduled) refresh. Nullable and unset for existing rows, so no
-- history is rewritten or invented: a report shows "Not yet updated" until the daily job next refreshes it.
ALTER TABLE "Report" ADD COLUMN "lastAutoRefreshAt" TIMESTAMP(3);
