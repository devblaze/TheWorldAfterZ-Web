-- CreateEnum
CREATE TYPE "ServerStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "OfficialServer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "gameBuild" TEXT NOT NULL,
    "buildFamily" TEXT NOT NULL,
    "protocolVersion" INTEGER NOT NULL,
    "clientPlatforms" TEXT[],
    "status" "ServerStatus" NOT NULL DEFAULT 'ACTIVE',
    "secretHash" TEXT NOT NULL,
    "secretRotatedAt" TIMESTAMP(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMP(3),
    "instanceNonce" TEXT,
    "reportedGameBuild" TEXT,
    "serverRuntime" TEXT,
    "players" INTEGER NOT NULL DEFAULT 0,
    "maxPlayers" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfficialServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JoinTicket" (
    "id" TEXT NOT NULL,
    "ticketHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nativeSessionId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "gameBuild" TEXT NOT NULL,
    "buildFamily" TEXT NOT NULL,
    "protocolVersion" INTEGER NOT NULL,
    "clientPlatform" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedByConnection" TEXT,

    CONSTRAINT "JoinTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServerSession" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "instanceNonce" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "admittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,

    CONSTRAINT "ServerSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OfficialServer_status_lastHeartbeatAt_idx" ON "OfficialServer"("status", "lastHeartbeatAt");

-- CreateIndex
CREATE UNIQUE INDEX "JoinTicket_ticketHash_key" ON "JoinTicket"("ticketHash");

-- CreateIndex
CREATE INDEX "JoinTicket_userId_idx" ON "JoinTicket"("userId");

-- CreateIndex
CREATE INDEX "JoinTicket_serverId_idx" ON "JoinTicket"("serverId");

-- CreateIndex
CREATE INDEX "JoinTicket_expiresAt_idx" ON "JoinTicket"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ServerSession_ticketId_key" ON "ServerSession"("ticketId");

-- CreateIndex
CREATE INDEX "ServerSession_serverId_endedAt_idx" ON "ServerSession"("serverId", "endedAt");

-- CreateIndex
CREATE INDEX "ServerSession_userId_endedAt_idx" ON "ServerSession"("userId", "endedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ServerSession_serverId_instanceNonce_connectionId_key" ON "ServerSession"("serverId", "instanceNonce", "connectionId");

-- AddForeignKey
ALTER TABLE "OfficialServer" ADD CONSTRAINT "OfficialServer_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JoinTicket" ADD CONSTRAINT "JoinTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JoinTicket" ADD CONSTRAINT "JoinTicket_nativeSessionId_fkey" FOREIGN KEY ("nativeSessionId") REFERENCES "NativeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JoinTicket" ADD CONSTRAINT "JoinTicket_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "OfficialServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerSession" ADD CONSTRAINT "ServerSession_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "OfficialServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerSession" ADD CONSTRAINT "ServerSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerSession" ADD CONSTRAINT "ServerSession_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "JoinTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
