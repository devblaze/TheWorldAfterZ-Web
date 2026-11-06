// Clean marketing stills from the Unity build (Phase1 street + main menu). Files live in public/screens.
export type Screen = { src: string; thumb: string; alt: string; caption: string };

const s = (slug: string, alt: string, caption: string): Screen => ({
  src: `/screens/${slug}.webp`,
  thumb: `/screens/${slug}-thumb.webp`,
  alt,
  caption,
});

export const screens: Screen[] = [
  s(
    "street-dusk",
    "First-person view down a brick-lined city street at dusk, pistol raised toward silhouettes of zombies and abandoned cars in the distance, with survival vitals and a hotbar visible",
    "Dusk on the street",
  ),
  s(
    "horde-closing",
    "First-person view of zombies closing in mid-street at dusk, pistol in hand, with health, hunger and thirst icons in the corner",
    "A horde closing in",
  ),
  s(
    "hud-vitals",
    "First-person view down a dusk street toward distant zombies, pistol in hand, with health, stamina, hunger, thirst and body temperature gauges and the weapon hotbar along the bottom",
    "The survival HUD",
  ),
  s(
    "zombie-closeup",
    "Close-up of a bald zombie in a torn dark shirt and shredded pants, lit from the side against a black background",
    "One of the dead, up close",
  ),
  s(
    "street-night",
    "Nearly black first-person street at night lit only by a few distant orange streetlamps, survival bars and pistol ammo shown on the HUD",
    "Night: only the lamps give light",
  ),
  s(
    "main-menu",
    "Main menu for The World After Z over a rainy, foggy city skyline, with host and join options and a playtest build tag",
    "The main menu",
  ),
];

export const screen = (slug: string) => screens.find((x) => x.src === `/screens/${slug}.webp`)!;
