// Usage: node scripts/bug-reports-sweep.mjs
// Deletes bug reports (and their blobs) older than RETENTION_DAYS (default 90).
// Also drops expired, unused grants older than 1 day. Never prints secrets or paths of remaining files.
import { rm } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const DAYS = Number(process.env.BUG_REPORT_RETENTION_DAYS ?? 90);
if (!Number.isFinite(DAYS) || DAYS < 1) {
  console.error("BUG_REPORT_RETENTION_DAYS must be a positive number");
  process.exit(1);
}
const dir = (process.env.BUG_REPORT_STORAGE_DIR ?? "/tmp/twaz-bug-reports").trim();
const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
const grantCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
const KEY_RE = /^[a-zA-Z0-9]{16,128}\.[a-z0-9]{1,16}$/;

const prisma = new PrismaClient();
try {
  const stale = await prisma.bugReport.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true, replayKey: true, screenshots: { select: { storageKey: true } } },
  });
  const keys = [];
  for (const r of stale) {
    if (r.replayKey) keys.push(r.replayKey);
    for (const s of r.screenshots) keys.push(s.storageKey);
  }
  let removedBlobs = 0;
  for (const key of keys) {
    if (!KEY_RE.test(key)) continue;
    try {
      await rm(path.join(dir, key), { force: true });
      removedBlobs += 1;
    } catch {
      // continue; the row is still removed below
    }
  }
  const ids = stale.map((r) => r.id);
  const deleted = ids.length
    ? await prisma.$transaction(async (tx) => {
        const result = await tx.bugReport.deleteMany({ where: { id: { in: ids } } });
        await tx.auditLog.create({
          data: { action: "BUG_REPORT_SWEPT", meta: { count: result.count, retentionDays: DAYS } },
        });
        return result.count;
      })
    : 0;
  const grants = await prisma.bugReportGrant.deleteMany({
    where: { usedAt: null, expiresAt: { lt: grantCutoff } },
  });
  console.log(`Swept ${deleted} report(s) older than ${DAYS} days, ${removedBlobs} blob(s), ${grants.count} expired grant(s).`);
} finally {
  await prisma.$disconnect();
}
