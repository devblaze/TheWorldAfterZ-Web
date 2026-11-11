import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { artifactIdentity, prepareDownload, readManifest } from "../src/lib/manifest";
import { MAX_LAUNCHER_SIZE, safePlatformPath } from "../src/lib/launcher-feed";
import { signDownload, verifyDownload } from "../src/lib/crypto";

vi.mock("@/lib/db", () => ({ prisma: { downloadEvent: { create: vi.fn().mockResolvedValue({}) } } }));
vi.mock("@/lib/session", () => ({ currentUser: vi.fn(), activeRedemption: vi.fn() }));
const { GET: issueLink } = await import("../src/app/api/download/route");
const { GET: serveFile } = await import("../src/app/api/download/file/route");
const { currentUser, activeRedemption } = await import("../src/lib/session");

const bytes = Buffer.from("verified launcher executable fixture");
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const sha = hash(bytes);
const volume = { version: "old", filename: "old.exe", size: 3, sha256: hash(Buffer.from("old")) };
let server: Server;
let root: string;
let port: number;
let sequence = 0;
let base: string;
let metadataCalls: number;
let objectCalls: number;
let objectPaths: string[];
let objectStatus: number;
let latest: unknown;
let manifest: unknown;
let object: Buffer;
let status: number;
let delay: number;
let contentEncoding: string | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.includes("objects/")) {
      objectCalls++;
      objectPaths.push(req.url!);
      res.statusCode = objectStatus;
      if (contentEncoding) res.setHeader("Content-Encoding", contentEncoding);
      res.end(object);
      return;
    }
    metadataCalls++;
    const send = () => {
      res.statusCode = status;
      res.end(JSON.stringify(req.url?.endsWith("latest.json") ? latest : manifest));
    };
    if (delay) { const timer = setTimeout(send, delay); res.on("close", () => clearTimeout(timer)); }
    else send();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "twaz-feed-test-"));
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(volume));
  await writeFile(path.join(root, volume.filename), "old");
  base = `http://127.0.0.1:${port}/${++sequence}/`;
  vi.stubEnv("DOWNLOAD_SIGNING_SECRET", "unit-test-only-secret");
  vi.mocked(currentUser).mockResolvedValue({ id: "unit-player" } as Awaited<ReturnType<typeof currentUser>>);
  vi.mocked(activeRedemption).mockResolvedValue({} as NonNullable<Awaited<ReturnType<typeof activeRedemption>>>);
  vi.stubEnv("LAUNCHER_FEED_URL", base);
  vi.stubEnv("LAUNCHER_DIR", root);
  vi.stubEnv("LAUNCHER_CACHE_DIR", path.join(root, "cache"));
  latest = { schema: 1, platforms: { "win-x64": "manifests/current/win-x64.json" } };
  manifest = { launcher: { version: "0.2.11", executable: "TwazLauncher.exe", files: [
    { path: "TwazLauncher.exe", size: bytes.length, sha256: sha.toUpperCase(), exec: true },
  ] } };
  object = bytes;
  status = objectStatus = 200;
  objectPaths = [];
  delay = 0;
  metadataCalls = objectCalls = 0;
  contentEncoding = undefined;
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
function file() {
  return (manifest as { launcher: { files: { encoding?: string; size: number; sha256: string }[] } }).launcher.files[0];
}

for (const encoding of ["plain", "gzip"]) {
  it(`resolves and verifies ${encoding}, caching decoded bytes atomically`, async () => {
    if (encoding === "gzip") { file().encoding = "gzip"; object = gzipSync(bytes); }
    const m = await readManifest();
    expect(m).toMatchObject({ version: "0.2.11", filename: "TwazLauncher.exe", sha256: sha, size: bytes.length });
    expect(objectCalls).toBe(0); // page metadata never blocks on the object
    const results = await Promise.all(Array.from({ length: 5 }, () => prepareDownload(m)));
    expect(objectCalls).toBe(1);
    expect(objectPaths[0]).toBe(`/${sequence}/objects/${sha}${encoding === "gzip" ? ".gz" : ""}`);
    expect(results.every(r => r?.file === path.join(root, "cache", sha))).toBe(true);
    expect(await readFile(results[0]!.file)).toEqual(bytes);
    expect(await readdir(path.join(root, "cache"))).toEqual([sha]);
    await prepareDownload(m);
    expect(objectCalls).toBe(1);
    await readManifest();
    expect(metadataCalls).toBe(2); // latest + manifest, cached across reads
  });
}

