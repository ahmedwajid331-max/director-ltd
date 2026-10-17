-- Per-user Saved and Red Flag company state. Additive only: two NOT NULL
-- boolean columns defaulting to false (existing rows keep all current state)
-- plus lookup indexes.
-- Rollback: DROP INDEX "UserCompanyState_userId_saved_idx", "UserCompanyState_userId_redFlagged_idx";
--           ALTER TABLE "UserCompanyState" DROP COLUMN "saved", DROP COLUMN "redFlagged";

-- AlterTable
ALTER TABLE "UserCompanyState" ADD COLUMN     "redFlagged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "saved" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "UserCompanyState_userId_saved_idx" ON "UserCompanyState"("userId", "saved");

-- CreateIndex
CREATE INDEX "UserCompanyState_userId_redFlagged_idx" ON "UserCompanyState"("userId", "redFlagged");
