-- CreateTable
CREATE TABLE "NativeAuthCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "pwdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NativeAuthCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL,
    "idleExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,

    CONSTRAINT "NativeSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeRefreshToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    "replacedById" TEXT,

    CONSTRAINT "NativeRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NativeAuthCode_codeHash_key" ON "NativeAuthCode"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "NativeAuthCode_sessionId_key" ON "NativeAuthCode"("sessionId");

-- CreateIndex
CREATE INDEX "NativeAuthCode_userId_idx" ON "NativeAuthCode"("userId");

-- CreateIndex
CREATE INDEX "NativeAuthCode_expiresAt_idx" ON "NativeAuthCode"("expiresAt");

-- CreateIndex
CREATE INDEX "NativeSession_userId_idx" ON "NativeSession"("userId");

-- CreateIndex
CREATE INDEX "NativeSession_absoluteExpiresAt_idx" ON "NativeSession"("absoluteExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "NativeRefreshToken_tokenHash_key" ON "NativeRefreshToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "NativeRefreshToken_replacedById_key" ON "NativeRefreshToken"("replacedById");

-- CreateIndex
CREATE INDEX "NativeRefreshToken_sessionId_idx" ON "NativeRefreshToken"("sessionId");

-- AddForeignKey
ALTER TABLE "NativeAuthCode" ADD CONSTRAINT "NativeAuthCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAuthCode" ADD CONSTRAINT "NativeAuthCode_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "NativeSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeSession" ADD CONSTRAINT "NativeSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeRefreshToken" ADD CONSTRAINT "NativeRefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "NativeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
