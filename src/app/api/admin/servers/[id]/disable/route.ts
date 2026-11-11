import { prisma } from "@/lib/db";
import { adminOrNull, json } from "@/lib/session";
import { SERVER_AUDIT, SERVER_ID } from "@/lib/servers";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await adminOrNull();
    if (!admin) return json({ error: "forbidden" }, 403);
    const { id } = await ctx.params;
    if (!SERVER_ID.test(id)) return json({ error: "not found" }, 404);

    const done = await prisma.$transaction(async (tx) => {
      const r = await tx.officialServer.updateMany({ where: { id, status: "ACTIVE" }, data: { status: "DISABLED" } });
      if (!r.count) return false;
      await tx.serverSession.updateMany({ where: { serverId: id, endedAt: null }, data: { endedAt: new Date(), endReason: "server_disabled" } });
      await tx.auditLog.create({ data: { actorId: admin.id, action: SERVER_AUDIT.disabled, targetId: id } });
      return true;
    });
    return done ? json({ ok: true }) : json({ error: "not found or already disabled" }, 404);
  } catch {
    // Do not log request bodies, credentials, hashes or database error details.
    return json({ error: "server_error" }, 500);
  }
}
