import argon2 from "argon2";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { sendVerification } from "@/lib/email";
import { ipFrom, limitBoth } from "@/lib/rate-limit";
import { seeOther } from "@/lib/session";

const Input = z.object({
  email: z.email().max(254).transform((e) => e.toLowerCase()),
  password: z.string().min(10).max(256),
});

export async function POST(req: Request) {
  const form = await req.formData();
  const parsed = Input.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return seeOther("/register?error=invalid");
  const { email, password } = parsed.data;
  if (!(await limitBoth("register", ipFrom(req.headers), email))) return seeOther("/register?error=rate");

  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    const user = await prisma.user.create({
      data: { email, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    await prisma.auditLog.create({ data: { actorId: user.id, action: "USER_REGISTERED", targetId: user.id } });
    await sendVerification(user.id, email);
  }
  // Same response whether or not the email was already registered.
  return seeOther("/login?registered=1");
}
