"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import type { Screen } from "@/content/screens";

// Native <dialog> gives us the focus trap, Esc-to-close and inert background for free.
export function Gallery({ items }: { items: Screen[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const thumbs = useRef<(HTMLButtonElement | null)[]>([]);
  const [i, setI] = useState<number | null>(null);

  const open = (n: number) => {
    setI(n);
    dialog.current?.showModal();
  };
  const step = (d: number) => setI((n) => (n === null ? n : (n + d + items.length) % items.length));
  const cur = i === null ? null : items[i];

  return (
    <>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((s, n) => (
          <li key={s.src}>
            <button
              ref={(el) => {
                thumbs.current[n] = el;
              }}
              type="button"
              onClick={() => open(n)}
              className="group block w-full text-left focus:outline-none"
              aria-label={`Open screenshot: ${s.caption}`}
            >
              <span className="relative block aspect-video overflow-hidden rounded border border-stone-800 group-hover:border-amber-600 group-focus-visible:border-amber-500 group-focus-visible:ring-2 group-focus-visible:ring-amber-500">
                <Image src={s.thumb} alt={s.alt} fill sizes="(min-width: 1024px) 240px, (min-width: 640px) 33vw, 50vw" className="object-cover" />
              </span>
              <span className="mt-1 block text-xs text-stone-400">{s.caption}</span>
            </button>
          </li>
        ))}
      </ul>

      <dialog
        ref={dialog}
        aria-label={cur ? cur.caption : "Screenshot"}
        onClose={() => {
          if (i !== null) thumbs.current[i]?.focus();
          setI(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") step(1);
          if (e.key === "ArrowLeft") step(-1);
        }}
        onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}
        className="m-auto w-[min(95vw,1600px)] bg-transparent p-0 text-stone-200 backdrop:bg-black/85"
      >
        {cur && (
          <figure>
            <div className="relative aspect-video w-full bg-black">
              <Image src={cur.src} alt={cur.alt} fill sizes="95vw" className="object-contain" />
            </div>
            <figcaption className="mt-2 flex items-center gap-3 text-sm">
              <button type="button" onClick={() => step(-1)} className="rounded border border-stone-700 px-3 py-1 hover:border-amber-600" aria-label="Previous screenshot">
                ←
              </button>
              <span className="flex-1 text-center" aria-live="polite">
                {cur.caption} <span className="text-stone-500">({i! + 1} / {items.length})</span>
              </span>
              <button type="button" onClick={() => step(1)} className="rounded border border-stone-700 px-3 py-1 hover:border-amber-600" aria-label="Next screenshot">
                →
              </button>
              <button type="button" onClick={() => dialog.current?.close()} className="rounded border border-stone-700 px-3 py-1 hover:border-amber-600" aria-label="Close" autoFocus>
                ✕
              </button>
            </figcaption>
          </figure>
        )}
      </dialog>
    </>
  );
}
