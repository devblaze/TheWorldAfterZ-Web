import { prisma } from "@/lib/db";
import { unban } from "@/lib/moderation";
import { done, failed } from "@/lib/moderation-web";
import { json, moderatorOrNull } from "@/lib/session";
import { SERVER_ID } from "@/lib/servers";

const BACK = "/admin/moderation/bans";

export async function POST(_req: Request, ctx: { params: Promise<{ banId: string }> }) {
  try {
    const me = await moderatorOrNull();
    if (!me) return json({ error: "forbidden" }, 403);
    const { banId } = await ctx.params;
    if (!SERVER_ID.test(banId)) return json({ error: "not found" }, 404);
    const r = await prisma.$transaction((tx) => unban(tx, me.user.id, banId));
    return r.ok ? done(BACK, "unbanned") : failed(r, BACK);
  } catch {
    return json({ error: "server_error" }, 500);
  }
}
