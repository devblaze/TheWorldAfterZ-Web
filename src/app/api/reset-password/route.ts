import argon2 from "argon2";
import { z } from "zod";
import { consumePasswordReset } from "@/lib/email";
import { ipFrom, limitIp } from "@/lib/rate-limit";
import { seeOther } from "@/lib/session";

const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Passwords = z
  .object({ password: z.string().min(10).max(256), confirm: z.string() })
  .refine((v) => v.password === v.confirm);

export async function POST(req: Request) {
  const form = await req.formData();
  const token = Token.safeParse(form.get("token"));
  if (!token.success) return seeOther("/reset-password?error=token");
  // Back to the form: the token is already in the user's URL from the email; we never log it.
  const back = (error: string) => seeOther(`/reset-password?token=${token.data}&error=${error}`);
  if (!(await limitIp("reset", ipFrom(req.headers)))) return back("rate");
  const pw = Passwords.safeParse({ password: form.get("password"), confirm: form.get("confirm") });
  if (!pw.success) return back("invalid");

  const hash = await argon2.hash(pw.data.password, { type: argon2.argon2id });
  if (!(await consumePasswordReset(token.data, hash))) return seeOther("/reset-password?error=token");
  return seeOther("/login?reset=1");
}
