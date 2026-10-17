-- Backfill the indexed company / report links on activity rows written before those columns existed.
-- Those rows kept the ids only inside their JSON "meta" text, so staff reports counted zero companies worked for all
-- history. This copies the id out of meta into the new column. It changes nothing else: only rows where the column is
-- still NULL are touched, nothing is deleted, and re-running it is a no-op.
UPDATE "ActivityLog"
SET "companyId" = substring("meta" FROM '"companyId":"([^"]+)"')
WHERE "companyId" IS NULL
  AND "meta" IS NOT NULL
  AND "meta" LIKE '%"companyId":"%';

UPDATE "ActivityLog"
SET "reportId" = substring("meta" FROM '"reportId":"([^"]+)"')
WHERE "reportId" IS NULL
  AND "meta" IS NOT NULL
  AND "meta" LIKE '%"reportId":"%';
