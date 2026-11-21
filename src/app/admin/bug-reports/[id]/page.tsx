import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { displayName } from "@/lib/crypto";
import { emailFor } from "@/lib/moderation";
import { requireBugReportsPage } from "@/lib/session";
import { buttonSecondary } from "@/components/ui";
import { REPORT_ID_RE } from "@/lib/bug-reports";

export const dynamic = "force-dynamic";

const displayTime = (date: Date) => new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Athens", dateStyle: "medium", timeStyle: "short",
}).format(date) + " (Athens)";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function MetaTable({ title, data }: { title: string; data: Record<string, unknown> }) {
  const entries = Object.entries(data);
  return (
    <section className="space-y-2">
      <h2 className="font-semibold uppercase text-stone-400">{title}</h2>
      {entries.length === 0 ? <p className="text-sm text-stone-500">None.</p> : (
        <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 text-sm">
          {entries.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-stone-500">{k}</dt>
              <dd className="break-all">{v == null || v === "" ? "—" : String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export default async function AdminBugReport({ params }: { params: Promise<{ id: string }> }) {
  const { standing } = await requireBugReportsPage();
  const { id } = await params;
  if (!REPORT_ID_RE.test(id)) notFound();
  const row = await prisma.bugReport.findUnique({
    where: { id },
    include: { user: { select: { email: true } }, screenshots: { orderBy: { index: "asc" } } },
  });
  if (!row) notFound();
  const logTail = Array.isArray(row.logTail) ? row.logTail as { t?: number; lv?: string; m?: string }[] : [];

  return (
    <div className="space-y-8">
      <p className="text-sm text-stone-400"><Link className="underline" href="/admin/bug-reports">All reports</Link></p>
      <h1 className="text-2xl font-bold uppercase tracking-widest text-amber-500">Report {row.id}</h1>
      <p className="text-sm text-stone-400">
        {displayTime(row.createdAt)} · {row.category} · {row.netMode} · {displayName(row.userId)} · {emailFor(standing, row.user.email)}
      </p>

      <section className="space-y-2">
        <h2 className="font-semibold uppercase text-stone-400">Description</h2>
        <p className="whitespace-pre-wrap text-sm text-stone-200">{row.description}</p>
      </section>

      <MetaTable title="Build" data={{ version: row.buildVersion, family: row.buildFamily, sha: row.buildSha, branch: row.buildBranch, date: row.buildDate }} />
      <MetaTable title="Network" data={asRecord(row.net)} />
      <MetaTable title="Session" data={asRecord(row.session)} />
      <MetaTable title="Platform" data={asRecord(row.platform)} />
      <MetaTable title="GPU" data={asRecord(row.gpu)} />
      <MetaTable title="Performance" data={asRecord(row.perf)} />

      <section className="space-y-2">
        <h2 className="font-semibold uppercase text-stone-400">Replay</h2>
        {row.replayKey ? (
          <p className="text-sm">
            <a className={buttonSecondary} href={`/api/admin/bug-reports/${row.id}/replay`}>Download replay</a>
            <span className="ml-3 text-stone-500">{row.replayBytes ?? 0} bytes</span>
          </p>
        ) : <p className="text-sm text-stone-500">No replay attached.</p>}
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold uppercase text-stone-400">Screenshots</h2>
        {row.screenshots.length === 0 ? <p className="text-sm text-stone-500">None.</p> : (
          <div className="flex flex-wrap gap-4">
            {row.screenshots.map((s) => (
              <a key={s.id} href={`/api/admin/bug-reports/${row.id}/screenshots/${s.index}`} className="block max-w-xs">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/admin/bug-reports/${row.id}/screenshots/${s.index}`}
                  alt={`Screenshot ${s.index + 1}`}
                  className="max-h-64 rounded border border-stone-700"
                />
              </a>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold uppercase text-stone-400">Log tail</h2>
        {logTail.length === 0 ? <p className="text-sm text-stone-500">None.</p> : (
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded border border-stone-800 bg-stone-950 p-3 text-xs text-stone-300">
            {logTail.map((line, i) => {
              const when = typeof line.t === "number" ? new Date(line.t).toISOString() : "";
              return `${when} ${line.lv ?? ""} ${line.m ?? ""}`.trim() + (i === logTail.length - 1 ? "" : "\n");
            }).join("")}
          </pre>
        )}
      </section>
    </div>
  );
}
