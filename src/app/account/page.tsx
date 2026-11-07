import Link from "next/link";
import type { ReactNode } from "react";
import { button, buttonSecondary, Card, Notice, one, type SearchParams } from "@/components/ui";
import { prisma } from "@/lib/db";
import { requireUserPage } from "@/lib/session";

const badge = "rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <dt className="text-stone-500">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

export default async function Account({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUserPage();
  const redemptions = await prisma.redemption.findMany({
    where: { userId: user.id },
    include: { key: true },
    orderBy: { redeemedAt: "desc" },
  });
  const active = redemptions.find((r) => r.key.status !== "REVOKED");
  return (
    <Card title="Account">
      {one((await searchParams).redeemed) && <Notice>Key redeemed. Welcome to the wasteland.</Notice>}
      <dl className="mb-6 divide-y divide-stone-800 border-y border-stone-800 text-sm">
        <Row label="Email"><span className="break-all">{user.email}</span></Row>
        <Row label="Access">
          {active ? (
            <span className={`${badge} border-green-800 bg-green-950/60 text-green-300`}>Active</span>
          ) : redemptions.length ? (
            <span className={`${badge} border-red-800 bg-red-950/60 text-red-300`}>Revoked</span>
          ) : (
            <span className={`${badge} border-stone-700 text-stone-400`}>No key</span>
          )}
        </Row>
        {active && (
          <Row label="Key">
            {active.key.tier}, redeemed {active.redeemedAt.toISOString().slice(0, 10)}
          </Row>
        )}
        {!active && redemptions[0]?.key.revokeReason && (
          <Row label="Reason">{redemptions[0].key.revokeReason}</Row>
        )}
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        {active ? (
          <Link className={button} href="/download">Download</Link>
        ) : (
          <Link className={button} href="/redeem">Redeem a key</Link>
        )}
        <Link className={buttonSecondary} href="/forgot-password">Change password</Link>
        <Link className={buttonSecondary} href="/logout">Sign out</Link>
      </div>
    </Card>
  );
}
