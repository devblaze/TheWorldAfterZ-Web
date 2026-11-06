import { z } from "zod";
import { prisma } from "@/lib/db";
import { generateKey, keyPrefix, sha256 } from "@/lib/crypto";
import { adminOrNull, json } from "@/lib/session";

const Input = z.object({
  count: z.number().int().min(1).max(500),
  tier: z.enum(["ALPHA", "BETA"]),
  batchLabel: z.string().trim().min(1).max(64).regex(/^[\w .-]+$/),
});

export async function POST(req: Request) {
  const admin = await adminOrNull();
  if (!admin) return json({ error: "forbidden" }, 403);
  const parsed = Input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid input" }, 400);
  const { count, tier, batchLabel } = parsed.data;

  const codes = Array.from({ length: count }, generateKey);
  await prisma.$transaction([
    prisma.accessKey.createMany({
      data: codes.map((c) => ({ codeHash: sha256(c), codePrefix: keyPrefix(c), tier, batchLabel, createdById: admin.id })),
    }),
    prisma.auditLog.create({ data: { actorId: admin.id, action: "KEYS_MINTED", meta: { count, tier, batchLabel } } }),
  ]);
  // The only time plaintext codes ever leave the server.
  return json({ codes, tier, batchLabel });
}
