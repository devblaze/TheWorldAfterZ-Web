import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { verifyDownload } from "@/lib/crypto";
import { artifactIdentity, prepareDownload, readManifest } from "@/lib/manifest";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const manifest = await readManifest();
  if (!manifest || !verifyDownload(q.get("exp"), q.get("sig"), artifactIdentity(manifest), process.env.DOWNLOAD_SIGNING_SECRET!)) {
    return new Response("Link invalid or expired", { status: 403 });
  }
  const prepared = await prepareDownload(manifest);
  // A fallback or promotion must never replay the signature onto another artifact.
  if (!prepared || artifactIdentity(prepared.manifest) !== artifactIdentity(manifest)) {
    return new Response("Launcher not available yet", { status: 503 });
  }
  const { file } = prepared;
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return new Response("Launcher not available yet", { status: 503 });

  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(info.size),
      "Content-Disposition": `attachment; filename="${manifest.filename.replace(/["\\\r\n]/g, "_")}"`,
      "X-Checksum-SHA256": manifest.sha256,
      "Cache-Control": "private, no-store",
    },
  });
}
