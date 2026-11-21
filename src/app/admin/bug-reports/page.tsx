import Link from "next/link";
import { input, one, type SearchParams } from "@/components/ui";
import { prisma } from "@/lib/db";
import { displayName } from "@/lib/crypto";
import { emailFor } from "@/lib/moderation";
import { requireBugReportsPage } from "@/lib/session";
import { CATEGORIES, NET_MODES } from "@/lib/bug-reports";

export const dynamic = "force-dynamic";

const displayTime = (date: Date) => new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Athens", dateStyle: "medium", timeStyle: "short",
}).format(date) + " (Athens)";

export default async function AdminBugReports({ searchParams }: { searchParams: SearchParams }) {
  const { standing } = await requireBugReportsPage();
  const sp = await searchParams;
  const category = one(sp.category)?.trim() ?? "";
  const build = one(sp.build)?.trim() ?? "";
  const server = one(sp.server)?.trim() ?? "";
  const mode = one(sp.mode)?.trim() ?? "";

  const reports = await prisma.bugReport.findMany({
    where: {
      ...(CATEGORIES.includes(category as typeof CATEGORIES[number]) ? { category } : {}),
      ...(NET_MODES.includes(mode as typeof NET_MODES[number]) ? { netMode: mode } : {}),
      ...(build ? { OR: [{ buildVersion: { contains: build } }, { buildFamily: { contains: build } }] } : {}),
      ...(server ? { OR: [{ serverId: { contains: server } }, { serverName: { contains: server } }] } : {}),
    },
    select: {
      id: true, createdAt: true, category: true, netMode: true,
      buildVersion: true, buildFamily: true, serverId: true, serverName: true,
      includeReplay: true, userId: true, user: { select: { email: true } },
      _count: { select: { screenshots: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold uppercase tracking-widest text-amber-500">Bug reports</h1>
      <form className="flex flex-wrap gap-3 text-sm" method="get">
        <select className={input} name="category" defaultValue={category} aria-label="Category">
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className={input} name="mode" defaultValue={mode} aria-label="Network mode">
          <option value="">All modes</option>
          {NET_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <input className={input} name="build" defaultValue={build} placeholder="build version or family" />
        <input className={input} name="server" defaultValue={server} placeholder="server id or name" />
        <button className="rounded border border-stone-600 px-3 py-2 hover:border-amber-600">Filter</button>
      </form>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-stone-500">
            <tr>
              <th className="p-2">When</th>
              <th>Category</th>
              <th>Mode</th>
              <th>Build</th>
              <th>Server</th>
              <th>Player</th>
              <th>Attachments</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => (
              <tr key={r.id} className="border-t border-stone-800 align-top">
                <td className="p-2 whitespace-nowrap">{displayTime(r.createdAt)}</td>
                <td>{r.category}</td>
                <td>{r.netMode}</td>
                <td>
                  <div>{r.buildVersion}</div>
                  <div className="text-xs text-stone-500">{r.buildFamily}</div>
                </td>
                <td>
                  {r.serverName || r.serverId || "—"}
                  {r.serverId && r.serverName ? <div className="font-mono text-xs text-stone-500">{r.serverId}</div> : null}
                </td>
                <td>
                  <div>{displayName(r.userId)}</div>
                  <div className="text-xs text-stone-400">{emailFor(standing, r.user.email)}</div>
                </td>
                <td>
                  {r.includeReplay ? "replay" : "no replay"}
                  {r._count.screenshots ? ` · ${r._count.screenshots} shot${r._count.screenshots === 1 ? "" : "s"}` : ""}
                </td>
                <td><Link className="underline" href={`/admin/bug-reports/${r.id}`}>View</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!reports.length && <p className="p-2 text-stone-500">No reports match.</p>}
      </div>
    </div>
  );
}
