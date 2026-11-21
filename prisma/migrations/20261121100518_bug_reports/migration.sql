-- CreateTable
CREATE TABLE "BugReportGrant" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BugReportGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BugReport" (
    "id" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "includeReplay" BOOLEAN NOT NULL,
    "clientSubmittedAt" TIMESTAMP(3) NOT NULL,
    "buildVersion" TEXT NOT NULL,
    "buildFamily" TEXT NOT NULL,
    "buildSha" TEXT NOT NULL,
    "buildBranch" TEXT NOT NULL,
    "buildDate" TEXT NOT NULL,
    "platform" JSONB NOT NULL,
    "gpu" JSONB NOT NULL,
    "perf" JSONB NOT NULL,
    "net" JSONB NOT NULL,
    "netMode" TEXT NOT NULL,
    "serverId" TEXT,
    "serverName" TEXT,
    "session" JSONB NOT NULL,
    "logTail" JSONB NOT NULL,
    "replayKey" TEXT,
    "replaySha256" TEXT,
    "replayBytes" INTEGER,
    "replayContentType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BugReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BugReportScreenshot" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'image/jpeg',

    CONSTRAINT "BugReportScreenshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BugReportGrant_tokenHash_key" ON "BugReportGrant"("tokenHash");

-- CreateIndex
CREATE INDEX "BugReportGrant_userId_idx" ON "BugReportGrant"("userId");

-- CreateIndex
CREATE INDEX "BugReportGrant_expiresAt_idx" ON "BugReportGrant"("expiresAt");

-- CreateIndex
CREATE INDEX "BugReport_createdAt_idx" ON "BugReport"("createdAt");

-- CreateIndex
CREATE INDEX "BugReport_userId_idx" ON "BugReport"("userId");

-- CreateIndex
CREATE INDEX "BugReport_category_idx" ON "BugReport"("category");

-- CreateIndex
CREATE INDEX "BugReport_buildFamily_idx" ON "BugReport"("buildFamily");

-- CreateIndex
CREATE INDEX "BugReport_buildVersion_idx" ON "BugReport"("buildVersion");

-- CreateIndex
CREATE INDEX "BugReport_serverId_idx" ON "BugReport"("serverId");

-- CreateIndex
CREATE INDEX "BugReport_netMode_idx" ON "BugReport"("netMode");

-- CreateIndex
CREATE UNIQUE INDEX "BugReportScreenshot_reportId_index_key" ON "BugReportScreenshot"("reportId", "index");

-- AddForeignKey
ALTER TABLE "BugReportGrant" ADD CONSTRAINT "BugReportGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BugReport" ADD CONSTRAINT "BugReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BugReportScreenshot" ADD CONSTRAINT "BugReportScreenshot_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "BugReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
