-- City / town is now its own sortable column in the results table (separate from the postcode). Sorting 5.69M rows by
-- "registeredCity" had no btree index to walk (City A-Z took ~50 s, Z-A 6-46 s); the postcode column already has the
-- equivalent index. Additive only: one new index, no table or data change.
-- IF NOT EXISTS so it is a no-op where the index was already built online with CREATE INDEX CONCURRENTLY
-- (a plain CREATE INDEX blocks writes to "Company" while it builds, about a minute at 5.69M rows).
CREATE INDEX IF NOT EXISTS "Company_registeredCity_idx" ON "Company"("registeredCity");
