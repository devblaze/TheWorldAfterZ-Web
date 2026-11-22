-- Self-updater status from the official server heartbeat (optional `updater` field). Nullable: old builds omit it.
ALTER TABLE "OfficialServer" ADD COLUMN "updaterState" TEXT,
ADD COLUMN "updaterReason" TEXT,
ADD COLUMN "updaterReportedAt" TIMESTAMP(3);
ALTER TABLE "OfficialServer" ADD CONSTRAINT "OfficialServer_updaterState_check" CHECK ("updaterState" IS NULL OR "updaterState" IN ('ok', 'halted'));
ALTER TABLE "OfficialServer" ADD CONSTRAINT "OfficialServer_updaterReason_length" CHECK ("updaterReason" IS NULL OR char_length("updaterReason") <= 200);
