import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const Manifest = z.object({
  version: z.string().min(1).max(64),
  filename: z.string().min(1).max(255),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  size: z.number().int().nonnegative(),
});
export type Manifest = z.infer<typeof Manifest>;

export const launcherDir = () => path.resolve(/*turbopackIgnore: true*/ process.env.LAUNCHER_DIR ?? "./launcher");

/** Returns null when no launcher has been dropped in yet (or the manifest is malformed). */
export async function readVolumeManifest(): Promise<Manifest | null> {
  try {
    const m = Manifest.parse(JSON.parse(await readFile(path.join(launcherDir(), "manifest.json"), "utf8")));
    // basename: the manifest must not point outside LAUNCHER_DIR
    return { ...m, filename: path.basename(m.filename) };
  } catch {
    return null;
  }
}
