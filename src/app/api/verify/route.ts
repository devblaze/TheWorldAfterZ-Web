import { z } from "zod";
import { consumeVerification } from "@/lib/email";
import { seeOther } from "@/lib/session";

const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export async function GET(req: Request) {
  const parsed = Token.safeParse(new URL(req.url).searchParams.get("token"));
  const ok = parsed.success && (await consumeVerification(parsed.data));
  return seeOther(ok ? "/login?verified=1" : "/login?error=verify");
}
