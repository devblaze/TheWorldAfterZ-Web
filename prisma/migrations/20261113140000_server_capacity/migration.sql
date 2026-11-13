-- Admin-set capacity, authoritative over the heartbeat-reported "maxPlayers". Existing rows get the default 64.
ALTER TABLE "OfficialServer" ADD COLUMN "adminMaxPlayers" INTEGER NOT NULL DEFAULT 64;
ALTER TABLE "OfficialServer" ADD CONSTRAINT "OfficialServer_adminMaxPlayers_range" CHECK ("adminMaxPlayers" BETWEEN 1 AND 64);

-- Servers created in game have no credential until an admin generates one on the web (shown once).
ALTER TABLE "OfficialServer" ALTER COLUMN "secretHash" DROP NOT NULL;
ALTER TABLE "OfficialServer" ALTER COLUMN "secretRotatedAt" DROP NOT NULL;
