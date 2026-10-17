-- Additive only: a new audit table for the bulk importer. No existing table changes.
CREATE TABLE "IngestRowFailure" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "companyNumber" TEXT,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "retryState" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "rawJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "IngestRowFailure_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IngestRowFailure_runId_rowNumber_key" ON "IngestRowFailure"("runId", "rowNumber");
CREATE INDEX "IngestRowFailure_runId_retryState_idx" ON "IngestRowFailure"("runId", "retryState");
CREATE INDEX "IngestRowFailure_companyNumber_idx" ON "IngestRowFailure"("companyNumber");
