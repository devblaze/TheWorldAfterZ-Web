-- Moderation: heartbeat-reported online players, game admins, bans, server commands and version counters. Additive only.
ALTER TABLE "OfficialServer" ADD COLUMN "onlinePlayerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "onlinePlayersAt" TIMESTAMP(3);

CREATE TABLE "GameAdmin" (
    "userId" TEXT NOT NULL,
    "teleport" BOOLEAN NOT NULL DEFAULT false,
    "godMode" BOOLEAN NOT NULL DEFAULT false,
    "spawnItems" BOOLEAN NOT NULL DEFAULT false,
    "kick" BOOLEAN NOT NULL DEFAULT false,
    "ban" BOOLEAN NOT NULL DEFAULT false,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameAdmin_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "PlayerBan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serverId" TEXT,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokeReason" TEXT,

    CONSTRAINT "PlayerBan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ServerCommand" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT,
    "createdById" TEXT,
    "banId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ackedAt" TIMESTAMP(3),
    "result" TEXT,

    CONSTRAINT "ServerCommand_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ModerationCounter" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ModerationCounter_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "PlayerBan_userId_revokedAt_idx" ON "PlayerBan"("userId", "revokedAt");
CREATE INDEX "PlayerBan_serverId_idx" ON "PlayerBan"("serverId");
CREATE INDEX "ServerCommand_serverId_ackedAt_expiresAt_idx" ON "ServerCommand"("serverId", "ackedAt", "expiresAt");

ALTER TABLE "GameAdmin" ADD CONSTRAINT "GameAdmin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayerBan" ADD CONSTRAINT "PlayerBan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayerBan" ADD CONSTRAINT "PlayerBan_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "OfficialServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServerCommand" ADD CONSTRAINT "ServerCommand_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "OfficialServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The global counters always exist: join-ticket and admit take FOR SHARE on "bans", and a ban takes it exclusively, so a ban is
-- either seen by a decision or commits after it. (The row can't be locked before it exists.)
INSERT INTO "ModerationCounter" ("key", "value") VALUES ('roster', 0), ('bans', 0);
