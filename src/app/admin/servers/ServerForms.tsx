"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { button, buttonDanger, input } from "@/components/ui";

const PLATFORMS = ["win-x64", "linux-x64"];

async function post(url: string, body?: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
}

const compatFrom = (form: FormData) => ({
  gameBuild: form.get("gameBuild"),
  buildFamily: form.get("buildFamily"),
  protocolVersion: Number(form.get("protocolVersion")),
  clientPlatforms: form.getAll("clientPlatforms"),
});

/** Shown once; lives only in this component's state and is gone on Done or navigation. */
function SecretOnce({ id, secret, onDone }: { id: string; secret: string; onDone: () => void }) {
  return (
    <div className="space-y-3 rounded border border-amber-800 p-4">
      <p className="font-semibold text-amber-400">Copy these into the dedicated server host env now: the secret is shown only once.</p>
      <label className="block text-sm">TWAZ_SERVER_ID<input readOnly className={`${input} font-mono text-xs`} value={id} /></label>
      <label className="block text-sm">TWAZ_SERVER_SECRET<input readOnly className={`${input} font-mono text-xs`} value={secret} autoComplete="off" /></label>
      <button className="underline" onClick={onDone}>Done (discard)</button>
    </div>
  );
}

function CompatFields({ d }: { d?: { gameBuild: string; buildFamily: string; protocolVersion: number; clientPlatforms: string[] } }) {
  return (
    <>
      <label className="text-sm">Game build<input className={input} name="gameBuild" required maxLength={64} pattern="[\w.+\-]+" defaultValue={d?.gameBuild} /></label>
      <label className="text-sm">Build family<input className={input} name="buildFamily" required maxLength={64} pattern="[\w.+\-]+" defaultValue={d?.buildFamily} /></label>
      <label className="text-sm">Protocol<input className={input} name="protocolVersion" type="number" min={0} required defaultValue={d?.protocolVersion} /></label>
      <fieldset className="text-sm">
        <legend>Client platforms</legend>
        {PLATFORMS.map((p) => (
          <label key={p} className="mr-3"><input type="checkbox" name="clientPlatforms" value={p} defaultChecked={d ? d.clientPlatforms.includes(p) : true} /> {p}</label>
        ))}
      </fieldset>
    </>
  );
}

export function CreateServerForm() {
  const router = useRouter();
  const [created, setCreated] = useState<{ id: string; secret: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function create(form: FormData) {
    setBusy(true);
    setError("");
    const res = await post("/api/admin/servers", {
      name: form.get("name"),
      region: form.get("region"),
      host: form.get("host"),
      port: Number(form.get("port")),
      ...compatFrom(form),
    });
    setBusy(false);
    if (!res?.ok) return setError("Create failed. Check the inputs.");
    setCreated(await res.json());
    router.refresh();
  }

  if (created) return <SecretOnce {...created} onDone={() => setCreated(null)} />;
  return (
    <form action={create} className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm">Name<input className={input} name="name" required maxLength={64} pattern="[\w .\-]+" /></label>
      <label className="text-sm">Region<input className={input} name="region" required maxLength={32} pattern="[\w .\-]+" placeholder="eu" /></label>
      <label className="text-sm">Host<input className={input} name="host" required maxLength={253} placeholder="play.example.org" /></label>
      <label className="text-sm">Port<input className={input} name="port" type="number" min={1} max={65535} required defaultValue={7777} /></label>
      <CompatFields />
      <div><button className={button} disabled={busy}>Create</button></div>
      {error && <p role="alert" className="text-sm text-red-400 sm:col-span-2">{error}</p>}
    </form>
  );
}

export function ServerActions({ server }: { server: { id: string; active: boolean; gameBuild: string; buildFamily: string; protocolVersion: number; clientPlatforms: string[] } }) {
  const router = useRouter();
  const [rotated, setRotated] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  async function act(path: string, confirmText: string) {
    if (!confirm(confirmText)) return;
    const res = await post(`/api/admin/servers/${server.id}/${path}`);
    if (!res?.ok) return setMsg(`${path} failed.`);
    if (path === "rotate") setRotated((await res.json()).secret);
    router.refresh();
  }

  async function updateCompat(form: FormData) {
    const res = await post(`/api/admin/servers/${server.id}/compat`, compatFrom(form));
    setMsg(res?.ok ? "Compatibility updated." : "Update failed. Check the inputs.");
    if (res?.ok) router.refresh();
  }

  if (rotated) return <SecretOnce id={server.id} secret={rotated} onDone={() => setRotated(null)} />;
  if (!server.active) return <span className="text-stone-500">disabled</span>;
  return (
    <div className="space-y-2">
      <form action={updateCompat} className="flex flex-wrap items-end gap-2"><CompatFields d={server} /><button className={button}>Save</button></form>
      <div className="flex gap-2">
        <button className={buttonDanger} onClick={() => act("rotate", "Rotate the secret? The old one stops working immediately.")}>Rotate secret</button>
        <button className={buttonDanger} onClick={() => act("disable", "Disable this server? All its calls will be refused.")}>Disable</button>
      </div>
      {msg && <p role="status" className="text-sm text-stone-400">{msg}</p>}
    </div>
  );
}
