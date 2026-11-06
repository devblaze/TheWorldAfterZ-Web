import { signDownload } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { readManifest } from "@/lib/manifest";
import { ipFrom } from "@/lib/rate-limit";
import { activeRedemption, currentUser } from "@/lib/session";

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (!(await activeRedemption(user.id))) return new Response("Forbidden", { status: 403 });
  const manifest = await readManifest();
  if (!manifest) return new Response("Launcher not available yet", { status: 503 });

  await prisma.downloadEvent.create({
    data: { userId: user.id, artifactVersion: manifest.version, ip: ipFrom(req.headers) },
  });
  const { exp, sig } = signDownload(manifest.filename, process.env.DOWNLOAD_SIGNING_SECRET!);
  return new Response(null, {
    status: 302,
    headers: { Location: `/api/download/file?exp=${exp}&sig=${sig}`, "Cache-Control": "no-store" },
  });
}
