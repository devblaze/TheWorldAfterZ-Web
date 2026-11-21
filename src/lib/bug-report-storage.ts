import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { reportJson, sha256Bytes } from "./bug-reports";

const KEY_RE = /^[a-zA-Z0-9]{16,128}\.[a-z0-9]{1,16}$/;
const TMP_ROOT = path.resolve("/tmp");

export const STORAGE_CHECK_TTL_MS = 30_000;
export const STORAGE_CHECK_RETRY_AFTER_SEC = 30;

export type StoredBlob = { key: string; sha256: string; bytes: number };

export type StorageEnv = { NODE_ENV?: string; BUG_REPORT_STORAGE_DIR?: string };

export type StorageUnavailableReason = "unset" | "under_tmp" | "not_writable";
export type StorageCheck = { ok: true } | { ok: false; reason: StorageUnavailableReason };

let cached: { at: number; result: StorageCheck } | null = null;
let ttlMs = STORAGE_CHECK_TTL_MS;

/** Resolve a configured storage directory. Does not default to /tmp. */
export function resolveBugReportStorageDir(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function isUnderTmp(dir: string): boolean {
  const resolved = path.resolve(dir);
  return resolved === TMP_ROOT || resolved.startsWith(TMP_ROOT + path.sep);
}

/** Test-only: drop the cached probe result and optionally override the re-check TTL. */
export function resetBugReportStorageCheck(opts?: { ttlMs?: number }) {
  cached = null;
  ttlMs = opts?.ttlMs ?? STORAGE_CHECK_TTL_MS;
}

async function probeWritable(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.probe-${randomBytes(8).toString("hex")}`);
  if (!probe.startsWith(dir + path.sep) && probe !== dir) return false;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(/*turbopackIgnore: true*/ probe, "ok", { flag: "wx" });
    await rm(/*turbopackIgnore: true*/ probe, { force: true });
    return true;
  } catch {
    await rm(/*turbopackIgnore: true*/ probe, { force: true }).catch(() => undefined);
    return false;
  }
}

async function probeBugReportStorage(env: StorageEnv): Promise<StorageCheck> {
  const resolved = resolveBugReportStorageDir(env.BUG_REPORT_STORAGE_DIR);
  if (!resolved) return { ok: false, reason: "unset" };
  if (isUnderTmp(resolved)) return { ok: false, reason: "under_tmp" };
  if (!(await probeWritable(resolved))) return { ok: false, reason: "not_writable" };
  return { ok: true };
}

/**
 * Soft availability check. Never throws. Results are cached for a short TTL so a
 * later writable disk can recover without a process restart.
 */
export async function checkBugReportStorage(env: StorageEnv = process.env): Promise<StorageCheck> {
  const now = Date.now();
  if (cached && now - cached.at < ttlMs) return cached.result;
  const result = await probeBugReportStorage(env);
  cached = { at: now, result };
  return result;
}

export function bugReportStorageBannerText(reason: StorageUnavailableReason) {
  return `Bug report storage isn't configured (${reason}).`;
}

export function bugReportsUnavailableResponse() {
  return reportJson({ error: "bug_reports_unavailable" }, 503, {
    "Retry-After": String(STORAGE_CHECK_RETRY_AFTER_SEC),
  });
}

/**
 * One startup warning: the reason category if storage is unavailable, otherwise a
 * reminder that reports will not survive redeploys unless a persistent volume is mounted.
 * Never logs secrets or probe filenames.
 */
export async function warnBugReportStorageAtStartup(env: StorageEnv = process.env): Promise<StorageCheck> {
  const result = await checkBugReportStorage(env);
  if (!result.ok) {
    console.warn("bug-report storage unavailable", result.reason);
  } else {
    console.warn("bug-report storage will not survive redeploys unless a persistent volume is mounted at BUG_REPORT_STORAGE_DIR");
  }
  return result;
}

export function bugReportStorageDir(env: StorageEnv = process.env) {
  const resolved = resolveBugReportStorageDir(env.BUG_REPORT_STORAGE_DIR);
  if (!resolved) throw new Error("BUG_REPORT_STORAGE_DIR is not set");
  return resolved;
}

function assertKey(key: string) {
  if (!KEY_RE.test(key)) throw new Error("invalid storage key");
}

function resolveKey(key: string) {
  assertKey(key);
  const root = path.resolve(/*turbopackIgnore: true*/ bugReportStorageDir());
  const full = path.resolve(/*turbopackIgnore: true*/ root, key);
  if (full !== path.join(/*turbopackIgnore: true*/ root, key)) throw new Error("invalid storage key");
  return full;
}

function newKey(ext: string) {
  const safe = ext.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 16) || "bin";
  return `${randomBytes(24).toString("hex")}.${safe}`;
}

export async function putBugReportBlob(bytes: Buffer, ext: string): Promise<StoredBlob> {
  const dir = bugReportStorageDir();
  await mkdir(dir, { recursive: true });
  const key = newKey(ext);
  const dest = resolveKey(key);
  await writeFile(dest, bytes, { flag: "wx" });
  return { key, sha256: sha256Bytes(bytes), bytes: bytes.length };
}

export async function getBugReportBlob(key: string): Promise<Buffer | null> {
  try {
    return await readFile(/*turbopackIgnore: true*/ resolveKey(key));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function removeBugReportBlob(key: string): Promise<void> {
  try {
    await rm(resolveKey(key), { force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
