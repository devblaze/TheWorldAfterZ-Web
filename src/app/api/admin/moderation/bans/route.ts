import { z } from "zod";
import { prisma } from "@/lib/db";
import { BAN_MAX_REASON, createBan } from "@/lib/moderation";
import { done, failed, formFields, invalid } from "@/lib/moderation-web";
import { json, moderatorOrNull } from "@/lib/session";
import { BAN_MAX_MINUTES, SERVER_ID } from "@/lib/servers";

const UNIT_MINUTES = { minutes: 1, hours: 60, days: 1440 } as const;
// Duration: omit for permanent; either durationMinutes, or amount + unit (the panel form).
const Body = z.strictObject({
  userId: z.string().regex(SERVER_ID),
  reason: z.string().trim().min(1).max(BAN_MAX_REASON).optional(),
  durationMinutes: z.coerce.number().int().optional(),
  amount: z.coerce.number().int().optional(),
  unit: z.enum(["minutes", "hours", "days"]).optional(),
  serverId: z.string().regex(SERVER_ID).optional(),
});
const BACK = "/admin/moderation/bans";

export async function POST(req: Request) {
  try {
    const me = await moderatorOrNull();
    if (!me) return json({ error: "forbidden" }, 403);
    const parsed = Body.safeParse(await formFields(req));
    if (!parsed.success) return invalid();
    const { userId, reason, serverId, amount, unit, durationMinutes } = parsed.data;
    const minutes = durationMinutes ?? (amount !== undefined ? amount * UNIT_MINUTES[unit ?? "minutes"] : null);
    if (minutes !== null && (minutes < 1 || minutes > BAN_MAX_MINUTES)) return invalid();
    const r = await prisma.$transaction((tx) =>
      createBan(tx, { actorId: me.user.id, targetId: userId, reason: reason ?? null, durationMinutes: minutes, serverId: serverId ?? null, source: "web" }));
    return r.ok ? done(BACK, "banned") : failed(r, serverId ? `/admin/moderation/servers/${serverId}` : BACK);
  } catch {
    return json({ error: "server_error" }, 500);
  }
}
