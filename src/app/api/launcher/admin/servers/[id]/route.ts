import { prisma } from "@/lib/db";
import { launcherJson, methodNotAllowed, readJsonBody } from "@/lib/launcher/http";
import { requireLauncherAdmin } from "@/lib/launcher/role";
import { setServerCapacity } from "@/lib/server-admin";
import { Capacity, SERVER_ID } from "@/lib/servers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BODY_MAX = 1024;
const notAllowed = methodNotAllowed("PATCH");
export { notAllowed as GET, notAllowed as POST, notAllowed as PUT, notAllowed as DELETE, notAllowed as OPTIONS };

/** In-game capacity edit (admin only). Body {maxPlayers: 1-64}; audited; the server picks it up on its next heartbeat. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireLauncherAdmin(req);
    if (!gate.ok) return gate.res;

    const { id } = await ctx.params;
    if (!SERVER_ID.test(id)) return launcherJson({ error: "not_found" }, 404);
    const body = await readJsonBody(req, BODY_MAX);
    if (!body) return launcherJson({ error: "invalid_request" }, 400);
    const parsed = Capacity.safeParse(body.value);
    if (!parsed.success) return launcherJson({ error: "validation_failed", fields: ["maxPlayers"] }, 422);

    const done = await prisma.$transaction((tx) =>
      setServerCapacity(tx, { serverId: id, maxPlayers: parsed.data.maxPlayers, actorId: gate.auth.userId, source: "launcher" }));
    return done ? launcherJson({ serverId: id, maxPlayers: done.new }) : launcherJson({ error: "not_found" }, 404);
  } catch (err) {
    console.error("launcher admin capacity failed", err instanceof Error ? err.name : "error");
    return launcherJson({ error: "server_error" }, 500);
  }
}
