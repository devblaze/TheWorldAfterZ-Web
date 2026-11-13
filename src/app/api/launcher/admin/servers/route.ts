import { prisma } from "@/lib/db";
import { launcherJson, methodNotAllowed, readJsonBody } from "@/lib/launcher/http";
import { requireLauncherAdmin } from "@/lib/launcher/role";
import { LauncherCreateServer, PENDING_COMPAT, SERVER_AUDIT } from "@/lib/servers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BODY_MAX = 4096;
const notAllowed = methodNotAllowed("POST");
export { notAllowed as GET, notAllowed as PUT, notAllowed as PATCH, notAllowed as DELETE, notAllowed as OPTIONS };

/**
 * In-game "Host server" (admin only). Creates the row WITHOUT a credential: no secret is generated here and none
 * is ever returned to the game client. The operator generates it on the web admin page (shown once) or on the box.
 */
export async function POST(req: Request) {
  try {
    const gate = await requireLauncherAdmin(req);
    if (!gate.ok) return gate.res;
    const admin = gate.auth;

    const body = await readJsonBody(req, BODY_MAX);
    if (!body) return launcherJson({ error: "invalid_request" }, 400);
    const parsed = LauncherCreateServer.safeParse(body.value);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "body")))];
      return launcherJson({ error: "validation_failed", fields }, 422);
    }
    const { maxPlayers, ...rest } = parsed.data;

    const server = await prisma.$transaction(async (tx) => {
      const s = await tx.officialServer.create({
        data: { ...rest, ...PENDING_COMPAT, adminMaxPlayers: maxPlayers, secretHash: null, secretRotatedAt: null, createdById: admin.userId },
        select: { id: true, name: true, region: true, host: true, port: true, adminMaxPlayers: true },
      });
      await tx.auditLog.create({
        data: {
          actorId: admin.userId,
          action: SERVER_AUDIT.created,
          targetId: s.id,
          meta: { name: s.name, region: s.region, host: s.host, port: s.port, maxPlayers: s.adminMaxPlayers, source: "launcher" },
        },
      });
      return s;
    });
    return launcherJson({
      serverId: server.id, name: server.name, region: server.region, host: server.host, port: server.port,
      maxPlayers: server.adminMaxPlayers, status: "pending",
    }, 201);
  } catch (err) {
    // Never log the request, a token or database details.
    console.error("launcher admin create failed", err instanceof Error ? err.name : "error");
    return launcherJson({ error: "server_error" }, 500);
  }
}
