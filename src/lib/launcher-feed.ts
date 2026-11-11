import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { z } from "zod";
import { launcherDir, readVolumeManifest, type Manifest } from "./launcher-volume";

export const MAX_LAUNCHER_SIZE = 512 * 1024 * 1024;
const TTL = 60_000;
const METADATA_LIMIT = 256 * 1024;
const File = z.object({
  path: z.string().min(1).max(255),
  size: z.number().int().nonnegative().max(MAX_LAUNCHER_SIZE),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  exec: z.boolean(),
  encoding: z.string().optional(),
  storedSize: z.number().int().nonnegative().max(MAX_LAUNCHER_SIZE).optional(),
});
const Launcher = z.object({
  version: z.string().min(1).max(64),
  executable: z.string().min(1).max(255),
  files: z.array(File).max(1024),
});
const Latest = z.object({ schema: z.literal(1), platforms: z.object({ "win-x64": z.string().max(2048) }) });
export type FeedManifest = Manifest & { objectUrl: string; encoding?: string; feedBase: string };
let metadata: { base: string; until: number; value: FeedManifest | null } | undefined;
const pending = new Map<string, Promise<string>>();

export const artifactIdentity = (m: Manifest) => `${m.filename}@${m.sha256.toLowerCase()}`;
const cacheDir = () => path.resolve(/*turbopackIgnore: true*/ process.env.LAUNCHER_CACHE_DIR || "/tmp/twaz-launcher-cache");

function baseUrl() {
  const raw = process.env.LAUNCHER_FEED_URL;
  if (!raw) return null;
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol) || !raw.endsWith("/") || u.search || u.hash || u.username || u.password) throw new Error("Invalid feed base");
  return u.href;
}

export function safePlatformPath(value: string) {
  return !!value && !/[\x00-\x20\x7f]/.test(value) && !value.startsWith("/") && !value.includes(":") && !value.includes("\\") &&
    !value.includes("%") && !value.includes("?") && !value.includes("#") && !value.split("/").includes("..");
}

async function json(url: string) {
  const signal = AbortSignal.timeout(5_000);
  const response = await fetch(url, { signal, redirect: "error", cache: "no-store" });
  if (!response.ok || !response.body) throw new Error("Feed unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > METADATA_LIMIT) throw new Error("Metadata too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function readFeedManifest(): Promise<FeedManifest | null> {
  let base: string | null;
  try { base = baseUrl(); } catch { return null; }
  if (!base) return null;
  if (metadata?.base === base && metadata.until > Date.now()) return metadata.value;
  try {
    const latest = Latest.parse(await json(`${base}playtest/latest.json`));
    const relative = latest.platforms["win-x64"];
    if (!safePlatformPath(relative)) throw new Error("Unsafe platform path");
    const manifest = z.object({ launcher: Launcher.optional() }).parse(await json(`${base}${relative}`));
    if (!manifest.launcher) throw new Error("No launcher");
    const { launcher } = manifest;
    const f = launcher.files.find(f => f.path === launcher.executable);
    if (!f || (f.encoding && f.encoding !== "gzip")) throw new Error("Unsupported launcher");
    // Never allow path/control characters into the attachment filename.
    const filename = path.posix.basename(launcher.executable);
    if (!filename || /[\\"\r\n\x00-\x1f]/.test(filename)) throw new Error("Invalid executable");
    const sha256 = f.sha256.toLowerCase();
    const value: FeedManifest = { version: launcher.version, filename, size: f.size, sha256,
      objectUrl: `${base}objects/${sha256}${f.encoding === "gzip" ? ".gz" : ""}`, encoding: f.encoding, feedBase: base };
    metadata = { base, until: Date.now() + TTL, value };
    return value;
  } catch {
    metadata = { base, until: Date.now() + TTL, value: null };
    return null;
  }
}

function verifier(m: Manifest) {
  let size = 0;
  const hash = createHash("sha256");
  return new Transform({
    transform(chunk, _encoding, cb) {
      size += chunk.length;
      if (size > m.size || size > MAX_LAUNCHER_SIZE) return cb(new Error("Launcher too large"));
      hash.update(chunk);
      cb(null, chunk);
    },
    flush(cb) {
      cb(size !== m.size || hash.digest("hex") !== m.sha256 ? new Error("Launcher integrity mismatch") : null);
    },
  });
}

async function cached(m: FeedManifest) {
  const destination = path.join(cacheDir(), m.sha256);
  try {
    // Revalidate disk bytes, including after a restart; never trust a partial/corrupt cache entry.
    await pipeline(createReadStream(destination), verifier(m), new Transform({ transform(_c, _e, cb) { cb(); } }));
    return destination;
  } catch { /* missing or corrupt: replace atomically after verification */ }
  await mkdir(cacheDir(), { recursive: true, mode: 0o700 });
  const temp = `${destination}.${randomUUID()}.tmp`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    // Native HTTP deliberately avoids fetch's transparent Content-Encoding decompression.
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = (m.objectUrl.startsWith("https:") ? https : http).get(m.objectUrl,
        { signal: controller.signal, headers: { "Accept-Encoding": "identity" } }, resolve);
      request.on("error", reject);
    });
    if (response.statusCode !== 200 || (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")) {
      response.destroy();
      throw new Error("Object unavailable or unexpected transfer encoding");
    }
    let wireSize = 0;
    const wireCap = new Transform({ transform(chunk, _e, cb) {
      wireSize += chunk.length;
      cb(wireSize > MAX_LAUNCHER_SIZE ? new Error("Stored object too large") : null, chunk);
    } });
    const stages = [response, wireCap, ...(m.encoding === "gzip" ? [createGunzip()] : []), verifier(m), createWriteStream(temp, { flags: "wx", mode: 0o600 })];
    await pipeline(stages, { signal: controller.signal });
    await rename(temp, destination);
    return destination;
  } finally {
    clearTimeout(timer);
    await rm(temp, { force: true });
  }
}

async function ensureCached(m: FeedManifest) {
  const key = `${cacheDir()}/${m.sha256}:${m.size}`;
  let job = pending.get(key);
  if (!job) {
    job = cached(m).finally(() => pending.delete(key));
    pending.set(key, job);
  }
  return job;
}

/** Resolve and verify before issuing a link, so a failed feed can safely use the volume. */
export async function prepareDownload(m: Manifest | null): Promise<{ manifest: Manifest; file: string } | null> {
  if (m && "objectUrl" in m) {
    const feed = m as FeedManifest;
    try { return { manifest: m, file: await ensureCached(feed) }; }
    catch {
      metadata = { base: feed.feedBase, until: Date.now() + TTL, value: null };
      m = await readVolumeManifest();
    }
  }
  return m ? { manifest: m, file: path.join(launcherDir(), m.filename) } : null;
}
