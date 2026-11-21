import { prisma } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { methodNotAllowed, readJsonBody } from "@/lib/launcher/http";
import { authenticateAccess, bearerToken } from "@/lib/launcher/store";
import { activeRedemption } from "@/lib/session";
import { limitBugReportGrant } from "@/lib/rate-limit";
import {
  BUG_REPORT_AUDIT, GRANT_TTL_SEC_DEFAULT, GrantRequest, newUploadToken, reportJson,
} from "@/lib/bug-reports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notAllowed = methodNotAllowed("POST");
export { notAllowed as GET, notAllowed as PUT, notAllowed as PATCH, notAllowed as DELETE, notAllowed as OPTIONS };

export async function POST(req: Request) {
  try {
    const token = bearerToken(req.headers.get("authorization"));
    if (!token) return reportJson({ error: "invalid_token" }, 401);
    const auth = await authenticateAccess(token);
    if (!auth.ok) return reportJson({ error: auth.error }, 401);

    const gate = await limitBugReportGrant(auth.userId);
    if (!gate.ok) return reportJson({ error: "rate_limited" }, 429, { "Retry-After": String(gate.retryAfter) });

    if (!auth.emailVerifiedAt) return reportJson({ error: "unverified" }, 403);
    if (!(await activeRedemption(auth.userId))) return reportJson({ error: "no_key" }, 403);

    const raw = await readJsonBody(req, 1024);
    if (!raw) return reportJson({ error: "invalid_request" }, 400);
    const parsed = GrantRequest.safeParse(raw.value ?? {});
    if (!parsed.success) return reportJson({ error: "invalid_request" }, 400);
    const ttlSec = parsed.data.ttlSec ?? GRANT_TTL_SEC_DEFAULT;
    const uploadToken = newUploadToken();
    const expiresAt = new Date(Date.now() + ttlSec * 1000);
    await prisma.$transaction(async (tx) => {
      await tx.bugReportGrant.create({
        data: { tokenHash: sha256(uploadToken), userId: auth.userId, expiresAt },
      });
      await tx.auditLog.create({
        data: { actorId: auth.userId, action: BUG_REPORT_AUDIT.grantCreated, targetId: auth.userId, meta: { ttlSec } },
      });
    });
    return reportJson({ uploadToken, expiresAt: expiresAt.toISOString(), accountId: auth.userId });
  } catch (err) {
    console.error("bug-report grant failed", err instanceof Error ? err.name : "error");
    return reportJson({ error: "server_error" }, 500);
  }
}
