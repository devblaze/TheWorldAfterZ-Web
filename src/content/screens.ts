// Real early-alpha captures from the Unity build. Swap images here; files live in public/screens.
export type Screen = { src: string; thumb: string; alt: string; caption: string };

const s = (slug: string, alt: string, caption: string): Screen => ({
  src: `/screens/${slug}.webp`,
  thumb: `/screens/${slug}-thumb.webp`,
  alt,
  caption,
});

export const screens: Screen[] = [
  s("main-street", "A wide, empty street at dusk lined with dark brick buildings and unlit street lamps", "Dusk on the main street"),
  s("phase1-street", "A dim street with abandoned cars and broken windows under a pale evening sky", "Dusk on the Phase 1 street"),
  s("dusk-horde", "Silhouettes of a crowd of zombies gathering around cars at the far end of a darkening street, with health, hunger and thirst bars in the corner", "A horde gathering at dusk"),
  s("walker-at-car", "A zombie rising from behind an abandoned car in the gloom, survival HUD showing full health, hunger and thirst", "A walker behind an abandoned car"),
  s("night-street", "A nearly black street at night where only a few distant lamps give any light", "Night: only the lamps give light"),
  s("stress-walker", "A single zombie shuffling toward the camera on a grey test map with more walkers behind it", "Stress test: a walker up close"),
  s("stress-close", "Zombies pressing in around the player on a grey test map, health bar down to 65", "Stress test: a horde closing in"),
];

export const screen = (slug: string) => screens.find((x) => x.src === `/screens/${slug}.webp`)!;
