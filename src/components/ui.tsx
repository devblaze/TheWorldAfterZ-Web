import type { ReactNode } from "react";

export const input =
  "w-full rounded border border-stone-700 bg-stone-900 px-3 py-2 text-stone-100 placeholder-stone-500 focus:border-amber-600 focus:outline-none";
export const button =
  "inline-block rounded bg-amber-700 px-4 py-2 font-semibold uppercase tracking-wide text-stone-950 hover:bg-amber-600 disabled:opacity-50";
export const buttonSecondary =
  "inline-block rounded border border-stone-600 px-4 py-2 text-sm font-semibold uppercase tracking-wide text-stone-200 hover:border-amber-600 hover:text-amber-500";
export const buttonDanger = "rounded bg-red-800 px-3 py-1 text-sm font-semibold text-stone-100 hover:bg-red-700";

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-md rounded border border-stone-800 bg-stone-900/80 p-6 shadow-lg">
      <h1 className="mb-4 text-2xl font-bold uppercase tracking-widest text-amber-500">{title}</h1>
      {children}
    </section>
  );
}

export function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block space-y-1">
      <span className="text-sm text-stone-400">{label}</span>
      <input className={input} {...props} />
    </label>
  );
}

export function Notice({ kind = "info", children }: { kind?: "info" | "error"; children: ReactNode }) {
  const c = kind === "error" ? "border-red-800 bg-red-950/60 text-red-200" : "border-amber-800 bg-amber-950/40 text-amber-100";
  return (
    <p role={kind === "error" ? "alert" : "status"} className={`mb-4 rounded border px-3 py-2 text-sm ${c}`}>
      {children}
    </p>
  );
}

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
