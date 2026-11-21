import { prisma } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { methodNotAllowed } from "@/lib/launcher/http";
import { bearerToken } from "@/lib/launcher/store";
import {
  BUG_REPORT_AUDIT, BugReportBody, REPLAY_CONTENT_TYPE, REPLAY_MAX_BYTES, REPORT_JSON_MAX,
  REPORTS_PER_DAY, REPORTS_PER_HOUR, REQUEST_MAX_BYTES, SCREENSHOT_CONTENT_TYPE, SCREENSHOT_MAX_BYTES,
  SCREENSHOTS_MAX_COUNT, SCREENSHOTS_TOTAL_MAX, contentTypeOf, findForbiddenReportContent, invalidReport,
  isGzip, isJpeg, newReportId, readBodyCapped, reportJson, retryAfterFrom, type BugReportPayload,
} from "@/lib/bug-reports";
import { putBugReportBlob, removeBugReportBlob } from "@/lib/bug-report-storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notAllowed = methodNotAllowed("POST");
export { notAllowed as GET, notAllowed as PUT, notAllowed as PATCH, notAllowed as DELETE, notAllowed as OPTIONS };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type Shot = { index: number; bytes: Buffer };

async function consumeGrant(token: string) {
  const tokenHash = sha256(token);
  const now = new Date();
  const rows = await prisma.$queryRaw<{ id: string; userId: string }[]>`
    UPDATE "BugReportGrant"
    SET "usedAt" = ${now}
    WHERE "tokenHash" = ${tokenHash} AND "usedAt" IS NULL AND "expiresAt" > ${now}
    RETURNING "id", "userId"`;
  return rows[0] ?? null;
}

async function uploadRateLimit(userId: string, now = new Date()) {
  const hourSince = new Date(now.getTime() - HOUR_MS);
  const daySince = new Date(now.getTime() - DAY_MS);
  const [hourRows, dayRows] = await Promise.all([
    prisma.bugReport.findMany({ where: { userId, createdAt: { gte: hourSince } }, select: { createdAt: true }, orderBy: { createdAt: "asc" } }),
    prisma.bugReport.findMany({ where: { userId, createdAt: { gte: daySince } }, select: { createdAt: true }, orderBy: { createdAt: "asc" } }),
  ]);
  if (hourRows.length >= REPORTS_PER_HOUR) {
    return { ok: false as const, retryAfter: retryAfterFrom(hourRows[0].createdAt, HOUR_MS, now.getTime()) };
  }
  if (dayRows.length >= REPORTS_PER_DAY) {
    return { ok: false as const, retryAfter: retryAfterFrom(dayRows[0].createdAt, DAY_MS, now.getTime()) };
  }
  return { ok: true as const };
}

async function partBuffer(part: FormDataEntryValue | null, max: number): Promise<Buffer | null | "too_large"> {
  if (part == null) return null;
  if (typeof part === "string") {
    const buf = Buffer.from(part, "utf8");
    return buf.length > max ? "too_large" : buf;
  }
  if (typeof part.arrayBuffer !== "function") return null;
  // size is available on File; still cap when reading
  if (typeof (part as File).size === "number" && (part as File).size > max) return "too_large";
  const buf = Buffer.from(await part.arrayBuffer());
  return buf.length > max ? "too_large" : buf;
}

async function parseReport(form: FormData): Promise<{ ok: true; data: BugReportPayload } | { response: Response }> {
  const rawPart = form.get("report");
  if (rawPart == null) return { response: invalidReport("Missing report part.", { report: "required" }) };
  const buf = await partBuffer(rawPart, REPORT_JSON_MAX);
  if (buf === "too_large") return { response: reportJson({ error: "too_large" }, 413) };
  if (!buf) return { response: invalidReport("Missing report part.", { report: "required" }) };
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString("utf8"));
  } catch {
    return { response: invalidReport("Report is not valid JSON.", { report: "invalid" }) };
  }
  const forbidden = findForbiddenReportContent(raw);
  if (forbidden) return { response: invalidReport("Report contains a forbidden field.", { [forbidden]: "forbidden" }) };
  const parsed = BugReportBody.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.map(String).join(".") || "report";
      if (!fields[key]) fields[key] = issue.message;
    }
    return { response: invalidReport("Report failed validation.", fields) };
  }
  return { ok: true, data: parsed.data };
}

async function parseReplay(form: FormData, includeReplay: boolean): Promise<{ ok: true; bytes: Buffer | null } | { response: Response }> {
  const part = form.get("replay");
  if (!includeReplay) {
    if (part != null && !(typeof part === "string" && part === "")) {
      return { response: invalidReport("Replay must be omitted when includeReplay is false.", { replay: "unexpected" }) };
    }
    return { ok: true, bytes: null };
  }
  if (part == null) return { response: invalidReport("Replay is required when includeReplay is true.", { replay: "required" }) };
  if (typeof part !== "string" && part.type && contentTypeOf(part) !== REPLAY_CONTENT_TYPE && contentTypeOf(part) !== "application/x-gzip") {
    return { response: invalidReport("Replay must be application/gzip.", { replay: "content-type" }) };
  }
  const buf = await partBuffer(part, REPLAY_MAX_BYTES);
  if (buf === "too_large") return { response: reportJson({ error: "too_large" }, 413) };
  if (!buf || !isGzip(buf)) return { response: invalidReport("Replay must be a gzip file.", { replay: "invalid" }) };
  return { ok: true, bytes: buf };
}

