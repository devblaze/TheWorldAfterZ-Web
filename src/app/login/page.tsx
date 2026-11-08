import Link from "next/link";
import { loginAction } from "@/app/actions";
import { button, Card, Field, Notice, one, type SearchParams } from "@/components/ui";
import { safeLauncherNext } from "@/lib/launcher/validate";

export default async function Login({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const error = one(sp.error);
  const next = safeLauncherNext(one(sp.next));
  const fromLauncher = one(sp.from) === "launcher";
  return (
    <Card title="Sign in">
      {one(sp.registered) && fromLauncher && (
        <Notice>Check your email, then return to the launcher and press Log in.</Notice>
      )}
      {one(sp.registered) && !fromLauncher && <Notice>Check your email for a verification link, then sign in.</Notice>}
      {one(sp.verified) && <Notice>Email verified. You can sign in now.</Notice>}
      {one(sp.reset) && <Notice>Password changed. Sign in with your new password.</Notice>}
      {error === "verify" && <Notice kind="error">That verification link is invalid or expired.</Notice>}
      {error && error !== "verify" && (
        <Notice kind="error">Sign-in failed. Check your details, verify your email, or try again later.</Notice>
      )}
      <form action={loginAction} className="space-y-4">
        {next && <input type="hidden" name="next" value={next} />}
        <Field label="Email" name="email" type="email" autoComplete="email" required maxLength={254} />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required maxLength={256} />
        <button className={button}>Sign in</button>
      </form>
      <p className="mt-4 text-sm text-stone-400">
        <Link className="underline" href="/forgot-password">Forgot your password?</Link>
      </p>
      <p className="mt-2 text-sm text-stone-400">
        No account yet? <Link className="underline" href="/register">Create one</Link>
      </p>
      <p className="mt-2 text-sm text-stone-400">
        No verification email? <Link className="underline" href="/resend-verification">Resend it</Link>
      </p>
    </Card>
  );
}
