import type { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { signAccessToken, verifyAccessToken, verifyAccessTokenForRevoke, type AccessClaims } from "./jwt";
import { pkceMatches, validVerifier } from "./validate";
import { ABSOLUTE_MS, CLIENT_ID, CODE_RETAIN_MS, IDLE_MS } from "./constants";

type Tx = Prisma.TransactionClient;

export type TokenSuccess = {
  ok: true;
  accessToken: string;
  refreshToken: string;
  expiresIn: 900;
  account: { id: string; email: string };
};

export type TokenFailure = { ok: false; error: "invalid_grant" };

export type TokenResult = TokenSuccess | TokenFailure;

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function revokeSession(tx: Tx, sessionId: string, actorId: string, reason: string) {
  const now = new Date();
  const updated = await tx.nativeSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: now, revokeReason: reason },
  });
  if (updated.count !== 1) return;
  await tx.auditLog.create({
    data: { actorId, action: "NATIVE_SESSION_REVOKED", targetId: sessionId, meta: { reason } },
  });
}

/** Revokes every live launcher family for the user. Caller holds the surrounding password transaction. */
export async function revokeUserNativeSessions(tx: Tx, userId: string, reason: string) {
  const open = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "NativeSession" WHERE "userId" = ${userId} AND "revokedAt" IS NULL FOR UPDATE`;
  if (open.length === 0) return;
  const now = new Date();
  await tx.nativeSession.updateMany({
    where: { id: { in: open.map((s) => s.id) }, revokedAt: null },
    data: { revokedAt: now, revokeReason: reason },
  });
  await tx.auditLog.createMany({
    data: open.map((s) => ({
      actorId: userId,
      action: "NATIVE_SESSION_REVOKED",
      targetId: s.id,
      meta: { reason },
    })),
  });
}

async function noteCodeReuse(tx: Tx, row: { id: string; userId: string; sessionId: string | null }) {
  await tx.auditLog.create({
    data: { actorId: row.userId, action: "NATIVE_CODE_REUSE", targetId: row.sessionId ?? row.id },
  });
  if (row.sessionId) await revokeSession(tx, row.sessionId, row.userId, "code_reuse");
}

type CodeRow = {
  id: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  pwdAt: Date | string;
};

type UserRow = {
  id: string;
  email: string;
  emailVerifiedAt: Date | string | null;
  passwordChangedAt: Date | string | null;
};

export async function exchangeAuthorizationCode(input: {
  code: string;
  redirectUri: string;
  clientId: string;
  codeVerifier: string;
}): Promise<TokenResult> {
  const codeHash = sha256(input.code);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.$queryRaw<CodeRow[]>`
      UPDATE "NativeAuthCode"
      SET "usedAt" = NOW()
      WHERE "codeHash" = ${codeHash} AND "usedAt" IS NULL AND "expiresAt" > NOW()
      RETURNING "id", "userId", "clientId", "redirectUri", "codeChallenge", "pwdAt"`;
    if (updated.length === 0) {
      const existing = await tx.nativeAuthCode.findUnique({ where: { codeHash } });
      if (existing?.usedAt) await noteCodeReuse(tx, existing);
      return { ok: false as const, error: "invalid_grant" as const };
    }
    const code = updated[0];
    const reject = (): TokenFailure => ({ ok: false, error: "invalid_grant" });
    if (code.clientId !== input.clientId || code.redirectUri !== input.redirectUri) return reject();
    if (!validVerifier(input.codeVerifier) || !pkceMatches(input.codeVerifier, code.codeChallenge)) return reject();

    const users = await tx.$queryRaw<UserRow[]>`
      SELECT "id", "email", "emailVerifiedAt", "passwordChangedAt" FROM "User" WHERE "id" = ${code.userId} FOR UPDATE`;
    const user = users[0];
    if (!user?.emailVerifiedAt) return reject();
    const pwdAt = toDate(code.pwdAt);
    if (user.passwordChangedAt && toDate(user.passwordChangedAt).getTime() > pwdAt.getTime()) return reject();

    const createdAt = new Date();
    const session = await tx.nativeSession.create({
      data: {
        userId: user.id,
        clientId: code.clientId,
        lastUsedAt: createdAt,
        idleExpiresAt: new Date(createdAt.getTime() + IDLE_MS),
        absoluteExpiresAt: new Date(createdAt.getTime() + ABSOLUTE_MS),
      },
    });
    await tx.nativeAuthCode.update({ where: { id: code.id }, data: { sessionId: session.id } });
    const refreshToken = newRefreshToken();
    await tx.nativeRefreshToken.create({ data: { tokenHash: sha256(refreshToken), sessionId: session.id } });
    await tx.auditLog.create({
      data: { actorId: user.id, action: "NATIVE_SESSION_CREATED", targetId: session.id, meta: { clientId: CLIENT_ID } },
    });
    const accessToken = signAccessToken({ sub: user.id, sid: session.id, pwdAt: pwdAt.getTime() });
    return {
      ok: true as const,
      accessToken,
      refreshToken,
      expiresIn: 900 as const,
      account: { id: user.id, email: user.email },
    };
  }, { timeout: 10_000 });
}

type RefreshRow = { id: string; sessionId: string; usedAt: Date | string | null };
type SessionRow = {
  id: string;
  userId: string;
  clientId: string;
  createdAt: Date | string;
  absoluteExpiresAt: Date | string;
  idleExpiresAt: Date | string;
  revokedAt: Date | string | null;
};

export async function refreshSessionId(refreshToken: string): Promise<string | null> {
  const row = await prisma.nativeRefreshToken.findUnique({
    where: { tokenHash: sha256(refreshToken) },
    select: { sessionId: true },
  });
  return row?.sessionId ?? null;
}

export async function rotateRefreshToken(input: { refreshToken: string; clientId: string }): Promise<TokenResult> {
  const hash = sha256(input.refreshToken);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<RefreshRow[]>`
      SELECT "id", "sessionId", "usedAt" FROM "NativeRefreshToken" WHERE "tokenHash" = ${hash} FOR UPDATE`;
    if (rows.length === 0) return { ok: false as const, error: "invalid_grant" as const };
    const token = rows[0];
    const sessions = await tx.$queryRaw<SessionRow[]>`
      SELECT "id", "userId", "clientId", "createdAt", "absoluteExpiresAt", "idleExpiresAt", "revokedAt"
      FROM "NativeSession" WHERE "id" = ${token.sessionId} FOR UPDATE`;
    const session = sessions[0];
    if (!session) return { ok: false as const, error: "invalid_grant" as const };

    if (token.usedAt) {
      await revokeSession(tx, session.id, session.userId, "refresh_reuse");
      await tx.auditLog.create({
        data: { actorId: session.userId, action: "NATIVE_REFRESH_REUSE", targetId: session.id },
      });
      return { ok: false as const, error: "invalid_grant" as const };
    }

    const now = new Date();
    const idle = toDate(session.idleExpiresAt);
    const absolute = toDate(session.absoluteExpiresAt);
    if (session.revokedAt || idle.getTime() <= now.getTime() || absolute.getTime() <= now.getTime() || session.clientId !== input.clientId) {
      return { ok: false as const, error: "invalid_grant" as const };
    }

    const users = await tx.$queryRaw<UserRow[]>`
      SELECT "id", "email", "emailVerifiedAt", "passwordChangedAt" FROM "User" WHERE "id" = ${session.userId} FOR UPDATE`;
    const user = users[0];
    if (!user) return { ok: false as const, error: "invalid_grant" as const };
    if (user.passwordChangedAt && toDate(user.passwordChangedAt).getTime() > toDate(session.createdAt).getTime()) {
      await revokeSession(tx, session.id, session.userId, "password_changed");
      return { ok: false as const, error: "invalid_grant" as const };
    }

    const refreshToken = newRefreshToken();
    const created = await tx.nativeRefreshToken.create({
      data: { tokenHash: sha256(refreshToken), sessionId: session.id },
    });
    await tx.nativeRefreshToken.update({
      where: { id: token.id },
      data: { usedAt: now, replacedById: created.id },
    });
    await tx.nativeSession.update({
      where: { id: session.id },
      data: {
        lastUsedAt: now,
        idleExpiresAt: new Date(Math.min(now.getTime() + IDLE_MS, absolute.getTime())),
      },
    });
    const pwdAt = user.passwordChangedAt ? toDate(user.passwordChangedAt).getTime() : 0;
    const accessToken = signAccessToken({ sub: user.id, sid: session.id, pwdAt });
    return {
      ok: true as const,
      accessToken,
      refreshToken,
      expiresIn: 900 as const,
      account: { id: user.id, email: user.email },
    };
  }, { timeout: 10_000 });
}

export type AccessOk = {
  ok: true; userId: string; email: string; emailVerifiedAt: Date | null; role: string; sessionId: string; claims: AccessClaims;
};
export type AccessErr = { ok: false; error: "invalid_token" | "session_revoked" | "password_changed" };

/** Reads `Authorization: Bearer <token>`; null when absent or malformed. */
export function bearerToken(header: string | null): string | null {
  const match = header ? /^Bearer (\S+)$/i.exec(header.trim()) : null;
  return match && match[1].length <= 4096 ? match[1] : null;
}

/** Live check of a launcher access token. Pass `db` to re-run it inside a transaction. */
export async function authenticateAccess(token: string, db: Tx | typeof prisma = prisma): Promise<AccessOk | AccessErr> {
  const claims = verifyAccessToken(token);
  if (!claims) return { ok: false, error: "invalid_token" };
  const session = await db.nativeSession.findUnique({ where: { id: claims.sid }, include: { user: true } });
  if (!session || session.userId !== claims.sub || !session.user) return { ok: false, error: "session_revoked" };
  const user = session.user;
  if (user.passwordChangedAt && user.passwordChangedAt.getTime() > claims.pwdAt) {
    return { ok: false, error: "password_changed" };
  }
  const now = Date.now();
  if (session.revokedAt || session.idleExpiresAt.getTime() <= now || session.absoluteExpiresAt.getTime() <= now) {
    return { ok: false, error: "session_revoked" };
  }
  return {
    ok: true,
    userId: user.id,
    email: user.email,
    emailVerifiedAt: user.emailVerifiedAt,
    role: user.role,
    sessionId: session.id,
    claims,
  };
}

export async function revokePresentedToken(token: string, hint: string | null) {
  const looksJwt = token.split(".").length === 3;
  const asRefresh = hint === "refresh_token" || (hint !== "access_token" && !looksJwt);
  if (asRefresh) {
    const row = await prisma.nativeRefreshToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row) return;
    const session = await prisma.nativeSession.findUnique({ where: { id: row.sessionId } });
    if (!session) return;
    await prisma.$transaction((tx) => revokeSession(tx, session.id, session.userId, "client_revoke"));
    return;
  }
  const claims = verifyAccessTokenForRevoke(token);
  if (!claims) return;
  const session = await prisma.nativeSession.findUnique({ where: { id: claims.sid } });
  if (!session || session.userId !== claims.sub) return;
  await prisma.$transaction((tx) => revokeSession(tx, session.id, session.userId, "client_revoke"));
}

/** Drops expired authorization codes (24h after expiresAt) and refresh hashes whose family has ended. */
export async function pruneNativeAuth() {
  const codeCutoff = new Date(Date.now() - CODE_RETAIN_MS);
  await prisma.nativeAuthCode.deleteMany({ where: { expiresAt: { lt: codeCutoff } } });
  await prisma.nativeRefreshToken.deleteMany({ where: { session: { absoluteExpiresAt: { lt: new Date() } } } });
}
