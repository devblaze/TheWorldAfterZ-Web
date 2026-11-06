import type { Metadata } from "next";
import Link from "next/link";
import { button, Card, Field, Notice, one, type SearchParams } from "@/components/ui";

// The URL carries the reset token: send no Referer at all from this page (site default only strips cross-origin paths).
export const metadata: Metadata = { referrer: "no-referrer" };

const errors: Record<string, string> = {
  invalid: "Passwords must match and be at least 10 characters.",
  rate: "Too many attempts. Try again later.",
};

export default async function Reset({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const token = one(sp.token) ?? "";
  const error = one(sp.error);
  if (!token || error === "token") {
    return (
      <Card title="Reset password">
        <Notice kind="error">That reset link is invalid, expired or already used.</Notice>
        <p className="text-sm text-stone-400">
          <Link className="underline" href="/forgot-password">Request a new link</Link>
        </p>
      </Card>
    );
  }
  return (
    <Card title="Reset password">
      {error && errors[error] && <Notice kind="error">{errors[error]}</Notice>}
      <form method="post" action="/api/reset-password" className="space-y-4">
        <input type="hidden" name="token" value={token} />
        <Field label="New password (10+ characters)" name="password" type="password" autoComplete="new-password" required minLength={10} maxLength={256} />
        <Field label="Confirm new password" name="confirm" type="password" autoComplete="new-password" required minLength={10} maxLength={256} />
        <button className={button}>Set password</button>
      </form>
    </Card>
  );
}
