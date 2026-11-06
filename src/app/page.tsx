import Link from "next/link";
import { button } from "@/components/ui";

export default function Home() {
  return (
    <div className="space-y-10 py-10 text-center">
      <h1 className="text-5xl font-black uppercase tracking-widest text-amber-600 sm:text-7xl">
        The World After <span className="text-red-600">Z</span>
      </h1>
      <p className="mx-auto max-w-2xl text-lg text-stone-400">
        The cities went dark. The dead still walk. Scavenge, build and hold the line with whoever is left.
        Access is invite-only while we test: redeem your key to get the launcher.
      </p>
      <div className="flex justify-center gap-4">
        <Link href="/register" className={button}>Join the survivors</Link>
        <Link href="/login" className="rounded border border-stone-700 px-4 py-2 uppercase tracking-wide hover:border-amber-600">
          Sign in
        </Link>
      </div>
    </div>
  );
}
