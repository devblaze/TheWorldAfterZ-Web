import { bannedAmong, lockBans } from "@/lib/moderation";
import { methodNotAllowed } from "@/lib/launcher/http";
import { serverPost } from "@/lib/server-api";
import { accessReasons } from "@/lib/server-access";
import { CheckRequest, SERVER_AUDIT } from "@/lib/servers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notAllowed = methodNotAllowed("POST");
export { notAllowed as GET, notAllowed as PUT, notAllowed as PATCH, notAllowed as DELETE, notAllowed as OPTIONS };

type Live = { id: string; userId: string; nativeSessionId: string };

export const POST = (req: Request) =>
  serverPost(req, "check", 24_576, CheckRequest, async (tx, server, b) => {
    // Unity drops every player on a duplicate or unrequested id, so answer each distinct requested id at most once.
    const ids = [...new Set(b.serverSessionIds)];
    // Own, still-open sessions only, row-locked so a concurrent end/restart is ordered against us.
    const live = ids.length === 0 ? [] : await tx.$queryRaw<Live[]>`
      SELECT s."id", s."userId", t."nativeSessionId" FROM "ServerSession" s JOIN "JoinTicket" t ON t."id" = s."ticketId"
      WHERE s."id" = ANY(${ids}::text[]) AND s."serverId" = ${server.id} AND s."endedAt" IS NULL ORDER BY s."id" FOR UPDATE OF s`;
    const reasons = await accessReasons(tx, live);
    // Added after the entitlement reasons: an otherwise valid session of a banned account is revoked as "banned".
    await lockBans(tx);
    const banned = await bannedAmong(tx, [...new Set(live.map((s) => s.userId))], server.id);
    const reasonOf = new Map(live.map((s, i) => [s.id, reasons[i] ?? (banned.has(s.userId) ? "banned" : null)]));

    const lost = live.filter((s) => reasonOf.get(s.id));
    if (lost.length > 0) {
      const now = new Date();
      for (const reason of new Set(lost.map((s) => reasonOf.get(s.id)!))) {
        await tx.serverSession.updateMany({
          where: { id: { in: lost.filter((s) => reasonOf.get(s.id) === reason).map((s) => s.id) }, serverId: server.id, endedAt: null },
          data: { endedAt: now, endReason: reason },
        });
      }
      await tx.auditLog.createMany({
        data: lost.map((s) => ({ actorId: s.userId, action: SERVER_AUDIT.playerKick, targetId: s.id, meta: { serverId: server.id, reason: reasonOf.get(s.id)! } })),
      });
    }
    // Not in `live` = unknown, foreign or already ended: one indistinguishable answer, no mutation.
    const revoke = ids.flatMap((id) => {
      const reason = reasonOf.has(id) ? reasonOf.get(id) : "unknown_session";
      return reason ? [{ serverSessionId: id, reason }] : [];
    });
    return { revoke, checkedAt: new Date().toISOString() };
  });
