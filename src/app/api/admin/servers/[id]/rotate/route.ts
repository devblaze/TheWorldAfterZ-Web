import { prisma } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { adminOrNull, json } from "@/lib/session";
import { newServerSecret, SERVER_AUDIT, SERVER_ID } from "@/lib/servers";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await adminOrNull();
    if (!admin) return json({ error: "forbidden" }, 403);
    const { id } = await ctx.params;
    if (!SERVER_ID.test(id)) return json({ error: "not found" }, 404);

    const secret = newServerSecret();
    // The old hash is overwritten in place, so the old secret stops working on commit.
    const done = await prisma.$transaction(async (tx) => {
      const r = await tx.officialServer.updateMany({ where: { id }, data: { secretHash: sha256(secret), secretRotatedAt: new Date() } });
      if (r.count) await tx.auditLog.create({ data: { actorId: admin.id, action: SERVER_AUDIT.rotated, targetId: id } });
      return r.count > 0;
    });
    return done ? json({ id, secret }) : json({ error: "not found" }, 404);
  } catch {
    // Do not log request bodies, credentials, hashes or database error details.
    return json({ error: "server_error" }, 500);
  }
}
