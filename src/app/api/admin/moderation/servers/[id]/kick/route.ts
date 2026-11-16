import { z } from "zod";
import { prisma } from "@/lib/db";
import { BAN_MAX_REASON, requestKick } from "@/lib/moderation";
import { done, failed, formFields, invalid } from "@/lib/moderation-web";
import { json, moderatorOrNull } from "@/lib/session";
import { SERVER_ID } from "@/lib/servers";

const Body = z.strictObject({ userId: z.string().regex(SERVER_ID), reason: z.string().trim().min(1).max(BAN_MAX_REASON).optional() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const me = await moderatorOrNull();
    if (!me) return json({ error: "forbidden" }, 403);
    const { id } = await ctx.params;
    if (!SERVER_ID.test(id)) return json({ error: "not found" }, 404);
    const parsed = Body.safeParse(await formFields(req));
    if (!parsed.success) return invalid();
    const back = `/admin/moderation/servers/${id}`;
    const r = await prisma.$transaction((tx) => requestKick(tx, me.user.id, id, parsed.data.userId, parsed.data.reason ?? null));
    return r.ok ? done(back, "kicked") : failed(r, back);
  } catch {
    return json({ error: "server_error" }, 500);
  }
}
