import Link from "next/link";
import { Fragment } from "react";
import { Notice, button, buttonDanger, buttonSecondary, input, one, type SearchParams } from "@/components/ui";
import { prisma } from "@/lib/db";
import { POWER_KEYS, emailFor, rosterUsers } from "@/lib/moderation";
import { requireModerator } from "@/lib/session";
import { adminListStatus, adminListStatusClass } from "@/lib/servers";
import { displayName } from "@/lib/crypto";
import { UpdaterHaltBanner } from "@/components/updater-halt";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  promoted: "Promoted to game admin with no powers. The owner can grant powers below.",
  demoted: "Game admin removed.",
  powers: "Powers saved.",
};
const ERRORS: Record<string, string> = {
  unknown_account: "No verified player with that exact email.",
  conflict: "That account is already an admin.",
};

export default async function Moderation({ searchParams }: { searchParams: SearchParams }) {
  const { standing: me } = await requireModerator();
  const sp = await searchParams;
  const done = one(sp.done);
  const error = one(sp.error);
  const [roster, servers] = await Promise.all([
    rosterUsers(prisma),
    prisma.officialServer.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true, region: true, status: true, lastHeartbeatAt: true, players: true, adminMaxPlayers: true,
        updaterState: true, updaterReason: true, updaterReportedAt: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  ]);
  // eslint-disable-next-line react-hooks/purity -- server component, rendered per request
  const now = Date.now();
  const owner = me.level === "owner";

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold uppercase tracking-widest text-amber-500">Moderation</h1>
      {done && MESSAGES[done] && <Notice>{MESSAGES[done]}</Notice>}
      {error && <Notice kind="error">{ERRORS[error] ?? "Request failed."}</Notice>}
      <p className="text-sm text-stone-400">
        <Link className="underline" href="/admin/moderation/bans">Ban list</Link>
      </p>

      <section className="space-y-3">
        <h2 className="font-semibold uppercase text-stone-400">Game admins</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-stone-500">
              <tr><th className="p-2">Player</th><th>Source</th><th>Powers</th><th /></tr>
            </thead>
            <tbody>
              {roster.map(({ u, s }) => {
                const editable = owner && s.level !== "owner" && u.id !== me.id;
                return (
                  <tr key={u.id} className="border-t border-stone-800 align-top">
                    <td className="p-2">
                      <div className="font-semibold">{displayName(u.id)}</div>
                      <div className="text-xs text-stone-400">{emailFor(me, u.email)}</div>
                    </td>
                    <td>{s.source}</td>
                    <td>
                      {editable ? (
                        <form action={`/api/admin/moderation/admins/${u.id}/powers`} method="post" className="flex flex-wrap items-center gap-3">
                          {POWER_KEYS.map((k) => (
                            <label key={k}><input type="checkbox" name={k} defaultChecked={s.powers[k]} /> {k}</label>
                          ))}
                          <button className={buttonSecondary}>Save</button>
                        </form>
                      ) : s.level === "owner" ? "all (owner)" : POWER_KEYS.filter((k) => s.powers[k]).join(", ") || "none"}
                    </td>
                    <td>
                      {editable && s.hasRow && !s.envAdmin && (
                        <form action={`/api/admin/moderation/admins/${u.id}/demote`} method="post"><button className={buttonDanger}>Demote</button></form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
          <h2 className="font-semibold uppercase text-stone-400">Promote a player</h2>
          <form action="/api/admin/moderation/admins" method="post" className="flex gap-3 text-sm">
            <input className={input} name="email" type="email" required maxLength={254} placeholder="exact email of a verified player" />
            <button className={button}>Promote</button>
          </form>
          <p className="text-xs text-stone-500">New game admins start with no powers. Only the owner can grant them.</p>
        </section>

      <section className="space-y-3">
        <h2 className="font-semibold uppercase text-stone-400">Servers</h2>
        <table className="w-full text-left text-sm">
          <thead className="text-stone-500"><tr><th className="p-2">Server</th><th>Status</th><th>Players</th><th /></tr></thead>
          <tbody>
            {servers.map((s) => {
              const status = adminListStatus(s, now);
              const halted = s.updaterState === "halted";
              return (
                <Fragment key={s.id}>
                  <tr className="border-t border-stone-800">
                    <td className="p-2"><div className="font-semibold">{s.name}</div><div className="text-xs text-stone-400">{s.region}</div></td>
                    <td className={adminListStatusClass[status]}>{status}</td>
                    <td>{s.lastHeartbeatAt ? `${s.players}/${s.adminMaxPlayers}` : "—"}</td>
                    <td><Link className="underline" href={`/admin/moderation/servers/${s.id}`}>Players</Link></td>
                  </tr>
                  {halted && (
                    <tr data-updater-row={s.id}>
                      <td colSpan={4} className="px-2 pb-2"><UpdaterHaltBanner server={s} /></td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {!servers.length && <p className="p-2 text-stone-500">No active servers.</p>}
      </section>
    </div>
  );
}
