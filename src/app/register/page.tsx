import Link from "next/link";
import { button, Card, Field, Notice, one, type SearchParams } from "@/components/ui";

const errors: Record<string, string> = {
  invalid: "Enter a valid email and a password of at least 10 characters.",
  rate: "Too many attempts. Try again later.",
};

export default async function Register({ searchParams }: { searchParams: SearchParams }) {
  const error = errors[one((await searchParams).error) ?? ""];
  return (
    <Card title="Register">
      {error && <Notice kind="error">{error}</Notice>}
      <form method="post" action="/api/register" className="space-y-4">
        <Field label="Email" name="email" type="email" autoComplete="email" required maxLength={254} />
        <Field label="Password (10+ characters)" name="password" type="password" autoComplete="new-password" required minLength={10} maxLength={256} />
        <button className={button}>Create account</button>
      </form>
      <p className="mt-4 text-sm text-stone-400">
        Already registered? <Link className="underline" href="/login">Sign in</Link>
      </p>
    </Card>
  );
}
