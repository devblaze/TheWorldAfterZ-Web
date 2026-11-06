import { button, Card, Field, Notice, one, type SearchParams } from "@/components/ui";

export default async function Resend({ searchParams }: { searchParams: SearchParams }) {
  const sent = one((await searchParams).sent);
  return (
    <Card title="Resend verification">
      {sent && <Notice>If that account exists and is unverified, a new link is on its way.</Notice>}
      <form method="post" action="/api/resend-verification" className="space-y-4">
        <Field label="Email" name="email" type="email" autoComplete="email" required maxLength={254} />
        <button className={button}>Send link</button>
      </form>
    </Card>
  );
}
