-- Column & Default Settings: new tables only. Nothing on "Company" changes.

CREATE TABLE "ColumnFieldSetting" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "ColumnFieldSetting_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "ColumnLayout" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "columnsJson" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "ColumnLayout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ColumnLayout_name_key" ON "ColumnLayout"("name");

-- At most one default layout (Prisma cannot express a partial unique index).
CREATE UNIQUE INDEX "ColumnLayout_one_default_idx" ON "ColumnLayout" ("isDefault") WHERE "isDefault";

CREATE TABLE "UserColumnPreference" (
    "userId" TEXT NOT NULL,
    "columnsJson" TEXT NOT NULL,
    "baseLayoutId" TEXT,
    "baseLayoutVersion" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserColumnPreference_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "UserColumnPreference" ADD CONSTRAINT "UserColumnPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
