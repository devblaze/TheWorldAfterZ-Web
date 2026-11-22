import { prisma } from "@/lib/db";
import { requireAdminPage } from "@/lib/session";
import { adminListStatus, adminListStatusClass } from "@/lib/servers";
import { UpdaterHaltBanner } from "@/components/updater-halt";
import { CreateServerForm, ServerActions } from "./ServerForms";

export const dynamic = "force-dynamic";

const displayTime = (date: Date) => new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Athens", dateStyle: "medium", timeStyle: "short",
}).format(date) + " (Athens)";

export default async function AdminServers() {
  await requireAdminPage();
  // Never select secretHash.
  const servers = await prisma.officialServer.findMany({
    select: {
      id: true, name: true, region: true, host: true, port: true, status: true, gameBuild: true, buildFamily: true,
      protocolVersion: true, clientPlatforms: true, lastHeartbeatAt: true, players: true, maxPlayers: true, adminMaxPlayers: true,
      reportedGameBuild: true, serverRuntime: true, secretRotatedAt: true,
      updaterState: true, updaterReason: true, updaterReportedAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  // eslint-disable-next-line react-hooks/purity -- server component, rendered per request
  const now = Date.now();

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold uppercase tracking-widest text-amber-500">Official servers</h1>
      <section className="space-y-3">
        <h2 className="font-semibold uppercase text-stone-400">Register</h2>
        <CreateServerForm />
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold uppercase text-stone-400">Servers</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-stone-500">
              <tr><th className="p-2">Server</th><th>Status</th><th>Last heartbeat</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {servers.map((s) => {
                const status = adminListStatus(s, now);
                return (
                  <tr key={s.id} className="border-t border-stone-800 align-top">
                    <td className="p-2">
                      <div className="font-semibold">{s.name}</div>
                      <div className="font-mono text-xs text-stone-400">{s.id}</div>
                      <div className="text-stone-400">{s.region} · {s.host}:{s.port}</div>
                      <div className="text-sm text-stone-300">capacity {s.adminMaxPlayers} players (admin-set)</div>
                      {s.secretRotatedAt ? (
                        <div className="text-xs text-stone-500">secret rotated {displayTime(s.secretRotatedAt)}</div>
                      ) : (
                        <div className="text-xs text-amber-400">no secret yet: generate one below to let it heartbeat</div>
                      )}
                      <UpdaterHaltBanner server={s} />
                    </td>
                    <td className={adminListStatusClass[status]}>{status}</td>
                    <td className="text-stone-400">
                      {s.lastHeartbeatAt ? (
                        <>
                          {displayTime(s.lastHeartbeatAt)}
                          <div className="text-xs">{s.players}/{s.adminMaxPlayers} · {s.reportedGameBuild} · {s.serverRuntime}</div>
                          {s.maxPlayers !== s.adminMaxPlayers && (
                            <div className="text-xs text-amber-400">server last reported a cap of {s.maxPlayers}</div>
                          )}
                        </>
                      ) : "never"}
                    </td>
                    <td><ServerActions server={{ id: s.id, active: s.status === "ACTIVE", host: s.host, port: s.port, gameBuild: s.gameBuild, buildFamily: s.buildFamily, protocolVersion: s.protocolVersion, clientPlatforms: s.clientPlatforms, maxPlayers: s.adminMaxPlayers, hasSecret: !!s.secretRotatedAt }} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!servers.length && <p className="p-2 text-stone-500">No servers registered.</p>}
        </div>
      </section>
    </div>
  );
}