async function parseScreenshots(form: FormData, includeReplay: boolean): Promise<{ ok: true; shots: Shot[] } | { response: Response }> {
  const parts = form.getAll("screenshots[]");
  const maxCount = includeReplay ? SCREENSHOTS_MAX_COUNT : 1;
  if (parts.length > maxCount) {
    return { response: invalidReport(`At most ${maxCount} screenshot(s) allowed.`, { screenshots: "too_many" }) };
  }
  const shots: Shot[] = [];
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (typeof part !== "string" && part.type && contentTypeOf(part) !== SCREENSHOT_CONTENT_TYPE) {
      return { response: invalidReport("Screenshots must be image/jpeg.", { screenshots: "content-type" }) };
    }
    const buf = await partBuffer(part, SCREENSHOT_MAX_BYTES);
    if (buf === "too_large") return { response: reportJson({ error: "too_large" }, 413) };
    if (!buf || !isJpeg(buf)) return { response: invalidReport("Screenshots must be JPEG files.", { screenshots: "invalid" }) };
    total += buf.length;
    if (total > SCREENSHOTS_TOTAL_MAX) return { response: reportJson({ error: "too_large" }, 413) };
    shots.push({ index: i, bytes: buf });
  }
  return { ok: true, shots };
}

export async function POST(req: Request) {
  const stored: string[] = [];
  try {
    const token = bearerToken(req.headers.get("authorization"));
    if (!token) return reportJson({ error: "unauthorized" }, 401);

    const ctype = (req.headers.get("content-type") ?? "").toLowerCase();
    if (!ctype.includes("multipart/form-data")) {
      return invalidReport("Expected multipart/form-data.", { request: "content-type" });
    }

    const body = await readBodyCapped(req, REQUEST_MAX_BYTES);
    if (!body.ok) return reportJson({ error: "too_large" }, 413);

    const formReq = new Request(req.url, { method: "POST", headers: { "content-type": req.headers.get("content-type") ?? "" }, body: new Uint8Array(body.buf) });
    let form: FormData;
    try {
      form = await formReq.formData();
    } catch {
      return invalidReport("Could not parse multipart body.", { request: "multipart" });
    }

    const report = await parseReport(form);
    if (!("ok" in report)) return report.response;
    const replay = await parseReplay(form, report.data.includeReplay);
    if (!("ok" in replay)) return replay.response;
    const shots = await parseScreenshots(form, report.data.includeReplay);
    if (!("ok" in shots)) return shots.response;

    // Rate-limit against the grant's account before consuming, so a 429 can be retried with a new grant.
    // Resolve the hash without consuming first? Two concurrent uses of one token: check then consume atomically.
    const peeked = await prisma.bugReportGrant.findUnique({ where: { tokenHash: sha256(token) } });
    const now = new Date();
    if (!peeked || peeked.usedAt || peeked.expiresAt <= now) return reportJson({ error: "unauthorized" }, 401);

    const rate = await uploadRateLimit(peeked.userId, now);
    if (!rate.ok) return reportJson({ error: "rate_limited" }, 429, { "Retry-After": String(rate.retryAfter) });

    const grant = await consumeGrant(token);
    if (!grant) return reportJson({ error: "unauthorized" }, 401);

    let replayStored: { key: string; sha256: string; bytes: number } | null = null;
    if (replay.bytes) {
      replayStored = await putBugReportBlob(replay.bytes, "gz");
      stored.push(replayStored.key);
    }
    const shotStored: { index: number; key: string; sha256: string; bytes: number }[] = [];
    for (const s of shots.shots) {
      const put = await putBugReportBlob(s.bytes, "jpg");
      stored.push(put.key);
      shotStored.push({ index: s.index, ...put });
    }

    const id = newReportId();
    const createdAt = new Date();
    const p = report.data;
    await prisma.$transaction(async (tx) => {
      await tx.bugReport.create({
        data: {
          id,
          schemaVersion: p.schemaVersion,
          userId: grant.userId,
          category: p.category,
          description: p.description,
          includeReplay: p.includeReplay,
          clientSubmittedAt: new Date(p.clientSubmittedAt),
          buildVersion: p.build.version,
          buildFamily: p.build.family,
          buildSha: p.build.sha,
          buildBranch: p.build.branch,
          buildDate: p.build.date,
          platform: p.platform,
          gpu: p.gpu,
          perf: p.perf,
          net: p.net,
          netMode: p.net.mode,
          serverId: p.net.serverId || null,
          serverName: p.net.serverName || null,
          session: p.session,
          logTail: p.logTail,
          replayKey: replayStored?.key ?? null,
          replaySha256: replayStored?.sha256 ?? null,
          replayBytes: replayStored?.bytes ?? null,
          replayContentType: replayStored ? REPLAY_CONTENT_TYPE : null,
          createdAt,
          screenshots: {
            create: shotStored.map((s) => ({
              index: s.index, storageKey: s.key, sha256: s.sha256, bytes: s.bytes, contentType: SCREENSHOT_CONTENT_TYPE,
            })),
          },
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: grant.userId,
          action: BUG_REPORT_AUDIT.created,
          targetId: id,
          meta: { hasReplay: !!replayStored, screenshotCount: shotStored.length, replayBytes: replayStored?.bytes ?? 0, netMode: p.net.mode, category: p.category },
        },
      });
    });
    return reportJson({ id, createdAt: createdAt.toISOString() }, 201);
  } catch (err) {
    console.error("bug-report upload failed", err instanceof Error ? err.name : "error");
    await Promise.all(stored.map((key) => removeBugReportBlob(key).catch(() => undefined)));
    return reportJson({ error: "server_error" }, 500);
  }
}
