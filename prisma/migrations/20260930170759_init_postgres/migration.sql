-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "companyNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "incorporationDate" DATE NOT NULL,
    "dissolutionDate" DATE,
    "dormant" BOOLEAN NOT NULL DEFAULT false,
    "sicCodes" TEXT NOT NULL DEFAULT '',
    "registeredAddress1" TEXT NOT NULL,
    "registeredAddress2" TEXT,
    "registeredCity" TEXT NOT NULL,
    "registeredPostcode" TEXT NOT NULL,
    "registeredCounty" TEXT,
    "accountsNextDue" DATE,
    "accountsLastMadeUp" DATE,
    "accountsOverdue" BOOLEAN NOT NULL DEFAULT false,
    "confirmationNextDue" DATE,
    "confirmationLastMadeUp" DATE,
    "confirmationOverdue" BOOLEAN NOT NULL DEFAULT false,
    "hasDS01" BOOLEAN NOT NULL DEFAULT false,
    "ds01FiledAt" DATE,
    "directorCount" INTEGER NOT NULL DEFAULT 0,
    "singleDirector" BOOLEAN NOT NULL DEFAULT false,
    "statusDetail" TEXT,
    "accountType" TEXT,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "chLastFetchedAt" TIMESTAMP(3),
    "officersCoverage" TEXT NOT NULL DEFAULT 'none',
    "officersFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Director" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'director',
    "appointedOn" DATE,
    "resignedOn" DATE,
    "nationality" TEXT,
    "occupation" TEXT,
    "officerId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Director_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmContact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'contact',
    "email" TEXT,
    "phone" TEXT,
    "occupation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilingEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "companyNumber" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "date" TEXT,
    "description" TEXT,
    "resourceUri" TEXT,
    "timepoint" BIGINT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applyStatus" TEXT NOT NULL DEFAULT 'pending',
    "appliedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "FilingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StreamCheckpoint" (
    "name" TEXT NOT NULL,
    "timepoint" BIGINT NOT NULL,
    "lastEventAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StreamCheckpoint_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "IngestionRun" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "inputName" TEXT,
    "inputFingerprint" TEXT,
    "rowsRead" INTEGER NOT NULL DEFAULT 0,
    "rowsInserted" INTEGER NOT NULL DEFAULT 0,
    "rowsUpdated" INTEGER NOT NULL DEFAULT 0,
    "rowsSkipped" INTEGER NOT NULL DEFAULT 0,
    "rowsFailed" INTEGER NOT NULL DEFAULT 0,
    "rowsProcessed" INTEGER NOT NULL DEFAULT 0,
    "checkpoint" TEXT,
    "errorMessage" TEXT,
    "errorSamples" TEXT,
    "statsJson" TEXT,

    CONSTRAINT "IngestionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCompanyState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "followed" BOOLEAN NOT NULL DEFAULT false,
    "trashed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCompanyState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "userCompanyStateId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUp" (
    "id" TEXT NOT NULL,
    "userCompanyStateId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "note" TEXT,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "accountEmail" TEXT,
    "calendarId" TEXT,
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" TEXT NOT NULL,
    "followUpId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncStatus" TEXT NOT NULL DEFAULT 'synced',

    CONSTRAINT "CalendarEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "filterJson" TEXT NOT NULL,
    "columnsJson" TEXT,
    "sortJson" TEXT,
    "dailyRefresh" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastRefreshError" TEXT,
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "meta" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "LoginAttempt_key_createdAt_idx" ON "LoginAttempt"("key", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Company_companyNumber_key" ON "Company"("companyNumber");

-- CreateIndex
CREATE INDEX "Company_status_idx" ON "Company"("status");

-- CreateIndex
CREATE INDEX "Company_type_idx" ON "Company"("type");

-- CreateIndex
CREATE INDEX "Company_registeredPostcode_idx" ON "Company"("registeredPostcode");

-- CreateIndex
CREATE INDEX "Company_incorporationDate_idx" ON "Company"("incorporationDate");

-- CreateIndex
CREATE INDEX "Company_directorCount_idx" ON "Company"("directorCount");

-- CreateIndex
CREATE INDEX "Company_source_idx" ON "Company"("source");

-- CreateIndex
CREATE INDEX "Director_companyId_idx" ON "Director"("companyId");

-- CreateIndex
CREATE INDEX "Director_officerId_idx" ON "Director"("officerId");

-- CreateIndex
CREATE INDEX "CrmContact_userId_companyId_idx" ON "CrmContact"("userId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "FilingEvent_transactionId_key" ON "FilingEvent"("transactionId");

-- CreateIndex
CREATE INDEX "FilingEvent_companyNumber_idx" ON "FilingEvent"("companyNumber");

-- CreateIndex
CREATE INDEX "FilingEvent_type_idx" ON "FilingEvent"("type");

-- CreateIndex
CREATE INDEX "FilingEvent_applyStatus_type_idx" ON "FilingEvent"("applyStatus", "type");

-- CreateIndex
CREATE INDEX "IngestionRun_kind_startedAt_idx" ON "IngestionRun"("kind", "startedAt");

-- CreateIndex
CREATE INDEX "IngestionRun_status_idx" ON "IngestionRun"("status");

-- CreateIndex
CREATE INDEX "UserCompanyState_userId_followed_idx" ON "UserCompanyState"("userId", "followed");

-- CreateIndex
CREATE INDEX "UserCompanyState_userId_trashed_idx" ON "UserCompanyState"("userId", "trashed");

-- CreateIndex
CREATE UNIQUE INDEX "UserCompanyState_userId_companyId_key" ON "UserCompanyState"("userId", "companyId");

-- CreateIndex
CREATE INDEX "Note_userCompanyStateId_idx" ON "Note"("userCompanyStateId");

-- CreateIndex
CREATE INDEX "FollowUp_userCompanyStateId_idx" ON "FollowUp"("userCompanyStateId");

-- CreateIndex
CREATE INDEX "FollowUp_userId_dueDate_idx" ON "FollowUp"("userId", "dueDate");

-- CreateIndex
CREATE INDEX "CalendarConnection_userId_idx" ON "CalendarConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarConnection_userId_provider_key" ON "CalendarConnection"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEvent_followUpId_key" ON "CalendarEvent"("followUpId");

-- CreateIndex
CREATE INDEX "CalendarEvent_provider_idx" ON "CalendarEvent"("provider");

-- CreateIndex
CREATE INDEX "Report_ownerId_idx" ON "Report"("ownerId");

-- CreateIndex
CREATE INDEX "ActivityLog_userId_createdAt_idx" ON "ActivityLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_action_idx" ON "ActivityLog"("action");

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Director" ADD CONSTRAINT "Director_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmContact" ADD CONSTRAINT "CrmContact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmContact" ADD CONSTRAINT "CrmContact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilingEvent" ADD CONSTRAINT "FilingEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCompanyState" ADD CONSTRAINT "UserCompanyState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCompanyState" ADD CONSTRAINT "UserCompanyState_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_userCompanyStateId_fkey" FOREIGN KEY ("userCompanyStateId") REFERENCES "UserCompanyState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_userCompanyStateId_fkey" FOREIGN KEY ("userCompanyStateId") REFERENCES "UserCompanyState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarConnection" ADD CONSTRAINT "CalendarConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_followUpId_fkey" FOREIGN KEY ("followUpId") REFERENCES "FollowUp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written performance objects (Prisma cannot express these).
-- Sized for the ~5.6M-row Companies House register.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Case-insensitive "contains" on company name / number / town (ILIKE '%x%').
CREATE INDEX "Company_name_trgm_idx" ON "Company" USING gin ("name" gin_trgm_ops);
CREATE INDEX "Company_companyNumber_trgm_idx" ON "Company" USING gin ("companyNumber" gin_trgm_ops);
CREATE INDEX "Company_registeredCity_trgm_idx" ON "Company" USING gin ("registeredCity" gin_trgm_ops);
CREATE INDEX "Company_sicCodes_trgm_idx" ON "Company" USING gin ("sicCodes" gin_trgm_ops);

-- Postcode prefix search (postcodes are stored upper-case; filters upper-case the term).
CREATE INDEX "Company_registeredPostcode_prefix_idx" ON "Company" ("registeredPostcode" text_pattern_ops);
CREATE INDEX "Company_name_sort_idx" ON "Company" ("name", "id");

-- Partial indexes for the boolean report filters (only the TRUE side is ever a small set).
CREATE INDEX "Company_hasDS01_partial_idx" ON "Company" ("name", "id") WHERE "hasDS01";
CREATE INDEX "Company_dormant_partial_idx" ON "Company" ("name", "id") WHERE "dormant";
CREATE INDEX "Company_singleDirector_partial_idx" ON "Company" ("name", "id") WHERE "singleDirector";
CREATE INDEX "Company_accountsOverdue_partial_idx" ON "Company" ("name", "id") WHERE "accountsOverdue";
CREATE INDEX "Company_confirmationOverdue_partial_idx" ON "Company" ("name", "id") WHERE "confirmationOverdue";
