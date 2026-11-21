-- CreateTable
CREATE TABLE "BugReportTrackerLink" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "issueKey" TEXT,
    "issueUrl" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "BugReportTrackerLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BugReportTrackerLink_reportId_key" ON "BugReportTrackerLink"("reportId");

-- CreateIndex
CREATE INDEX "BugReportTrackerLink_status_nextAttemptAt_idx" ON "BugReportTrackerLink"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "BugReportTrackerLink_dedupeKey_createdAt_idx" ON "BugReportTrackerLink"("dedupeKey", "createdAt");

-- CreateIndex
CREATE INDEX "BugReportTrackerLink_issueKey_idx" ON "BugReportTrackerLink"("issueKey");

-- AddForeignKey
ALTER TABLE "BugReportTrackerLink" ADD CONSTRAINT "BugReportTrackerLink_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "BugReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
