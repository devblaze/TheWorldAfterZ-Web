import type { Prisma } from "@prisma/client";
import type { z } from "zod";
import { prisma } from "@/lib/db";
import { launcherJson, readJsonBody } from "@/lib/launcher/http";
import { rateLimit, retryAfterSeconds } from "@/lib/rate-limit";
import { etagFor, ifNoneMatchHits } from "@/lib/etag";
import { parseServerAuth, secretMatches, SERVER_LIMITS } from "@/lib/servers";

export type LockedServer = { id: string; buildFamily: string; protocolVersion: number; instanceNonce: string | null };

const invalidServer = () => launcherJson({ error: "invalid_server" }, 401);

/**
 * Shared shell of the server-authenticated POST routes: credential (no cookies) -> per-server rate limit -> bounded strict JSON
 * -> one transaction that re-checks the credential under a FOR SHARE row lock (a rotate/disable that committed first is seen;
 * one that comes later waits for us; heartbeat's FOR UPDATE serializes against us) and runs `work`. Anything unexpected is 500.
 */
export async function serverPost<S extends z.ZodType>(
  req: Request,
  kind: keyof typeof SERVER_LIMITS,
  bodyMax: number,
  schema: S,
  work: (tx: Prisma.TransactionClient, server: LockedServer, body: z.infer<S>) => Promise<unknown>,
  /** `pathId`: the {id} of /api/servers/{id}/... routes, 403 when it is not the authenticated server. `invalidStatus`: 422 on the new routes, 400 on the old ones. */
  opts: { pathId?: string; invalidStatus?: 400 | 422 } = {},
) {
  try {
    const cred = parseServerAuth(req.headers.get("authorization"));
    if (!cred) return invalidServer();
    const pre = await prisma.officialServer.findUnique({ where: { id: cred.serverId }, select: { status: true, secretHash: true } });
    if (!secretMatches(cred.secret, pre?.secretHash) || pre?.status !== "ACTIVE") return invalidServer();
    if (opts.pathId !== undefined && cred.serverId !== opts.pathId) return launcherJson({ error: "forbidden" }, 403);

    const { prefix, limit, windowMs } = SERVER_LIMITS[kind];
    if (!(await rateLimit(`${prefix}:${cred.serverId}`, limit, windowMs))) {
      return launcherJson({ error: "rate_limited" }, 429, { "Retry-After": String(retryAfterSeconds(windowMs)) });
    }

    const body = await readJsonBody(req, bodyMax);
    const parsed = body && schema.safeParse(body.value);
    if (!parsed?.success) return launcherJson({ error: "invalid_request" }, opts.invalidStatus ?? 400);

    const out = await prisma.$transaction(async (tx) => {
      const [s] = await tx.$queryRaw<(LockedServer & { status: string; secretHash: string | null })[]>`
        SELECT "id", "status"::text AS "status", "secretHash", "buildFamily", "protocolVersion", "instanceNonce"
        FROM "OfficialServer" WHERE "id" = ${cred.serverId} FOR SHARE`;
      if (!s || s.status !== "ACTIVE" || !secretMatches(cred.secret, s.secretHash)) return null;
      return work(tx, s, parsed.data);
    }, { timeout: 4_000, maxWait: 1_000 });
    return out === null ? invalidServer() : out instanceof Response ? out : launcherJson(out);
  } catch (err) {
    // Never log the request, a ticket, a secret or database details.
    console.error(`server ${kind} failed`, err instanceof Error ? err.name : "error");
    return launcherJson({ error: "server_error" }, 500);
  }
}

/**
 * Shell of the server-authenticated GET routes: credential (no cookies) -> path id must be the authenticated server -> per-server
 * rate limit (a 304 counts too; the path id must be this server, else 403) -> one REPEATABLE READ snapshot, so `version` and the list always agree -> strong ETag / 304.
 */
export async function serverGet(
  req: Request,
  kind: keyof typeof SERVER_LIMITS,
  pathId: string,
  work: (tx: Prisma.TransactionClient, serverId: string) => Promise<unknown>,
) {
  try {
    const cred = parseServerAuth(req.headers.get("authorization"));
    if (!cred) return invalidServer();
    const pre = await prisma.officialServer.findUnique({ where: { id: cred.serverId }, select: { status: true, secretHash: true } });
    if (!secretMatches(cred.secret, pre?.secretHash) || pre?.status !== "ACTIVE") return invalidServer();
    if (cred.serverId !== pathId) return launcherJson({ error: "forbidden" }, 403);

    const { prefix, limit, windowMs } = SERVER_LIMITS[kind];
    if (!(await rateLimit(`${prefix}:${cred.serverId}`, limit, windowMs))) {
      return launcherJson({ error: "rate_limited" }, 429, { "Retry-After": String(retryAfterSeconds(windowMs)) });
    }

    const body = await prisma.$transaction(async (tx) => {
      const s = await tx.officialServer.findUnique({ where: { id: cred.serverId }, select: { status: true, secretHash: true } });
      if (s?.status !== "ACTIVE" || !secretMatches(cred.secret, s.secretHash)) return null;
      return work(tx, cred.serverId);
    }, { isolationLevel: "RepeatableRead", timeout: 4_000, maxWait: 1_000 });
    if (body === null) return invalidServer();

    const etag = etagFor(body);
    if (ifNoneMatchHits(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-store" } });
    return launcherJson(body, 200, { ETag: etag });
  } catch (err) {
    console.error(`server ${kind} failed`, err instanceof Error ? err.name : "error");
    return launcherJson({ error: "server_error" }, 500);
  }
}
