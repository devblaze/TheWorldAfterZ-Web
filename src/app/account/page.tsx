import Link from "next/link";
import { Card, Notice, one, type SearchParams } from "@/components/ui";
import { prisma } from "@/lib/db";
import { requireUserPage } from "@/lib/session";

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
      <dl className="space-y-2 text-sm">
        <div><dt className="inline text-stone-500">Email: </dt><dd className="inline">{user.email}</dd></div>
        <div>
          <dt className="inline text-stone-500">Access: </dt>
          <dd className="inline">
            {active ? (
              <span className="text-green-400">ACTIVE ({active.key.tier}, redeemed {active.redeemedAt.toISOString().slice(0, 10)})</span>
            ) : redemptions.length ? (
              <span className="text-red-400">REVOKED{redemptions[0].key.revokeReason ? `: ${redemptions[0].key.revokeReason}` : ""}</span>
            ) : (
              <span className="text-stone-400">No key redeemed</span>
            )}
          </dd>
        </div>
      </dl>
      <p className="mt-6">
        {active ? (
          <Link className="underline" href="/download">Go to download</Link>
        ) : (
          <Link className="underline" href="/redeem">Redeem an access key</Link>
        )}
      </p>
    </Card>
  );
}
