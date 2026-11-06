"use client";

import { useState } from "react";
import { button, input } from "@/components/ui";

type Minted = { codes: string[]; tier: string; batchLabel: string };

export default function MintForm() {
  const [minted, setMinted] = useState<Minted | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function mint(form: FormData) {
    setBusy(true);
    setError("");
    const res = await fetch("/api/admin/keys/mint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: Number(form.get("count")), tier: form.get("tier"), batchLabel: form.get("batchLabel") }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) return setError("Mint failed. Check the inputs.");
    setMinted(await res.json());
  }

  function downloadCsv() {
    if (!minted) return;
    const csv = ["code,tier,batch", ...minted.codes.map((c) => `${c},${minted.tier},"${minted.batchLabel.replace(/"/g, '""')}"`)].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `twaz-keys-${minted.batchLabel.replace(/[^\w.-]/g, "_")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (minted) {
    return (
      <div className="space-y-3 rounded border border-amber-800 p-4">
        <p className="font-semibold text-amber-400">
          {minted.codes.length} {minted.tier} keys minted. Copy or download them now: they are shown only once.
        </p>
        <textarea readOnly className={`${input} h-48 font-mono text-xs`} value={minted.codes.join("\n")} />
        <div className="flex gap-3">
          <button className={button} onClick={downloadCsv}>Download CSV</button>
          <button className="underline" onClick={() => setMinted(null)}>Done (discard)</button>
        </div>
      </div>
    );
  }

  return (
    <form action={mint} className="flex flex-wrap items-end gap-3">
      <label className="text-sm">Count<input className={input} name="count" type="number" min={1} max={500} defaultValue={10} required /></label>
      <label className="text-sm">Tier
        <select className={input} name="tier" defaultValue="BETA"><option>ALPHA</option><option>BETA</option></select>
      </label>
      <label className="text-sm">Batch label<input className={input} name="batchLabel" required maxLength={64} pattern="[\w .\-]+" /></label>
      <button className={button} disabled={busy}>Mint</button>
      {error && <p role="alert" className="w-full text-sm text-red-400">{error}</p>}
    </form>
  );
}
