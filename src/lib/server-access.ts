import type { Prisma } from "@prisma/client";

export type AccessReason = "password_changed" | "session_revoked" | "unverified" | "key_revoked";
type Row<T> = T & { id: string };

/**
 * Recheck native session, account and keys live. Native-session and key SHARE locks order
 * revocation against this decision. Read the user AFTER the native-session lock, without
 * taking a user row lock: refresh locks session -> user, while password reset updates
 * user -> session. Locking both here would introduce a deadlock with one of those paths.
 * A real password reset revokes native sessions in the same transaction, so a reset that
 * commits first is seen; otherwise this decision can finish before that reset commits.
 * Precedence: password_changed > session_revoked > unverified > key_revoked.
 */
export async function accessReasons(tx: Prisma.TransactionClient, pairs: { userId: string; nativeSessionId: string }[]): Promise<(AccessReason | null)[]> {
  if (pairs.length === 0) return [];
  const users = [...new Set(pairs.map((p) => p.userId))].sort();
  const sessions = [...new Set(pairs.map((p) => p.nativeSessionId))].sort();
  const s = await tx.$queryRaw<Row<{ userId: string; createdAt: Date; absoluteExpiresAt: Date; idleExpiresAt: Date; revokedAt: Date | null }>[]>`
    SELECT "id", "userId", "createdAt", "absoluteExpiresAt", "idleExpiresAt", "revokedAt" FROM "NativeSession"
    WHERE "id" = ANY(${sessions}::text[]) ORDER BY "id" FOR SHARE`;
  const u = await tx.$queryRaw<Row<{ emailVerifiedAt: Date | null; passwordChangedAt: Date | null }>[]>`
    SELECT "id", "emailVerifiedAt", "passwordChangedAt" FROM "User" WHERE "id" = ANY(${users}::text[]) ORDER BY "id"`;
  const keys = await tx.$queryRaw<{ userId: string }[]>`
    SELECT r."userId" FROM "AccessKey" k JOIN "Redemption" r ON r."keyId" = k."id"
    WHERE r."userId" = ANY(${users}::text[]) AND k."status" <> 'REVOKED' ORDER BY k."id" FOR SHARE OF k`;
  const userById = new Map(u.map((r) => [r.id, r]));
  const sessionById = new Map(s.map((r) => [r.id, r]));
  const keyed = new Set(keys.map((k) => k.userId));
  const now = Date.now();
  const ms = (d: Date) => new Date(d).getTime();
  return pairs.map(({ userId, nativeSessionId }) => {
    const user = userById.get(userId);
    const ses = sessionById.get(nativeSessionId);
    if (!user || !ses || ses.userId !== userId) return "session_revoked";
    // Same invariant as native refresh: a password change after the session was created ends it, even if already revoked.
    if (user.passwordChangedAt && ms(user.passwordChangedAt) > ms(ses.createdAt)) return "password_changed";
    if (ses.revokedAt || ms(ses.idleExpiresAt) <= now || ms(ses.absoluteExpiresAt) <= now) return "session_revoked";
    if (!user.emailVerifiedAt) return "unverified";
    return keyed.has(userId) ? null : "key_revoked";
  });
}
