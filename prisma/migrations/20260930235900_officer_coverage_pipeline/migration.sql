-- Officer coverage pipeline: officer data state (none | full | unavailable),
-- dirty tracking, the officer sync queue, the shared Companies House quota
-- gate, persistent circuit breakers, request stats, and the partial indexes
-- needed for a ~5.6M-row Company table.
--
-- Schema-only apart from one no-op normalisation: the retired "partial"
-- coverage value (never written by any code path) becomes "none".

UPDATE "Company" SET "officersCoverage" = 'none' WHERE "officersCoverage" = 'partial';

-- DropIndex
DROP INDEX "Company_directorCount_idx";

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "officersDirtyAt" TIMESTAMP(3),
ADD COLUMN     "officersUnavailableReason" TEXT;

-- CreateTable
CREATE TABLE "OfficerSyncJob" (
    "companyId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "enqueuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHttpStatus" INTEGER,
    "lastError" TEXT,
    "leasedBy" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "parkedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfficerSyncJob_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "OfficerCrawlCursor" (
    "name" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'active',
    "lastId" TEXT,
    "passes" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfficerCrawlCursor_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "ChQuotaState" (
    "id" TEXT NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "windowEndsAt" TIMESTAMP(3) NOT NULL,
    "usedUser" INTEGER NOT NULL DEFAULT 0,
    "usedFiling" INTEGER NOT NULL DEFAULT 0,
    "usedStream" INTEGER NOT NULL DEFAULT 0,
    "usedRefresh" INTEGER NOT NULL DEFAULT 0,
    "usedBackfill" INTEGER NOT NULL DEFAULT 0,
    "headerRemaining" INTEGER,
    "headerResetAt" TIMESTAMP(3),
    "cooldownUntil" TIMESTAMP(3),
    "backgroundPausedUntil" TIMESTAMP(3),
    "last429At" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChQuotaState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChBreaker" (
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'closed',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "trips" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3),
    "openUntil" TIMESTAMP(3),
    "reason" TEXT,
    "lastStatus" INTEGER,
    "windowTotal" INTEGER NOT NULL DEFAULT 0,
    "windowFailures" INTEGER NOT NULL DEFAULT 0,
    "probeStartedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChBreaker_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "ChRequestStat" (
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "quotaClass" TEXT NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "ok" INTEGER NOT NULL DEFAULT 0,
    "status404" INTEGER NOT NULL DEFAULT 0,
    "status429" INTEGER NOT NULL DEFAULT 0,
    "statusAuth" INTEGER NOT NULL DEFAULT 0,
    "status5xx" INTEGER NOT NULL DEFAULT 0,
    "networkErrors" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ChRequestStat_pkey" PRIMARY KEY ("bucketStart","quotaClass")
);

-- CreateIndex
CREATE INDEX "ChRequestStat_bucketStart_idx" ON "ChRequestStat"("bucketStart");

-- AddForeignKey
ALTER TABLE "OfficerSyncJob" ADD CONSTRAINT "OfficerSyncJob_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Partial indexes (Prisma cannot express these; same approach as the init
-- migration). Predicates use literals so the planner can prove them.
-- ---------------------------------------------------------------------------

-- Background crawl: eligible = real company with no officer data. Active
-- companies are walked first, so they get their own index; both are keyset
-- (id > cursor ORDER BY id), never OFFSET.
CREATE INDEX "Company_officers_crawl_active_idx" ON "Company" ("id")
  WHERE "officersCoverage" = 'none' AND "source" <> 'seed' AND "status" = 'active';
CREATE INDEX "Company_officers_crawl_other_idx" ON "Company" ("id")
  WHERE "officersCoverage" = 'none' AND "source" <> 'seed' AND "status" <> 'active';

-- Freshness: companies flagged dirty by an officer filing, the TTL sweep over
-- confirmed data, and the re-check sweep over unavailable data.
CREATE INDEX "Company_officers_dirty_idx" ON "Company" ("officersDirtyAt")
  WHERE "officersDirtyAt" IS NOT NULL;
CREATE INDEX "Company_officers_full_fetched_idx" ON "Company" ("officersFetchedAt")
  WHERE "officersCoverage" = 'full';
CREATE INDEX "Company_officers_unavailable_fetched_idx" ON "Company" ("officersFetchedAt")
  WHERE "officersCoverage" = 'unavailable';

-- Director filters only ever evaluate confirmed (full) rows, so these replace
-- the plain directorCount index dropped above with much smaller indexes.
CREATE INDEX "Company_directorCount_full_idx" ON "Company" ("directorCount")
  WHERE "officersCoverage" = 'full';
CREATE INDEX "Company_singleDirector_full_idx" ON "Company" ("id")
  WHERE "officersCoverage" = 'full' AND "singleDirector";

-- Officer queue: claim order, lease expiry, parked listing.
CREATE INDEX "OfficerSyncJob_claim_idx" ON "OfficerSyncJob" ("priority", "nextAttemptAt")
  WHERE "status" IN ('queued', 'retry');
CREATE INDEX "OfficerSyncJob_lease_idx" ON "OfficerSyncJob" ("leaseUntil")
  WHERE "status" = 'leased';
CREATE INDEX "OfficerSyncJob_parked_idx" ON "OfficerSyncJob" ("parkedAt")
  WHERE "status" = 'parked';
