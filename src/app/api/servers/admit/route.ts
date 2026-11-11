import { sha256 } from "@/lib/crypto";
import { methodNotAllowed } from "@/lib/launcher/http";
import { serverPost } from "@/lib/server-api";
import { accessReasons } from "@/lib/server-access";
import { AdmitRequest, SERVER_AUDIT } from "@/lib/servers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notAllowed = methodNotAllowed("POST");
export { notAllowed as GET, notAllowed as PUT, notAllowed as PATCH, notAllowed as DELETE, notAllowed as OPTIONS };

type Ticket = { id: string; userId: string; nativeSessionId: string; buildFamily: string; protocolVersion: number };

export const POST = (req: Request) =>
  serverPost(req, "admit", 2048, AdmitRequest, async (tx, server, b) => {
    const deny = async (reason: string, ticket?: { id: string; userId: string }, extra?: Record<string, unknown>) => {
      await tx.auditLog.create({
        data: {
          actorId: ticket?.userId, action: SERVER_AUDIT.admitDeny, targetId: ticket?.id,
          // Never the ticket; connection_id and the informational game_build only.
          meta: { reason, serverId: server.id, connectionId: b.connection_id, buildFamily: b.build_family, protocolVersion: b.protocol_version, gameBuild: b.game_build, ...extra },
        },
      });
      return { admitted: false, reason };
    };

    const hash = sha256(b.ticket);
    const used = await tx.$queryRaw<Ticket[]>`
      UPDATE "JoinTicket" SET "usedAt" = (clock_timestamp() AT TIME ZONE 'UTC'), "usedByConnection" = ${`${b.instance_nonce}:${b.connection_id}`}
      WHERE "ticketHash" = ${hash} AND "usedAt" IS NULL AND "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC') AND "serverId" = ${server.id}
      RETURNING "id", "userId", "nativeSessionId", "buildFamily", "protocolVersion"`;
    if (used.length === 0) {
      // Replay takes precedence; unused tickets remain bound to their owning server.
      const t = await tx.joinTicket.findUnique({ where: { ticketHash: hash } });
      if (!t) return deny("ticket_invalid");
      if (t.usedAt) {
        await tx.auditLog.create({
          data: { actorId: t.userId, action: SERVER_AUDIT.ticketReuse, targetId: t.id, meta: { serverId: server.id, connectionId: b.connection_id } },
        });
        return deny("ticket_used", t);
      }
      if (t.serverId !== server.id) return deny("wrong_server", t);
      return deny(t.expiresAt.getTime() <= Date.now() ? "ticket_expired" : "ticket_invalid", t);
    }
    const t = used[0];

    // Consume first. Every later business denial commits consumption and ADMIT_DENY,
    // so any replay (even with a stale nonce or changed build) becomes ticket_used.
    if (server.instanceNonce !== b.instance_nonce) return deny("stale_instance", t);
    if (server.buildFamily !== b.build_family || server.protocolVersion !== b.protocol_version) return deny("build_mismatch", t);
    if (t.buildFamily !== b.build_family || t.protocolVersion !== b.protocol_version) return deny("build_mismatch", t);
    const [reason] = await accessReasons(tx, [{ userId: t.userId, nativeSessionId: t.nativeSessionId }]);
    if (reason) return deny(reason === "unverified" ? "unverified" : reason === "key_revoked" ? "no_key" : "session_revoked", t, { access: reason });

    const clash = await tx.serverSession.findUnique({
      where: { serverId_instanceNonce_connectionId: { serverId: server.id, instanceNonce: b.instance_nonce, connectionId: b.connection_id } },
      select: { id: true },
    });
    if (clash) return deny("ticket_invalid", t, { detail: "connection_reused" });

    const session = await tx.serverSession.create({
      data: { serverId: server.id, userId: t.userId, ticketId: t.id, instanceNonce: b.instance_nonce, connectionId: b.connection_id },
    });
    await tx.auditLog.create({
      data: {
        actorId: t.userId, action: SERVER_AUDIT.admitOk, targetId: session.id,
        meta: { serverId: server.id, connectionId: b.connection_id, buildFamily: b.build_family, protocolVersion: b.protocol_version, gameBuild: b.game_build },
      },
    });
    // displayName is derived from the account id: a stable, non-PII pseudonym (not a player-selected username). There is no username in the schema.
    return { admitted: true, accountId: t.userId, displayName: `Player-${sha256(`display:${t.userId}`).slice(0, 8)}`, serverSessionId: session.id };
  });
