import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { buttonDanger, input, Notice, one, type SearchParams } from "@/components/ui";
import { prisma } from "@/lib/db";
import { requireAdminPage } from "@/lib/session";
import MintForm from "./MintForm";

const Filter = z.object({
  status: z.enum(["ACTIVE", "REDEEMED", "REVOKED"]).optional().catch(undefined),
  tier: z.enum(["ALPHA", "BETA"]).optional().catch(undefined),
  prefix: z.string().trim().toUpperCase().max(16).optional().catch(undefined),
  email: z.string().trim().toLowerCase().max(254).optional().catch(undefined),
});

export default async function AdminKeys({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const f = Filter.parse({ status: one(sp.status), tier: one(sp.tier), prefix: one(sp.prefix) || undefined, email: one(sp.email) || undefined });
  // Accept either the bare 4-char group or a pasted TWAZ-XXXX... code.
  const prefix = f.prefix?.replace(/^TWAZ-?/, "").slice(0, 4);
  const where: Prisma.AccessKeyWhereInput = {
    status: f.status,
    tier: f.tier,
    ...(prefix && { codePrefix: { startsWith: prefix } }),
    ...(f.email && { redemption: { user: { email: { contains: f.email } } } }),
  };
  const keys = await prisma.accessKey.findMany({
    where,
    include: { redemption: { include: { user: { select: { email: true } } } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold uppercase tracking-widest text-amber-500">Access keys</h1>
      {one(sp.revoked) && <Notice>Key revoked.</Notice>}
      {one(sp.error) && <Notice kind="error">Revoke failed: a reason is required and the key must not already be revoked.</Notice>}

      <section className="space-y-3">
        <h2 className="font-semibold uppercase text-stone-400">Mint</h2>
        <MintForm />
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold uppercase text-stone-400">Keys (latest 200)</h2>
        <form className="flex flex-wrap items-end gap-3 text-sm">
          <label>Status<select className={input} name="status" defaultValue={f.status ?? ""}><option value="">any</option><option>ACTIVE</option><option>REDEEMED</option><option>REVOKED</option></select></label>
          <label>Tier<select className={input} name="tier" defaultValue={f.tier ?? ""}><option value="">any</option><option>ALPHA</option><option>BETA</option></select></label>
          <label>Prefix<input className={input} name="prefix" defaultValue={f.prefix ?? ""} placeholder="AB12" /></label>
          <label>Email<input className={input} name="email" defaultValue={f.email ?? ""} /></label>
          <button className="rounded border border-stone-600 px-3 py-2 hover:border-amber-600">Filter</button>
        </form>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-stone-500">
              <tr><th className="p-2">Prefix</th><th>Tier</th><th>Status</th><th>Batch</th><th>Redeemed by</th><th>Created</th><th>Revoke</th></tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-t border-stone-800 align-top">
                  <td className="p-2 font-mono">TWAZ-{k.codePrefix}-…</td>
                  <td>{k.tier}</td>
                  <td className={k.status === "REVOKED" ? "text-red-400" : k.status === "REDEEMED" ? "text-green-400" : ""}>{k.status}</td>
                  <td>{k.batchLabel}</td>
                  <td>{k.redemption?.user.email ?? "–"}</td>
                  <td>{k.createdAt.toISOString().slice(0, 10)}</td>
                  <td>
                    {k.status === "REVOKED" ? (
                      <span className="text-stone-500">{k.revokeReason}</span>
                    ) : (
                      <form method="post" action={`/api/admin/keys/${k.id}/revoke`} className="flex gap-2">
                        <input className={`${input} py-1`} name="reason" placeholder="reason" required maxLength={500} />
                        <button className={buttonDanger}>Revoke</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!keys.length && <p className="p-2 text-stone-500">No keys match.</p>}
        </div>
      </section>
    </div>
  );
}
