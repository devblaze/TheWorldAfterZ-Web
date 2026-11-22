// Clean marketing stills from the 0.73 Unity player build. Files live in public/screens.
export type Screen = { src: string; thumb: string; alt: string; caption: string };

const s = (slug: string, alt: string, caption: string): Screen => ({
  src: `/screens/${slug}.webp`,
  thumb: `/screens/${slug}-thumb.webp`,
  alt,
  caption,
});

export const screens: Screen[] = [
  s(
    "grass-country-afternoon",
    "Low view across a countryside meadow in the afternoon, with tall grass, bushes and trees under a clear blue sky",
    "Grass in the afternoon",
  ),
  s(
    "hud-town-shop",
    "A brick town shop standing in open grassland at day, with the survival HUD along the bottom showing vitals and an empty hotbar, and the clock reading 14:01 Day",
    "The survival HUD",
  ),
  s(
    "interior-house-b",
    "Dim interior of a house: a stone fireplace, a doorway with a lit lantern, and a broken window looking out onto grass and trees",
    "Inside a house",
  ),
  s(
    "night-flashlight-street",
    "Night outside a brick building, a flashlight beam lighting the wall and an open doorway, with the clock showing 21:24 Night and the survival HUD visible",
    "Night, flashlight on",
  ),
  s(
    "horde-town-road",
    "A group of zombies walking across open ground toward the camera, with town buildings and a treeline in the distance",
    "A horde on the road",
  ),
  s(
    "main-menu",
    "Main menu for The World After Z over a foggy dusk city, with Refresh, Join, Character and Quit options",
    "The main menu",
  ),
];

export const screen = (slug: string) => screens.find((x) => x.src === `/screens/${slug}.webp`)!;
