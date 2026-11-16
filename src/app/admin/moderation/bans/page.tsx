import Link from "next/link";
import { Notice, buttonDanger, one, type SearchParams } from "@/components/ui";
import { prisma } from "@/lib/db";
import { displayName } from "@/lib/crypto";
import { activeBanWhere, banActive, emailFor } from "@/lib/moderation";
import { requireModerator } from "@/lib/session";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = { banned: "Player banned.", unbanned: "Ban lifted." };
const ERRORS: Record<string, string> = { unknown_account: "Unknown account.", not_found: "Not found." };
const when = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never");

export default async function Bans({ searchParams }: { searchParams: SearchParams }) {
  const { standing: me } = await requireModerator();
  const sp = await searchParams;
  const all = one(sp.all) === "1";
  const done = one(sp.done);
  const error = one(sp.error);
  const bans = await prisma.playerBan.findMany({
    where: all ? undefined : activeBanWhere(new Date()),
    include: { user: { select: { email: true } }, server: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold uppercase tracking-widest text-amber-500">Bans</h1>
      <p className="text-sm">
        <Link className="underline" href="/admin/moderation">Back</Link>{" · "}
        <Link className="underline" href={all ? "/admin/moderation/bans" : "/admin/moderation/bans?all=1"}>{all ? "Show active only" : "Show expired and revoked"}</Link>
      </p>
      {done && MESSAGES[done] && <Notice>{MESSAGES[done]}</Notice>}
      {error && <Notice kind="error">{ERRORS[error] ?? "Request failed."}</Notice>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-stone-500"><tr><th className="p-2">Player</th><th>Scope</th><th>Reason</th><th>Expires</th><th>Status</th><th /></tr></thead>
          <tbody>
            {bans.map((b) => {
              const active = banActive(b);
              return (
                <tr key={b.id} className="border-t border-stone-800 align-top">
                  <td className="p-2"><div className="font-semibold">{displayName(b.userId)}</div><div className="text-xs text-stone-400">{emailFor(me, b.user.email)}</div></td>
                  <td>{b.server ? b.server.name : "global"}</td>
                  <td>{b.reason ?? "–"}</td>
                  <td>{b.expiresAt ? when(b.expiresAt) : "permanent"}</td>
                  <td>{b.revokedAt ? `revoked ${when(b.revokedAt)}` : active ? "active" : "expired"}</td>
                  <td>{active && me.powers.ban && (
                    <form action={`/api/admin/moderation/bans/${b.id}/unban`} method="post"><button className={buttonDanger}>Unban</button></form>
                  )}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!bans.length && <p className="p-2 text-stone-500">No bans.</p>}
      </div>
    </div>
  );
}
