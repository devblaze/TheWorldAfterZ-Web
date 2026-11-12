import { prisma } from "@/lib/db";
import { methodNotAllowed, launcherJson as noStoreJson, readJsonBody } from "@/lib/launcher/http";
import { rateLimit, retryAfterSeconds } from "@/lib/rate-limit";
import { decideHeartbeatBuild, Heartbeat, HEARTBEAT_LIMIT, heartbeatKey, parseServerAuth, secretMatches, SERVER_AUDIT } from "@/lib/servers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BODY_MAX = 4096;
const invalidServer = () => noStoreJson({ error: "invalid_server" }, 401);
const notAllowed = methodNotAllowed("POST");
export { notAllowed as GET, notAllowed as PUT, notAllowed as PATCH, notAllowed as DELETE, notAllowed as OPTIONS };

type Locked = { status: string; secretHash: string; buildFamily: string; protocolVersion: number; instanceNonce: string | null };

export async function POST(req: Request) {
  try {
    const cred = parseServerAuth(req.headers.get("authorization"));
    if (!cred) return invalidServer();
    const pre = await prisma.officialServer.findUnique({ where: { id: cred.serverId }, select: { status: true, secretHash: true } });
    if (!secretMatches(cred.secret, pre?.secretHash) || pre?.status !== "ACTIVE") return invalidServer();

    if (!(await rateLimit(heartbeatKey(cred.serverId), HEARTBEAT_LIMIT.perServer, HEARTBEAT_LIMIT.windowMs))) {
      return noStoreJson({ error: "rate_limited" }, 429, { "Retry-After": String(retryAfterSeconds(HEARTBEAT_LIMIT.windowMs)) });
    }

    const body = await readJsonBody(req, BODY_MAX);
    if (!body) return noStoreJson({ error: "invalid_request" }, 400);
    const parsed = Heartbeat.safeParse(body.value);
    if (!parsed.success) return noStoreJson({ error: "invalid_request" }, 400);
    const b = parsed.data;

    // Row lock: a rotation or disable that commits first is seen here, one that comes after waits for us.
    const result = await prisma.$transaction(async (tx) => {
      const [s] = await tx.$queryRaw<Locked[]>`
        SELECT "status"::text AS "status", "secretHash", "buildFamily", "protocolVersion", "instanceNonce"
        FROM "OfficialServer" WHERE "id" = ${cred.serverId} FOR UPDATE`;
      if (!s || s.status !== "ACTIVE" || !secretMatches(cred.secret, s.secretHash)) return "invalid_server" as const;
      const decision = decideHeartbeatBuild(s, b);
      if (decision.kind === "mismatch") return "build_mismatch" as const;
      const now = new Date();
      if (s.instanceNonce !== b.instance_nonce) {
        // New process: every open session not belonging to it is gone.
        await tx.serverSession.updateMany({
          where: { serverId: cred.serverId, endedAt: null, instanceNonce: { not: b.instance_nonce } },
          data: { endedAt: now, endReason: "server_restart" },
        });
      }
      await tx.officialServer.update({
        where: { id: cred.serverId },
        data: {
          lastHeartbeatAt: now,
          instanceNonce: b.instance_nonce,
          reportedGameBuild: b.game_build,
          serverRuntime: b.server_runtime,
          players: b.players,
          maxPlayers: b.maxPlayers,
          ...(decision.kind === "adopt"
            ? { buildFamily: b.build_family, protocolVersion: b.protocol_version }
            : {}),
        },
      });
      if (decision.kind === "adopt") {
        await tx.auditLog.create({
          data: {
            actorId: null,
            action: SERVER_AUDIT.compatAdopted,
            targetId: cred.serverId,
            meta: {
              oldBuildFamily: decision.oldBuildFamily,
              newBuildFamily: decision.newBuildFamily,
              oldProtocolVersion: decision.oldProtocolVersion,
              newProtocolVersion: decision.newProtocolVersion,
            },
          },
        });
      }
      return now;
    });
    if (result === "invalid_server") return invalidServer();
    if (result === "build_mismatch") return noStoreJson({ error: "build_mismatch" }, 409);
    return noStoreJson({ ok: true, checkedAt: result.toISOString() });
  } catch (err) {
    console.error("server heartbeat failed", err instanceof Error ? err.name : "error");
    return noStoreJson({ error: "server_error" }, 500);
  }
}
