import Image from "next/image";
import Link from "next/link";
import { button } from "@/components/ui";
import { Gallery } from "@/components/gallery";
import { screen, screens, type Screen } from "@/content/screens";

type Feature = { title: string; body: string; wip?: boolean; shot?: Screen };

const features: Feature[] = [
  {
    title: "Sound-driven hordes",
    body: "The dead go after noise. They come to investigate, lose interest, and may even walk off a rooftop toward a sound. Throw a bottle to lure them somewhere else.",
  },
  {
    title: "Headshots only",
    body: "Only a headshot puts one down. Shoot the legs to slow it until it crawls. Take out the arms and it can't grab you, so all it can do is bite.",
  },
  {
    title: "Dark nights",
    body: "Night is really dark. Lamps, fires, flashlights and lit windows are what let you see.",
    shot: screen("night-street"),
  },
  {
    title: "Health, hunger, thirst",
    body: "Keep all three up. The HUD also tracks your body temperature against how cold it feels outside.",
    shot: screen("walker-at-car"),
  },
  {
    title: "Four seasons",
    body: "In winter you need shelter and warmth. In summer you need shade and more water.",
    wip: true,
  },
  {
    title: "Destructible world",
    body: "Buildings can be damaged and destroyed. Tall ones collapse with real physics.",
    wip: true,
  },
  {
    title: "A massive shared world",
    body: "A large multiplayer world where the server is the authority on what happens.",
    wip: true,
  },
];

const hero = screen("main-street");

export default function Home() {
  return (
    <div className="space-y-20">
      <section className="relative -mt-10 overflow-hidden rounded-b border-x border-b border-stone-800 sm:rounded">
        <Image src={hero.src} alt="" fill preload sizes="(min-width: 1024px) 1024px, 100vw" className="absolute inset-0 size-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-b from-stone-950/70 via-stone-950/60 to-stone-950" />
        <div className="relative space-y-8 px-4 py-24 text-center sm:py-32">
          <h1 className="text-5xl font-black uppercase tracking-widest text-amber-600 drop-shadow-lg sm:text-7xl">
            The World After <span className="text-red-600">Z</span>
          </h1>
          <p className="mx-auto max-w-2xl text-lg text-stone-300">
            The cities went dark. The dead still walk. Scavenge, build and hold the line with whoever is left.
            Access is invite-only while we test: redeem your key to get the launcher.
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <Link href="/register" className={button}>Join the survivors</Link>
            <Link href="/login" className="rounded border border-stone-600 bg-stone-950/60 px-4 py-2 uppercase tracking-wide hover:border-amber-600">
              Sign in
            </Link>
          </div>
        </div>
      </section>

      <section aria-labelledby="features" className="space-y-6">
        <h2 id="features" className="text-3xl font-black uppercase tracking-widest text-amber-500">What you&apos;ll survive</h2>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <li key={f.title} className="overflow-hidden rounded border border-stone-800 bg-stone-900/80">
              {f.shot && (
                <div className="relative aspect-video">
                  <Image src={f.shot.thumb} alt={f.shot.alt} fill sizes="(min-width: 1024px) 330px, (min-width: 640px) 50vw, 100vw" className="absolute inset-0 size-full object-cover" />
                </div>
              )}
              <div className="space-y-2 p-4">
                <h3 className="flex flex-wrap items-center gap-2 font-bold uppercase tracking-wide text-stone-100">
                  {f.title}
                  {f.wip && (
                    <span className="rounded border border-red-800 bg-red-950/60 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-red-300">
                      In development
                    </span>
                  )}
                </h3>
                <p className="text-sm text-stone-400">{f.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="gallery" className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="gallery" className="text-3xl font-black uppercase tracking-widest text-amber-500">From the build</h2>
          <p className="text-sm text-stone-500">Early alpha captures. Work in progress.</p>
        </div>
        <Gallery items={screens} />
      </section>

      <section aria-labelledby="join" className="rounded border border-amber-900/60 bg-gradient-to-br from-amber-950/50 to-red-950/40 p-6 sm:p-10">
        <h2 id="join" className="mb-6 text-2xl font-black uppercase tracking-widest text-amber-500">Get in</h2>
        <ol className="grid gap-4 sm:grid-cols-3">
          {[
            { n: 1, t: "Register", d: "Create your account and verify your email.", href: "/register", cta: "Register" },
            { n: 2, t: "Redeem your key", d: "Enter your alpha or beta access key.", href: "/redeem", cta: "Redeem" },
            { n: 3, t: "Download", d: "Get TheWorldAfterZ Launcher for Windows.", href: "/download", cta: "Download" },
          ].map((s) => (
            <li key={s.n} className="space-y-2">
              <p className="text-sm font-bold uppercase tracking-wide text-stone-100">
                <span className="mr-2 text-red-500">{s.n}.</span>
                {s.t}
              </p>
              <p className="text-sm text-stone-400">{s.d}</p>
              <Link href={s.href} className={button}>{s.cta}</Link>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
