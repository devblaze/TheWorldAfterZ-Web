import { z } from "zod";
import { prisma } from "@/lib/db";
import { sendVerification } from "@/lib/email";
import { ipFrom, limitBoth } from "@/lib/rate-limit";
import { seeOther } from "@/lib/session";

const Email = z.email().max(254).transform((e) => e.toLowerCase());

export async function POST(req: Request) {
  const parsed = Email.safeParse((await req.formData()).get("email"));
  if (parsed.success && (await limitBoth("resend", ipFrom(req.headers), parsed.data))) {
    const user = await prisma.user.findUnique({ where: { email: parsed.data } });
    if (user && !user.emailVerifiedAt) await sendVerification(user.id, user.email);
  }
  // Never reveals whether the account exists or was rate limited.
  return seeOther("/resend-verification?sent=1");
}
