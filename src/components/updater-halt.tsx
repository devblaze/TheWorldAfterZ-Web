import { updaterHalt } from "@/lib/servers";

const reportedAt = (d: Date) => new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Athens", dateStyle: "medium", timeStyle: "short",
}).format(d) + " (Athens)";

/**
 * Red banner for a server whose self-updater reported "halted" in its last heartbeat; nothing when ok or not
 * reported. The reason comes from the game server, so it is rendered as React text only (escaped), never as HTML.
 */
export function UpdaterHaltBanner({ server }: { server: { updaterState: string | null; updaterReason: string | null; updaterReportedAt: Date | null } }) {
  const halt = updaterHalt(server);
  if (!halt) return null;
  return (
    <div role="alert" data-updater-halted="" className="rounded border border-red-700 bg-red-950 p-2 text-sm text-red-200">
      <span className="font-semibold">Updater halted:</span>{" "}
      <span className="break-words">{halt.reason ?? "no reason reported"}</span>
      {halt.reportedAt && <span className="text-xs text-red-300/80"> · reported {reportedAt(halt.reportedAt)}</span>}
      <div className="text-xs text-red-300/80">Automatic updates are stopped until an operator runs <code>twaz-server-updater unhalt</code> on the host.</div>
    </div>
  );
}
