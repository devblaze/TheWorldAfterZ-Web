import { prisma } from "@/lib/db";
import { adminOrNull, json } from "@/lib/session";
import { Endpoint, SERVER_AUDIT, SERVER_ID } from "@/lib/servers";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await adminOrNull();
    if (!admin) return json({ error: "forbidden" }, 403);
    const { id } = await ctx.params;
    if (!SERVER_ID.test(id)) return json({ error: "not found" }, 404);
    const parsed = Endpoint.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid input" }, 400);

    const done = await prisma.$transaction(async (tx) => {
      // Share-lock join-ticket issuance (FOR SHARE on this row) waits, or commits first so we can expire it.
      const rows = await tx.$queryRaw<{ host: string; port: number }[]>`
        SELECT "host", "port" FROM "OfficialServer" WHERE "id" = ${id} FOR UPDATE`;
      const existing = rows[0];
      if (!existing) return false;
      await tx.officialServer.update({ where: { id }, data: parsed.data });
      // Tickets do not store host/port, but the launcher already advertised the old address to those clients.
      await tx.joinTicket.updateMany({
        where: { serverId: id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { expiresAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          actorId: admin.id,
          action: SERVER_AUDIT.endpointChanged,
          targetId: id,
          meta: {
            oldHost: existing.host,
            oldPort: existing.port,
            newHost: parsed.data.host,
            newPort: parsed.data.port,
          },
        },
      });
      return true;
    });
    return done ? json({ ok: true }) : json({ error: "not found" }, 404);
  } catch {
    // Do not log request bodies, credentials, hashes or database error details.
    return json({ error: "server_error" }, 500);
  }
}
