import { readFeedManifest } from "./launcher-feed";
import { readVolumeManifest, type Manifest } from "./launcher-volume";

export { launcherDir, readVolumeManifest, type Manifest } from "./launcher-volume";
export { artifactIdentity, prepareDownload } from "./launcher-feed";

/** Metadata only: never waits for the executable download. */
export async function readManifest(): Promise<Manifest | null> {
  return (await readFeedManifest()) ?? readVolumeManifest();
}