it.each(["/abs", "https://elsewhere/a", "//elsewhere/a", "a/../b", "..", "a\\b", "a:b", "%2e%2e/a", "a?x", "a#x", "a/..\t/b"])("rejects unsafe platform %s", async platform => {
  expect(safePlatformPath(platform)).toBe(false);
  latest = { schema: 1, platforms: { "win-x64": platform } };
  expect(await readManifest()).toEqual(volume);
  expect(metadataCalls).toBe(1);
});

it.each(["sha", "short", "long", "gzip-bomb"])("falls back to volume after %s mismatch and removes partial cache", async kind => {
  if (kind === "sha") object = Buffer.alloc(bytes.length, 1);
  if (kind === "short") object = bytes.subarray(0, -1);
  if (kind === "long") object = Buffer.concat([bytes, bytes]);
  if (kind === "gzip-bomb") { file().encoding = "gzip"; object = gzipSync(Buffer.alloc(1024 * 1024)); }
  const prepared = await prepareDownload(await readManifest());
  expect(prepared?.manifest).toEqual(volume);
  expect(await readManifest()).toEqual(volume);
  expect(await readdir(path.join(root, "cache"))).toEqual([]);
});

it("rejects an oversized declaration before downloading", async () => {
  file().size = MAX_LAUNCHER_SIZE + 1;
  expect(await readManifest()).toEqual(volume);
  expect(objectCalls).toBe(0);
});
it("repairs a corrupt cache instead of trusting its filename", async () => {
  const m = await readManifest();
  const prepared = await prepareDownload(m);
  await writeFile(prepared!.file, "corrupt");
  expect(await readFile((await prepareDownload(m))!.file)).toEqual(bytes);
  expect(objectCalls).toBe(2);
});
it("does not double-decode a Content-Encoding object", async () => {
  file().encoding = "gzip";
  object = gzipSync(bytes);
  contentEncoding = "gzip";
  expect((await prepareDownload(await readManifest()))?.manifest).toEqual(volume);
});
it.each(["launcher", "schema", "sha", "size", "version", "encoding", "executable", "metadata-cap"])("falls back for invalid %s", async kind => {
  if (kind === "launcher") manifest = {};
  if (kind === "schema") latest = { schema: 2, platforms: { "win-x64": "manifest.json" } };
  if (kind === "sha") file().sha256 = "bad";
  if (kind === "size") file().size = -1;
  if (kind === "encoding") file().encoding = "br";
  if (kind === "version") (manifest as { launcher: { version: string } }).launcher.version = "";
  if (kind === "executable") (manifest as { launcher: { executable: string } }).launcher.executable = "missing.exe";
  if (kind === "metadata-cap") latest = { padding: "x".repeat(256 * 1024) };
  expect(await readManifest()).toEqual(volume);
});
it("falls back when the feed is down", async () => {
  status = 503;
  expect(await readManifest()).toEqual(volume);
  expect(await readManifest()).toEqual(volume);
  expect(metadataCalls).toBe(1);
});
it("times out stalled metadata and falls back", async () => {
  delay = 10_000;
  expect(await readManifest()).toEqual(volume);
}, 10_000);
it("refreshes metadata after 60 seconds", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  await readManifest();
  clock.mockReturnValue(now + 60_001);
  await readManifest();
  expect(metadataCalls).toBe(4);
});
it.each(["", "file:///tmp/", "https://example.test/no-slash", "ftp://example.test/", "https://example.test/?x=/"])("uses volume only for disabled or invalid base %s", async url => {
  vi.stubEnv("LAUNCHER_FEED_URL", url);
  expect(await readManifest()).toEqual(volume);
  expect(metadataCalls).toBe(0);
});
it("uses only the volume with LAUNCHER_FEED_URL unset", async () => {
  delete process.env.LAUNCHER_FEED_URL;
  expect(await readManifest()).toEqual(volume);
  expect((await prepareDownload(await readManifest()))?.file).toBe(path.join(root, volume.filename));
  expect(metadataCalls).toBe(0);
});
it("returns unavailable if neither feed nor volume is available", async () => {
  manifest = {};
  await rm(path.join(root, "manifest.json"));
  expect(await readManifest()).toBeNull();
  expect(await prepareDownload(null)).toBeNull();
});
it("binds the signature to the exact SHA, not just the executable name", async () => {
  const m = (await readManifest())!;
  const secret = "test-only";
  const { exp, sig } = signDownload(artifactIdentity(m), secret);
  expect(verifyDownload(String(exp), sig, artifactIdentity(m), secret)).toBe(true);
  expect(verifyDownload(String(exp), sig, artifactIdentity({ ...m, sha256: "0".repeat(64) }), secret)).toBe(false);
  expect(verifyDownload(String(exp), sig, artifactIdentity(volume), secret)).toBe(false);
});

