import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { launcherJson, methodNotAllowed, readJsonBody } from "@/lib/launcher/http";
import { authenticateAccess, bearerToken } from "@/lib/launcher/store";
import { limitLauncherJoin } from "@/lib/rate-limit";
import { effectiveCapacity, JOIN_TICKET_TTL_MS, JoinTicketRequest, ONLINE_MS, SERVER_AUDIT } from "@/lib/servers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BODY_MAX = 8192;
const notAllowed = methodNotAllowed("POST");
export { notAllowed as GET, notAllowed as PUT, notAllowed as PATCH, notAllowed as DELETE, notAllowed as OPTIONS };

const deny = (reason: string) => ({ entitled: false as const, reason });

export async function POST(req: Request) {
  try {
    const token = bearerToken(req.headers.get("authorization"));
    if (!token) return launcherJson({ error: "invalid_token" }, 401);
    const pre = await authenticateAccess(token);
    if (!pre.ok) return launcherJson({ error: pre.error }, 401);

    const gate = await limitLauncherJoin(pre.userId);
    if (!gate.ok) return launcherJson({ error: "rate_limited" }, 429, { "Retry-After": String(gate.retryAfter) });

    const body = await readJsonBody(req, BODY_MAX);
    const parsed = body && JoinTicketRequest.safeParse(body.value);
    if (!parsed?.success) return launcherJson({ error: "invalid_request" }, 400);
    const b = parsed.data;

    // Everything below runs under share locks on the native session, the entitling keys and the server, so a
    // concurrent revoke, password reset, key revoke, disable or compat change either commits first and is seen
    // here, or waits until this ticket (and its audit row) has committed. Admit re-checks all of it live.
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "NativeSession" WHERE "id" = ${pre.sessionId} FOR SHARE`;
      const auth = await authenticateAccess(token, tx);
      if (!auth.ok) return auth;
      if (!auth.emailVerifiedAt) return deny("unverified");
      const keys = await tx.$queryRaw<unknown[]>`
        SELECT 1 FROM "AccessKey" k JOIN "Redemption" r ON r."keyId" = k."id"
        WHERE r."userId" = ${auth.userId} AND k."status" <> 'REVOKED'
        ORDER BY k."id" FOR SHARE OF k`;
      if (keys.length === 0) return deny("no_key");

      // Entitlement first: an unentitled caller learns nothing about which server ids exist.
      await tx.$queryRaw`SELECT 1 FROM "OfficialServer" WHERE "id" = ${b.serverId} FOR SHARE`;
      const s = await tx.officialServer.findUnique({ where: { id: b.serverId } });
      if (!s || s.status !== "ACTIVE") return deny("server_not_found");
      const checked = new Date();
      if (!s.lastHeartbeatAt || checked.getTime() - s.lastHeartbeatAt.getTime() > ONLINE_MS) return deny("server_offline");
      if (s.buildFamily !== b.build_family || s.protocolVersion !== b.protocol_version || !s.clientPlatforms.includes(b.client_platform)) {
        return deny("build_mismatch");
      }
      if (s.players >= effectiveCapacity(s)) return deny("server_full");

      const ticket = randomBytes(32).toString("base64url");
      const expires = new Date(checked.getTime() + JOIN_TICKET_TTL_MS);
      const row = await tx.joinTicket.create({
        data: {
          ticketHash: sha256(ticket),
          userId: auth.userId,
          nativeSessionId: auth.sessionId,
          serverId: s.id,
          gameBuild: b.game_build,
          buildFamily: b.build_family,
          protocolVersion: b.protocol_version,
          clientPlatform: b.client_platform,
          expiresAt: expires,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: auth.userId,
          action: SERVER_AUDIT.ticketIssued,
          targetId: row.id,
          meta: { serverId: s.id, nativeSessionId: auth.sessionId, buildFamily: b.build_family, protocolVersion: b.protocol_version, clientPlatform: b.client_platform, gameBuild: b.game_build },
        },
      });
      return {
        ticket,
        serverId: s.id,
        accountId: auth.userId,
        nonce: b.nonce,
        build_family: b.build_family,
        protocol_version: b.protocol_version,
        client_platform: b.client_platform,
        game_build: b.game_build,
        checkedAt: checked.toISOString(),
        expiresAt: expires.toISOString(),
      };
    }, { timeout: 10_000 });
    if ("ok" in result) return launcherJson({ error: result.error }, 401);
    return launcherJson(result);
  } catch (err) {
    // Never log the request, the ticket or database details.
    console.error("launcher join-ticket failed", err instanceof Error ? err.name : "error");
    return launcherJson({ error: "server_error" }, 500);
  }
}
