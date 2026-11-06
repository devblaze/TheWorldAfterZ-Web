import { z } from "zod";
import { prisma } from "@/lib/db";
import { normalizeKey, sha256 } from "@/lib/crypto";
import { ipFrom, limitBoth } from "@/lib/rate-limit";
import { currentUser, seeOther } from "@/lib/session";

const Input = z.object({ code: z.string().max(64) });

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return seeOther("/login");
  const ip = ipFrom(req.headers);
  if (!(await limitBoth("redeem", ip, user.id))) return seeOther("/redeem?error=rate");

  const parsed = Input.safeParse({ code: (await req.formData()).get("code") });
  const code = parsed.success ? normalizeKey(parsed.data.code) : null;
  if (!code) return seeOther("/redeem?error=invalid");

  const result = await prisma.$transaction(async (tx) => {
    const has = await tx.redemption.findFirst({ where: { userId: user.id, key: { status: { not: "REVOKED" } } } });
    if (has) return "already";
    const key = await tx.accessKey.findUnique({ where: { codeHash: sha256(code) } });
    if (!key) return "invalid";
    // Conditional update: only one concurrent redeem can flip ACTIVE -> REDEEMED.
    const flipped = await tx.accessKey.updateMany({ where: { id: key.id, status: "ACTIVE" }, data: { status: "REDEEMED" } });
    if (flipped.count !== 1) return "invalid";
    await tx.redemption.create({ data: { keyId: key.id, userId: user.id, ip } });
    await tx.auditLog.create({ data: { actorId: user.id, action: "KEY_REDEEMED", targetId: key.id, meta: { ip } } });
    return "ok";
  });

  return seeOther(result === "ok" ? "/account?redeemed=1" : `/redeem?error=${result}`);
}
