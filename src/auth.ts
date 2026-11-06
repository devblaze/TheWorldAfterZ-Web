import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import argon2 from "argon2";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ipFrom, limitBoth } from "@/lib/rate-limit";

const LoginInput = z.object({ email: z.email().max(254), password: z.string().min(1).max(256) });

// Verified against when the email is unknown, so timing does not reveal which accounts exist.
const DUMMY_HASH = argon2.hash("not-a-real-password", { type: argon2.argon2id });

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw, request) {
        const parsed = LoginInput.safeParse(raw);
        if (!parsed.success) throw new CredentialsSignin();
        const email = parsed.data.email.toLowerCase();
        const ip = ipFrom(request.headers);
        if (!(await limitBoth("login", ip, email))) throw new CredentialsSignin();

        const user = await prisma.user.findUnique({ where: { email } });
        const ok = await argon2.verify(user?.passwordHash ?? (await DUMMY_HASH), parsed.data.password);
        // Unverified accounts get the same generic error as a bad password.
        if (!user || !ok || !user.emailVerifiedAt) throw new CredentialsSignin();
        return { id: user.id, email: user.email };
      },
    }),
  ],
  callbacks: {
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
});
