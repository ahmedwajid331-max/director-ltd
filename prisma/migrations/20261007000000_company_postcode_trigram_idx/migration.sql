-- Search box (name / company number / postcode, OR-ed together) could not use any index for the postcode
-- branch, so every search fell back to a sequential scan of the whole register (about 5 s at 5.69M rows).
-- With this trigram index PostgreSQL combines the three trigram indexes (BitmapOr): 15-250 ms.
-- Additive only: one new index, no table or data change. (pg_trgm is already installed for the other trigram indexes.)
-- Note: a plain CREATE INDEX blocks writes to "Company" while it builds (about 50 s at 5.69M rows, under a second at 100k).
CREATE INDEX "Company_registeredPostcode_trgm_idx" ON "Company" USING gin ("registeredPostcode" gin_trgm_ops);
