import { prisma } from "@/lib/db";
import { BUG_REPORT_AUDIT, RETENTION_DAYS } from "@/lib/bug-reports";
import { removeBugReportBlob } from "@/lib/bug-report-storage";

export async function sweepExpiredBugReports(now = new Date(), days = RETENTION_DAYS) {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const grantCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const stale = await prisma.bugReport.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true, replayKey: true, screenshots: { select: { storageKey: true } } },
  });
  let removedBlobs = 0;
  for (const r of stale) {
    const keys = [r.replayKey, ...r.screenshots.map((s) => s.storageKey)].filter((k): k is string => !!k);
    for (const key of keys) {
      await removeBugReportBlob(key);
      removedBlobs += 1;
    }
  }
  const ids = stale.map((r) => r.id);
  const deleted = ids.length
    ? await prisma.$transaction(async (tx) => {
        const result = await tx.bugReport.deleteMany({ where: { id: { in: ids } } });
        await tx.auditLog.create({
          data: { action: BUG_REPORT_AUDIT.swept, meta: { count: result.count, retentionDays: days } },
        });
        return result.count;
      })
    : 0;
  const grants = await prisma.bugReportGrant.deleteMany({
    where: { usedAt: null, expiresAt: { lt: grantCutoff } },
  });
  return { deleted, removedBlobs, expiredGrants: grants.count };
}

export type SweepResult = Awaited<ReturnType<typeof sweepExpiredBugReports>>;
