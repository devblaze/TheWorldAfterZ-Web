import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";

export const BUG_REPORT_AUDIT = {
  grantCreated: "BUG_REPORT_GRANT_CREATED",
  created: "BUG_REPORT_CREATED",
  swept: "BUG_REPORT_SWEPT",
} as const;

export const REPORT_JSON_MAX = 64 * 1024;
export const REPLAY_MAX_BYTES = Math.floor(1.5 * 1024 * 1024);
export const SCREENSHOT_MAX_BYTES = 250 * 1024;
export const SCREENSHOTS_TOTAL_MAX = Math.floor(1.5 * 1024 * 1024);
export const SCREENSHOTS_MAX_COUNT = 8;
export const REQUEST_MAX_BYTES = 3 * 1024 * 1024;
export const LOG_TAIL_MAX = 200;
export const GRANT_TTL_SEC_DEFAULT = 120;
export const GRANT_TTL_SEC_MAX = 120;
export const RETENTION_DAYS = 90;
export const REPORTS_PER_HOUR = 5;
export const REPORTS_PER_DAY = 20;
export const GRANTS_PER_HOUR = 10;

export const CATEGORIES = ["gameplay", "graphics", "network", "ui", "audio", "crash", "other"] as const;
export const NET_MODES = ["official", "listen", "direct", "relay", "none"] as const;
export const LOG_LEVELS = ["warning", "error", "exception", "info", "log", "debug"] as const;

export const REPLAY_CONTENT_TYPE = "application/gzip";
export const SCREENSHOT_CONTENT_TYPE = "image/jpeg";

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

export function reportJson(body: unknown, status = 200, extra?: Record<string, string>) {
  return Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
}

export const sha256Bytes = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

const text = (max: number) => z.string().max(max);
const nonEmpty = (max: number) => z.string().trim().min(1).max(max);
const finite = z.number().finite();
const isoDate = z.iso.datetime({ offset: true }).or(z.iso.datetime());

const Build = z.object({
  version: nonEmpty(128),
  sha: text(64),
  family: nonEmpty(64),
  branch: text(128),
  date: text(128),
});

const Platform = z.object({
  os: nonEmpty(64),
  osVersion: text(64),
  arch: nonEmpty(32),
  unity: text(64),
  deviceModel: text(128).optional(),
});

const Gpu = z.object({
  name: text(128),
  api: text(32),
  vramMb: z.number().int().min(0).max(1_000_000),
});

const Perf = z.object({
  fpsAvg: finite,
  fpsMin: finite,
  frameMsAvg: finite,
  frameMsMax: finite,
  windowSeconds: finite.min(0).max(86_400),
});

const Net = z.object({
  mode: z.enum(NET_MODES),
  serverId: text(64).optional(),
  serverName: text(128).optional(),
  pingMsAvg: finite.optional(),
  pingMsMax: finite.optional(),
  windowSeconds: finite.min(0).max(86_400).optional(),
  role: text(32).optional(),
});

const Session = z.object({
  map: text(128),
  playerCount: z.number().int().min(0).max(10_000),
  inMenu: z.boolean(),
});

const LogLine = z.object({
  t: z.number().int().nonnegative(),
  lv: z.enum(LOG_LEVELS),
  m: text(2000),
});

export const BugReportBody = z.object({
  schemaVersion: z.literal(1),
  category: z.enum(CATEGORIES),
  description: z.string().trim().min(10).max(4000),
  includeReplay: z.boolean(),
  clientSubmittedAt: isoDate,
  build: Build,
  platform: Platform,
  gpu: Gpu,
  perf: Perf,
  net: Net,
  session: Session,
  logTail: z.array(LogLine).max(LOG_TAIL_MAX),
});

export type BugReportPayload = z.infer<typeof BugReportBody>;

export const GrantRequest = z.object({
  ttlSec: z.number().int().min(1).max(GRANT_TTL_SEC_MAX).optional(),
});

const FORBIDDEN_KEYS = new Set([
  "accountid", "account_id", "email", "accesstoken", "access_token", "refreshtoken", "refresh_token",
  "uploadtoken", "upload_token", "token", "ticket", "pipename", "pipe_name", "ipccode", "ipc_code",
  "serversecret", "server_secret", "authorization", "password", "secret", "launchertoken",
  "nativetoken", "jointicket", "join_ticket", "twaz_server_secret", "twaz_server_id", "twaz_site_origin",
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function isFreeTextPath(path: string[]) {
  if (path.length === 1 && path[0] === "description") return true;
  if (path.length === 3 && path[0] === "logTail" && path[2] === "m") return true;
  return false;
}

/** Walk the raw report JSON. Returns a field path if a forbidden key or secret-shaped value is present. */
export function findForbiddenReportContent(value: unknown, path: string[] = []): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findForbiddenReportContent(value[i], [...path, String(i)]);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) return [...path, k].join(".");
      const hit = findForbiddenReportContent(v, [...path, k]);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === "string" && !isFreeTextPath(path)) {
    const s = value.trim();
    if (EMAIL_RE.test(s)) return path.join(".") || "value";
    if (/^Bearer\s+\S+/i.test(s) || /^TwazServer\s+\S+/i.test(s) || JWT_RE.test(s)) return path.join(".") || "value";
  }
  return null;
}

export const REPORT_ID_RE = /^br_[A-Za-z0-9_]{8,61}$/;

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_";

export function newReportId() {
  const bytes = randomBytes(20);
  let id = "br_";
  for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
  return id;
}

export function newUploadToken() {
  return randomBytes(32).toString("base64url");
}

export function isJpeg(buf: Buffer) {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

export function isGzip(buf: Buffer) {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

export function contentTypeOf(part: Blob | File, fallback = "") {
  return (part.type || fallback).split(";")[0].trim().toLowerCase();
}

export type InvalidFields = Record<string, string>;

export function invalidReport(message: string, fields: InvalidFields = {}, status = 400) {
  return reportJson({ error: "invalid_report", message, fields }, status);
}

/** Oldest-first retry delay so a rolling cap can drain. At least 1 second. */
export function retryAfterFrom(oldest: Date, windowMs: number, now = Date.now()) {
  return Math.max(1, Math.ceil((oldest.getTime() + windowMs - now) / 1000));
}

/** Read a request body, stopping as soon as it exceeds `max` bytes so we can 413 early. */
export async function readBodyCapped(req: Request, max: number): Promise<{ ok: true; buf: Buffer } | { ok: false; tooLarge: true }> {
  const len = Number(req.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) return { ok: false, tooLarge: true };
  const reader = req.body?.getReader();
  if (!reader) return { ok: true, buf: Buffer.alloc(0) };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { ok: true, buf: Buffer.concat(chunks) };
}
