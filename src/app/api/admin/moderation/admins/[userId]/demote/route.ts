import { prisma } from "@/lib/db";
import { demote } from "@/lib/moderation";
import { done, failed } from "@/lib/moderation-web";
import { json, moderatorOrNull } from "@/lib/session";
import { SERVER_ID } from "@/lib/servers";

const BACK = "/admin/moderation";

export async function POST(_req: Request, ctx: { params: Promise<{ userId: string }> }) {
  try {
    const me = await moderatorOrNull();
    if (!me) return json({ error: "forbidden" }, 403);
    const { userId } = await ctx.params;
    if (!SERVER_ID.test(userId)) return json({ error: "not found" }, 404);
    const r = await prisma.$transaction((tx) => demote(tx, me.user.id, userId));
    return r.ok ? done(BACK, "demoted") : failed(r, BACK);
  } catch {
    return json({ error: "server_error" }, 500);
  }
}
