import { prisma } from "@/lib/db";
import { launcherJson as noStoreJson } from "@/lib/launcher/http";
import { rateLimit, retryAfterSeconds } from "@/lib/rate-limit";
import { Heartbeat, HEARTBEAT_LIMIT, heartbeatKey, parseServerAuth, secretMatches } from "@/lib/servers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BODY_MAX = 4096;
const invalidServer = () => noStoreJson({ error: "invalid_server" }, 401);
const notAllowed = () => noStoreJson({ error: "method_not_allowed" }, 405, { Allow: "POST" });
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

    if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return noStoreJson({ error: "invalid_request" }, 400);
    // Stop consuming oversized bodies instead of buffering an unbounded request.
    const reader = req.body?.getReader();
    if (!reader) return noStoreJson({ error: "invalid_request" }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > BODY_MAX) {
          await reader.cancel();
          return noStoreJson({ error: "invalid_request" }, 400);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return noStoreJson({ error: "invalid_request" }, 400);
    }
    const parsed = Heartbeat.safeParse(json);
    if (!parsed.success) return noStoreJson({ error: "invalid_request" }, 400);
    const b = parsed.data;

    // Row lock: a rotation or disable that commits first is seen here, one that comes after waits for us.
    const result = await prisma.$transaction(async (tx) => {
      const [s] = await tx.$queryRaw<Locked[]>`
        SELECT "status"::text AS "status", "secretHash", "buildFamily", "protocolVersion", "instanceNonce"
        FROM "OfficialServer" WHERE "id" = ${cred.serverId} FOR UPDATE`;
      if (!s || s.status !== "ACTIVE" || !secretMatches(cred.secret, s.secretHash)) return "invalid_server" as const;
      if (s.buildFamily !== b.build_family || s.protocolVersion !== b.protocol_version) return "build_mismatch" as const;
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
        },
      });
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
