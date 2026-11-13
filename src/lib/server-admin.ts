import type { Prisma } from "@prisma/client";
import { SERVER_AUDIT } from "./servers";

export type CapacitySource = "web" | "launcher";

/**
 * Sets the admin capacity under a row lock and audits old/new. Returns null when the server does not exist.
 * The heartbeat takes FOR UPDATE on the same row, so it returns either the old or the new value, never a torn one.
 */
export async function setServerCapacity(
  tx: Prisma.TransactionClient,
  input: { serverId: string; maxPlayers: number; actorId: string; source: CapacitySource },
): Promise<{ old: number; new: number } | null> {
  const rows = await tx.$queryRaw<{ adminMaxPlayers: number }[]>`
    SELECT "adminMaxPlayers" FROM "OfficialServer" WHERE "id" = ${input.serverId} FOR UPDATE`;
  const existing = rows[0];
  if (!existing) return null;
  await tx.officialServer.update({ where: { id: input.serverId }, data: { adminMaxPlayers: input.maxPlayers } });
  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      action: SERVER_AUDIT.capacityChanged,
      targetId: input.serverId,
      meta: { oldMaxPlayers: existing.adminMaxPlayers, newMaxPlayers: input.maxPlayers, source: input.source },
    },
  });
  return { old: existing.adminMaxPlayers, new: input.maxPlayers };
}
