import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256Bytes } from "./bug-reports";

const KEY_RE = /^[a-zA-Z0-9]{16,128}\.[a-z0-9]{1,16}$/;
const TMP_ROOT = path.resolve("/tmp");

export type StoredBlob = { key: string; sha256: string; bytes: number };

export type StorageEnv = { NODE_ENV?: string; BUG_REPORT_STORAGE_DIR?: string };

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

/**
 * Production must set BUG_REPORT_STORAGE_DIR to a durable path that does not resolve under /tmp.
 * Skipped when NODE_ENV is not "production" so local/CI can use a throwaway directory.
 */
export function assertBugReportStorage(env: StorageEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;
  const resolved = resolveBugReportStorageDir(env.BUG_REPORT_STORAGE_DIR);
  if (!resolved || isUnderTmp(resolved)) {
    throw new Error("BUG_REPORT_STORAGE_DIR must be set in production and must not resolve under /tmp");
  }
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
