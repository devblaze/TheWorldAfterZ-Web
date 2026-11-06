import { button, Card, Field, Notice, one, type SearchParams } from "@/components/ui";

export default async function Forgot({ searchParams }: { searchParams: SearchParams }) {
  const sent = one((await searchParams).sent);
  return (
    <Card title="Forgot password">
      {sent && <Notice>If an account exists for that email, we sent a reset link.</Notice>}
      <form method="post" action="/api/forgot-password" className="space-y-4">
        <Field label="Email" name="email" type="email" autoComplete="email" required maxLength={254} />
        <button className={button}>Send reset link</button>
      </form>
    </Card>
  );
}
