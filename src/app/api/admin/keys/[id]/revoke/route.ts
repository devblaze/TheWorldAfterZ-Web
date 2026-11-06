import { z } from "zod";
import { prisma } from "@/lib/db";
import { adminOrNull, seeOther } from "@/lib/session";

const Input = z.object({ id: z.string().min(1).max(64), reason: z.string().trim().min(1).max(500) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await adminOrNull();
  if (!admin) return new Response("Forbidden", { status: 403 });
  const parsed = Input.safeParse({ id: (await ctx.params).id, reason: (await req.formData()).get("reason") });
  if (!parsed.success) return seeOther("/admin/keys?error=reason");
  const { id, reason } = parsed.data;

  const done = await prisma.$transaction(async (tx) => {
    const r = await tx.accessKey.updateMany({
      where: { id, status: { not: "REVOKED" } },
      data: { status: "REVOKED", revokedAt: new Date(), revokeReason: reason },
    });
    if (r.count) await tx.auditLog.create({ data: { actorId: admin.id, action: "KEY_REVOKED", targetId: id, meta: { reason } } });
    return r.count > 0;
  });
  return seeOther(done ? "/admin/keys?revoked=1" : "/admin/keys?error=revoke");
}
