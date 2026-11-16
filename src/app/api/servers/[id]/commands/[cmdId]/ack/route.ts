import { launcherJson, methodNotAllowed } from "@/lib/launcher/http";
import { bump, counterKey, MODERATION_AUDIT } from "@/lib/moderation";
import { serverPost } from "@/lib/server-api";
import { AckRequest } from "@/lib/servers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notAllowed = methodNotAllowed("POST");
export { notAllowed as GET, notAllowed as PUT, notAllowed as PATCH, notAllowed as DELETE, notAllowed as OPTIONS };

export const POST = async (req: Request, ctx: { params: Promise<{ id: string; cmdId: string }> }) => {
  const { id, cmdId } = await ctx.params;
  return serverPost(req, "ack", 256, AckRequest, async (tx, server, b) => {
    // FOR UPDATE: two concurrent acks serialize, the second sees the first result. Expired-but-unacked commands may still be acked.
    const [c] = await tx.$queryRaw<{ ackedAt: Date | null; result: string | null }[]>`
      SELECT "ackedAt", "result" FROM "ServerCommand" WHERE "id" = ${cmdId} AND "serverId" = ${server.id} FOR UPDATE`;
    if (!c) return launcherJson({ error: "not_found" }, 404);
    if (c.ackedAt) return { ok: true, id: cmdId, result: c.result, ackedAt: c.ackedAt.toISOString() };
    const ackedAt = new Date();
    await tx.serverCommand.update({ where: { id: cmdId }, data: { ackedAt, result: b.result } });
    await bump(tx, counterKey.commands(server.id));
    await tx.auditLog.create({ data: { actorId: null, action: MODERATION_AUDIT.commandAcked, targetId: cmdId, meta: { serverId: server.id, result: b.result } } });
    return { ok: true, id: cmdId, result: b.result, ackedAt: ackedAt.toISOString() };
  }, { pathId: id, invalidStatus: 422 });
};
