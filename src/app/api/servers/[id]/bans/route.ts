import { launcherJson, methodNotAllowed } from "@/lib/launcher/http";
import { activeBanWhere, counters, createBan } from "@/lib/moderation";
import { serverGet, serverPost } from "@/lib/server-api";
import { ServerBanRequest } from "@/lib/servers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notAllowed = methodNotAllowed("GET, POST");
export { notAllowed as PUT, notAllowed as PATCH, notAllowed as DELETE, notAllowed as OPTIONS };

export const GET = async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  serverGet(req, "bans", (await ctx.params).id, async (tx, serverId) => {
    const rows = await tx.playerBan.findMany({
      where: { ...activeBanWhere(new Date()), AND: [{ OR: [{ serverId: null }, { serverId }] }] },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return {
      version: (await counters(tx, serverId)).bansVersion,
      bans: rows.map((b) => ({ id: b.id, accountId: b.userId, reason: b.reason, expiresAt: b.expiresAt?.toISOString() ?? null, scope: b.serverId ? ("server" as const) : ("global" as const) })),
    };
  });

/** In-game /ban write-back: always a global ban; the actor must be the owner or a roster admin with the ban power (checked inside createBan). */
export const POST = async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  serverPost(req, "banWrite", 2048, ServerBanRequest, async (tx, server, b) => {
    const r = await createBan(tx, { actorId: b.byAccountId, targetId: b.accountId, reason: b.reason, durationMinutes: b.durationMinutes, serverId: null, source: "game", viaServerId: server.id });
    if (!r.ok) return launcherJson({ error: r.error === "forbidden" ? "forbidden" : "unknown_account" }, r.error === "forbidden" ? 403 : 422);
    const { ban } = r;
    return launcherJson({ ban: { id: ban.id, accountId: ban.userId, reason: ban.reason, expiresAt: ban.expiresAt?.toISOString() ?? null, scope: "global", createdAt: ban.createdAt.toISOString() } }, 201);
  }, { pathId: (await ctx.params).id, invalidStatus: 422 });
