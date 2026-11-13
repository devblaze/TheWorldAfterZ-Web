import { prisma } from "@/lib/db";
import { setServerCapacity } from "@/lib/server-admin";
import { adminOrNull, json } from "@/lib/session";
import { Capacity, SERVER_ID } from "@/lib/servers";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await adminOrNull();
    if (!admin) return json({ error: "forbidden" }, 403);
    const { id } = await ctx.params;
    if (!SERVER_ID.test(id)) return json({ error: "not found" }, 404);
    const parsed = Capacity.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid input" }, 400);

    const done = await prisma.$transaction((tx) =>
      setServerCapacity(tx, { serverId: id, maxPlayers: parsed.data.maxPlayers, actorId: admin.id, source: "web" }));
    return done ? json({ ok: true, maxPlayers: done.new }) : json({ error: "not found" }, 404);
  } catch {
    // Do not log request bodies, credentials, hashes or database error details.
    return json({ error: "server_error" }, 500);
  }
}
