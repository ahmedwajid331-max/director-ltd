-- Additive only: nullable demand timestamps on the shared quota row and an
-- append-only diagnostics table. No existing data is changed.
ALTER TABLE "ChQuotaState" ADD COLUMN "demandUserAt" TIMESTAMP(3),
ADD COLUMN "demandFilingAt" TIMESTAMP(3),
ADD COLUMN "demandStreamAt" TIMESTAMP(3),
ADD COLUMN "demandRefreshAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ChQuotaEvent" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "quotaClass" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL,
    "httpStatus" INTEGER,
    "waitMs" INTEGER,
    "usedTotal" INTEGER,
    "usedClass" INTEGER,
    "headerRemaining" INTEGER,
    "windowStartedAt" TIMESTAMP(3),
    "windowEndsAt" TIMESTAMP(3),
    "headerResetAt" TIMESTAMP(3),

    CONSTRAINT "ChQuotaEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChQuotaEvent_at_idx" ON "ChQuotaEvent"("at");
