import { z } from "zod";
import { input, one, type SearchParams } from "@/components/ui";
import { prisma } from "@/lib/db";
import { requireAdminPage } from "@/lib/session";

export default async function AdminUsers({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const email = z.string().trim().toLowerCase().max(254).catch("").parse(one((await searchParams).email) ?? "");
  const users = await prisma.user.findMany({
    where: email ? { email: { contains: email } } : undefined,
    include: { redemptions: { include: { key: true } }, _count: { select: { downloadEvents: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold uppercase tracking-widest text-amber-500">Users</h1>
      <form className="flex gap-3 text-sm">
        <input className={input} name="email" defaultValue={email} placeholder="search email" />
        <button className="rounded border border-stone-600 px-3 py-2 hover:border-amber-600">Search</button>
      </form>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-stone-500">
            <tr><th className="p-2">Email</th><th>Role</th><th>Verified</th><th>Access</th><th>Downloads</th><th>Joined</th></tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const active = u.redemptions.find((r) => r.key.status !== "REVOKED");
              return (
                <tr key={u.id} className="border-t border-stone-800">
                  <td className="p-2">{u.email}</td>
                  <td>{u.role}</td>
                  <td>{u.emailVerifiedAt ? "yes" : "no"}</td>
                  <td>{active ? `${active.key.tier} (TWAZ-${active.key.codePrefix})` : u.redemptions.length ? "revoked" : "–"}</td>
                  <td>{u._count.downloadEvents}</td>
                  <td>{u.createdAt.toISOString().slice(0, 10)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
