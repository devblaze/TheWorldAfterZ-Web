import Link from "next/link";
import { loginAction } from "@/app/actions";
import { button, Card, Field, Notice, one, type SearchParams } from "@/components/ui";

export default async function Login({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const error = one(sp.error);
  return (
    <Card title="Sign in">
      {one(sp.registered) && <Notice>Check your email for a verification link, then sign in.</Notice>}
      {one(sp.verified) && <Notice>Email verified. You can sign in now.</Notice>}
      {error === "verify" && <Notice kind="error">That verification link is invalid or expired.</Notice>}
      {error && error !== "verify" && (
        <Notice kind="error">Sign-in failed. Check your details, verify your email, or try again later.</Notice>
      )}
      <form action={loginAction} className="space-y-4">
        <Field label="Email" name="email" type="email" autoComplete="email" required maxLength={254} />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required maxLength={256} />
        <button className={button}>Sign in</button>
      </form>
      <p className="mt-4 text-sm text-stone-400">
        No verification email? <Link className="underline" href="/resend-verification">Resend it</Link>
      </p>
    </Card>
  );
}
