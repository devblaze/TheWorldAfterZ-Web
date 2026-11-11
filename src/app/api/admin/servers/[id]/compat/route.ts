import { prisma } from "@/lib/db";
import { adminOrNull, json } from "@/lib/session";
import { Compat, SERVER_AUDIT, SERVER_ID } from "@/lib/servers";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await adminOrNull();
    if (!admin) return json({ error: "forbidden" }, 403);
    const { id } = await ctx.params;
    if (!SERVER_ID.test(id)) return json({ error: "not found" }, 404);
    const parsed = Compat.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid input" }, 400);

    const done = await prisma.$transaction(async (tx) => {
      const r = await tx.officialServer.updateMany({ where: { id }, data: parsed.data });
      if (r.count) await tx.auditLog.create({ data: { actorId: admin.id, action: SERVER_AUDIT.compatUpdated, targetId: id, meta: parsed.data } });
      return r.count > 0;
    });
    return done ? json({ ok: true }) : json({ error: "not found" }, 404);
  } catch {
    // Do not log request bodies, credentials, hashes or database error details.
    return json({ error: "server_error" }, 500);
  }
}
