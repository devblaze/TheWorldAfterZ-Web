import { prisma } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { adminOrNull, json } from "@/lib/session";
import { CreateServer, newServerSecret, SERVER_AUDIT } from "@/lib/servers";

export async function POST(req: Request) {
  try {
    const admin = await adminOrNull();
    if (!admin) return json({ error: "forbidden" }, 403);
    const parsed = CreateServer.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid input" }, 400);

    const secret = newServerSecret();
    const server = await prisma.$transaction(async (tx) => {
      const s = await tx.officialServer.create({
        data: { ...parsed.data, secretHash: sha256(secret), secretRotatedAt: new Date(), createdById: admin.id },
        select: { id: true, name: true },
      });
      await tx.auditLog.create({ data: { actorId: admin.id, action: SERVER_AUDIT.created, targetId: s.id, meta: { name: s.name } } });
      return s;
    });
    // The only time this secret leaves the server.
    return json({ id: server.id, secret });
  } catch {
    // Do not log request bodies, credentials, hashes or database error details.
    return json({ error: "server_error" }, 500);
  }
}
