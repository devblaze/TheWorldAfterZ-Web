import { prisma } from "@/lib/db";
import { launcherJson, methodNotAllowed } from "@/lib/launcher/http";
import { authenticateAccess, bearerToken } from "@/lib/launcher/store";
import { limitLauncherDirectory } from "@/lib/rate-limit";
import { activeRedemption } from "@/lib/session";
import { DIRECTORY_MAX, ONLINE_MS, parseDirectoryQuery } from "@/lib/servers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notAllowed = methodNotAllowed("GET");
export { notAllowed as POST, notAllowed as PUT, notAllowed as PATCH, notAllowed as DELETE, notAllowed as OPTIONS };

export async function GET(req: Request) {
  try {
    const token = bearerToken(req.headers.get("authorization"));
    if (!token) return launcherJson({ error: "invalid_token" }, 401);
    const auth = await authenticateAccess(token);
    if (!auth.ok) return launcherJson({ error: auth.error }, 401);

    const gate = await limitLauncherDirectory(auth.userId);
    if (!gate.ok) return launcherJson({ error: "rate_limited" }, 429, { "Retry-After": String(gate.retryAfter) });

    const q = parseDirectoryQuery(new URL(req.url).searchParams);
    if (!q.success) return launcherJson({ error: "invalid_request" }, 400);

    // Unverified wins over a missing key, as in play-check.
    if (!auth.emailVerifiedAt) return launcherJson({ error: "unverified" }, 403);
    if (!(await activeRedemption(auth.userId))) return launcherJson({ error: "no_key" }, 403);

    const checked = new Date();
    // A mismatch simply matches nothing: 200 with an empty list, never 409.
    const rows = await prisma.officialServer.findMany({
      where: {
        status: "ACTIVE",
        lastHeartbeatAt: { gte: new Date(checked.getTime() - ONLINE_MS) },
        buildFamily: q.data.build_family,
        protocolVersion: q.data.protocol_version,
        clientPlatforms: { has: q.data.client_platform },
      },
      orderBy: [{ region: "asc" }, { name: "asc" }, { id: "asc" }],
      take: DIRECTORY_MAX,
      select: { id: true, name: true, region: true, host: true, port: true, buildFamily: true, protocolVersion: true, players: true, maxPlayers: true },
    });
    return launcherJson({
      servers: rows.map((s) => ({
        id: s.id, name: s.name, region: s.region, host: s.host, port: s.port, buildFamily: s.buildFamily,
        protocolVersion: s.protocolVersion, players: s.players, maxPlayers: s.maxPlayers, online: true,
      })),
      checkedAt: checked.toISOString(),
    });
  } catch (err) {
    console.error("launcher directory failed", err instanceof Error ? err.name : "error");
    return launcherJson({ error: "server_error" }, 500);
  }
}