it("issues an expiring link and serves only decoded verified executable bytes", async () => {
  file().encoding = "gzip";
  object = gzipSync(bytes);
  const redirect = await issueLink(new Request("http://site.test/api/download"));
  expect(redirect.status).toBe(302);
  const response = await serveFile(new Request(new URL(redirect.headers.get("location")!, "http://site.test")));
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="TwazLauncher.exe"');
  expect(response.headers.get("Content-Length")).toBe(String(bytes.length));
  expect(response.headers.get("X-Checksum-SHA256")).toBe(sha);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
});
it("signs the volume fallback, never the failed feed object", async () => {
  object = Buffer.from("bad");
  const redirect = await issueLink(new Request("http://site.test/api/download"));
  expect(redirect.status).toBe(302);
  const response = await serveFile(new Request(new URL(redirect.headers.get("location")!, "http://site.test")));
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from("old"));
});
it("rejects a same-name SHA change at the file route", async () => {
  const redirect = await issueLink(new Request("http://site.test/api/download"));
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
  file().sha256 = "1".repeat(64);
  const response = await serveFile(new Request(new URL(redirect.headers.get("location")!, "http://site.test")));
  expect(response.status).toBe(403);
  expect(objectCalls).toBe(1);
});
it("rejects unsigned file requests before downloading objects", async () => {
  expect((await serveFile(new Request("http://site.test/api/download/file"))).status).toBe(403);
  expect(objectCalls).toBe(0);
});
it("does not stream unverified feed bytes if a signed object's transfer fails", async () => {
  const m = (await readManifest())!;
  const { exp, sig } = signDownload(artifactIdentity(m), process.env.DOWNLOAD_SIGNING_SECRET!);
  object = Buffer.from("corrupt");
  const response = await serveFile(new Request(`http://site.test/api/download/file?exp=${exp}&sig=${sig}`));
  expect(response.status).toBe(503); // cannot replay this signature onto the old volume artifact
});
it("preserves the existing unauthenticated and unentitled gates without fetching metadata", async () => {
  vi.mocked(currentUser).mockResolvedValue(null);
  expect((await issueLink(new Request("http://site.test/api/download"))).status).toBe(401);
  vi.mocked(currentUser).mockResolvedValue({ id: "unit-player" } as Awaited<ReturnType<typeof currentUser>>);
  vi.mocked(activeRedemption).mockResolvedValue(null);
  expect((await issueLink(new Request("http://site.test/api/download"))).status).toBe(403);
  expect(metadataCalls).toBe(0);
});

it("falls back on a missing immutable object", async () => {
  objectStatus = 404;
  expect((await prepareDownload(await readManifest()))?.manifest).toEqual(volume);
  expect(await readdir(path.join(root, "cache"))).toEqual([]);
});
it("returns unavailable after integrity failure if the fallback is absent", async () => {
  object = Buffer.from("bad");
  await rm(path.join(root, "manifest.json"));
  expect(await prepareDownload(await readManifest())).toBeNull();
  expect(await readManifest()).toBeNull();
});
