import { prisma } from "@/lib/db";
import { POWER_KEYS, setPowers, type Powers } from "@/lib/moderation";
import { done, failed } from "@/lib/moderation-web";
import { json, moderatorOrNull } from "@/lib/session";
import { SERVER_ID } from "@/lib/servers";

const BACK = "/admin/moderation";

export async function POST(req: Request, ctx: { params: Promise<{ userId: string }> }) {
  try {
    const me = await moderatorOrNull();
    if (!me) return json({ error: "forbidden" }, 403);
    const { userId } = await ctx.params;
    if (!SERVER_ID.test(userId)) return json({ error: "not found" }, 404);
    // Checkbox form: a ticked box is present, an unticked one is absent.
    const fd = await req.formData().catch(() => null);
    if (!fd) return json({ error: "invalid input" }, 400);
    const next = Object.fromEntries(POWER_KEYS.map((k) => [k, fd.has(k)])) as Powers;
    const r = await prisma.$transaction((tx) => setPowers(tx, me.user.id, userId, next));
    return r.ok ? done(BACK, "powers") : failed(r, BACK);
  } catch {
    return json({ error: "server_error" }, 500);
  }
}
