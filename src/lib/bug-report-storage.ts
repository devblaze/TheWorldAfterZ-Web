import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256Bytes } from "./bug-reports";

const KEY_RE = /^[a-zA-Z0-9]{16,128}\.[a-z0-9]{1,16}$/;

export type StoredBlob = { key: string; sha256: string; bytes: number };

export function bugReportStorageDir() {
  const raw = process.env.BUG_REPORT_STORAGE_DIR?.trim();
  return raw && raw.length > 0 ? raw : "/tmp/twaz-bug-reports";
}

function assertKey(key: string) {
  if (!KEY_RE.test(key)) throw new Error("invalid storage key");
}

function resolveKey(key: string) {
  assertKey(key);
  const root = path.resolve(bugReportStorageDir());
  const full = path.resolve(root, key);
  if (full !== path.join(root, key)) throw new Error("invalid storage key");
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
    return await readFile(resolveKey(key));
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
