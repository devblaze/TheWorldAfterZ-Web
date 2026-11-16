import { z } from "zod";
import { prisma } from "@/lib/db";
import { promote } from "@/lib/moderation";
import { done, failed, formFields, invalid } from "@/lib/moderation-web";
import { json, moderatorOrNull } from "@/lib/session";

const Body = z.strictObject({ email: z.string().trim().toLowerCase().email().max(254) });
const BACK = "/admin/moderation";

export async function POST(req: Request) {
  try {
    const me = await moderatorOrNull();
    if (!me) return json({ error: "forbidden" }, 403);
    const parsed = Body.safeParse(await formFields(req));
    if (!parsed.success) return invalid();
    const r = await prisma.$transaction((tx) => promote(tx, me.user.id, parsed.data.email));
    return r.ok ? done(BACK, "promoted") : failed(r, BACK);
  } catch {
    return json({ error: "server_error" }, 500);
  }
}
