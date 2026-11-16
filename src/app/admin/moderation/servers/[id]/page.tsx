import Link from "next/link";
import { notFound } from "next/navigation";
import { Notice, buttonDanger, buttonSecondary, input, one, type SearchParams } from "@/components/ui";
import { prisma } from "@/lib/db";
import { displayName } from "@/lib/crypto";
import { BAN_MAX_REASON, canBan, canKick, computeStanding, emailFor } from "@/lib/moderation";
import { requireModerator } from "@/lib/session";
import { ONLINE_MS, SERVER_ID } from "@/lib/servers";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = { kicked: "Kick queued. The server applies it on its next poll.", banned: "Player banned." };
const ERRORS: Record<string, string> = { unknown_account: "Unknown account.", not_found: "Server not available." };

export default async function ServerPlayers({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { standing: me } = await requireModerator();
  const { id } = await params;
  if (!SERVER_ID.test(id)) notFound();
  const server = await prisma.officialServer.findUnique({ where: { id }, select: { id: true, name: true, status: true, onlinePlayerIds: true, onlinePlayersAt: true } });
  if (!server) notFound();
  const sp = await searchParams;
  const done = one(sp.done);
  const error = one(sp.error);
  // eslint-disable-next-line react-hooks/purity -- server component, rendered per request
  const fresh = !!server.onlinePlayersAt && Date.now() - server.onlinePlayersAt.getTime() <= ONLINE_MS;
  const ids = fresh ? server.onlinePlayerIds : [];
  const [users, sessions] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, role: true, emailVerifiedAt: true, gameAdmin: true } }),
    prisma.serverSession.findMany({ where: { serverId: id, endedAt: null, userId: { in: ids } }, select: { userId: true } }),
  ]);
  const admitted = new Set(sessions.map((s) => s.userId));
  const byId = new Map(users.map((u) => [u.id, u]));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold uppercase tracking-widest text-amber-500">{server.name}: players</h1>
      <p className="text-sm"><Link className="underline" href="/admin/moderation">Back</Link></p>
      {done && MESSAGES[done] && <Notice>{MESSAGES[done]}</Notice>}
      {error && <Notice kind="error">{ERRORS[error] ?? "Request failed."}</Notice>}
      {!fresh && <p className="text-stone-500">No recent player list from this server (it must report playerAccountIds in its heartbeat).</p>}
      <table className="w-full text-left text-sm">
        <thead className="text-stone-500"><tr><th className="p-2">Player</th><th>Admitted</th><th>Actions</th></tr></thead>
        <tbody>
          {ids.map((uid) => {
            const u = byId.get(uid);
            if (!u) return <tr key={uid} className="border-t border-stone-800"><td className="p-2 text-stone-500">unknown account</td><td /><td /></tr>;
            const target = computeStanding(u, u.gameAdmin);
            return (
              <tr key={uid} className="border-t border-stone-800 align-top">
                <td className="p-2"><div className="font-semibold">{displayName(uid)}</div><div className="text-xs text-stone-400">{emailFor(me, u.email)}</div></td>
                <td>{admitted.has(uid) ? "yes" : "no"}</td>
                <td className="space-y-2">
                  {canKick(me, target) && (
                    <form action={`/api/admin/moderation/servers/${id}/kick`} method="post" className="flex gap-2">
                      <input type="hidden" name="userId" value={uid} />
                      <input className={input} name="reason" maxLength={BAN_MAX_REASON} placeholder="reason (optional)" />
                      <button className={buttonSecondary}>Kick</button>
                    </form>
                  )}
                  {canBan(me, target) && (
                    <form action="/api/admin/moderation/bans" method="post" className="flex flex-wrap gap-2">
                      <input type="hidden" name="userId" value={uid} />
                      <input className={input} name="reason" maxLength={BAN_MAX_REASON} placeholder="reason (optional)" />
                      <input className={`${input} max-w-24`} name="amount" type="number" min={1} max={525600} placeholder="permanent" />
                      <select className={`${input} max-w-28`} name="unit" defaultValue="hours">
                        <option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option>
                      </select>
                      <select className={`${input} max-w-36`} name="serverId" defaultValue="">
                        <option value="">all servers</option><option value={id}>this server only</option>
                      </select>
                      <button className={buttonDanger}>Ban</button>
                    </form>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
