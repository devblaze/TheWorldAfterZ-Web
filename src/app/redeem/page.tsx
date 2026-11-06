import { button, Card, Field, Notice, one, type SearchParams } from "@/components/ui";
import { requireUserPage } from "@/lib/session";

const errors: Record<string, string> = {
  invalid: "That key is not valid or has already been used.",
  already: "Your account already has active access.",
  rate: "Too many attempts. Try again later.",
};

export default async function Redeem({ searchParams }: { searchParams: SearchParams }) {
  await requireUserPage();
  const error = errors[one((await searchParams).error) ?? ""];
  return (
    <Card title="Redeem key">
      {error && <Notice kind="error">{error}</Notice>}
      <form method="post" action="/api/redeem" className="space-y-4">
        <Field label="Access key" name="code" placeholder="TWAZ-XXXX-XXXX-XXXX" required maxLength={64} autoComplete="off" spellCheck={false} />
        <button className={button}>Redeem</button>
      </form>
    </Card>
  );
}
