import { prisma } from "@/lib/db";
import {
  DEDUPE_WINDOW_MS, TRACKER_SYNC_STATUS, dedupeCommentBody, issueDescriptionFromReport,
  nextAttemptAt, shouldGiveUp, trackerConfig, type TrackerIssueInput,
} from "@/lib/bug-report-tracker";
import { commentOnTrackerIssue, createTrackerIssue, hasInjectedTrackerFetch } from "@/lib/bug-report-tracker-client";

export type TrackerSyncRun =
  | { ran: false }
  | { ran: true; processed: number; synced: number; failed: number; skipped?: string };

let running = false;

type LinkRow = {
  id: string;
  reportId: string;
  issueKey: string | null;
  issueUrl: string | null;
  dedupeKey: string;
  title: string;
  status: string;
  attemptCount: number;
  createdAt: Date;
};

function inputFromReport(row: {
  id: string;
  userId: string;
  createdAt: Date;
  category: string;
  description: string;
  buildVersion: string;
  buildSha: string;
  buildBranch: string;
  netMode: string;
  serverId: string | null;
  serverName: string | null;
  platform: unknown;
  gpu: unknown;
  session: unknown;
}, title: string): TrackerIssueInput {
  return {
    reportId: row.id,
    userId: row.userId,
    createdAt: row.createdAt,
    category: row.category,
    description: row.description,
    title,
    buildVersion: row.buildVersion,
    buildSha: row.buildSha,
    buildBranch: row.buildBranch,
    netMode: row.netMode,
    serverId: row.serverId,
    serverName: row.serverName,
    platform: row.platform,
    gpu: row.gpu,
    session: row.session,
  };
}

async function markAttempt(row: LinkRow, result: { retryable: boolean; error: string }, now: Date) {
  const attemptCount = row.attemptCount + 1;
  const giveUp = !result.retryable || shouldGiveUp({ attemptCount, createdAt: row.createdAt }, now);
  await prisma.bugReportTrackerLink.update({
    where: { id: row.id },
    data: {
      attemptCount,
      lastError: result.error.slice(0, 200),
      nextAttemptAt: giveUp ? now : nextAttemptAt(attemptCount, now),
      status: giveUp ? TRACKER_SYNC_STATUS.failed : row.status,
      failedAt: giveUp ? now : null,
    },
  });
  return giveUp;
}

async function findDedupeTarget(row: LinkRow, now: Date) {
  const since = new Date(now.getTime() - DEDUPE_WINDOW_MS);
  return prisma.bugReportTrackerLink.findFirst({
    where: {
      id: { not: row.id },
      dedupeKey: row.dedupeKey,
      issueKey: { not: null },
      createdAt: { gte: since },
      status: { in: [TRACKER_SYNC_STATUS.synced, TRACKER_SYNC_STATUS.pendingComment] },
    },
    orderBy: { createdAt: "asc" },
  });
}

async function syncOne(row: LinkRow, report: Parameters<typeof inputFromReport>[0], now: Date): Promise<"synced" | "failed" | "retry"> {
  const cfg = trackerConfig();
  if (!cfg.enabled) return "retry";

  // Already linked: finish a pending comment, or no-op if synced.
  if (row.status === TRACKER_SYNC_STATUS.synced && row.issueKey) return "synced";

  if (row.issueKey && row.status === TRACKER_SYNC_STATUS.pendingComment) {
    const comment = await commentOnTrackerIssue(cfg, {
      key: row.issueKey,
      body: dedupeCommentBody({ reportId: report.id, createdAt: report.createdAt }),
    });
    if (!comment.ok) {
      const gaveUp = await markAttempt(row, comment, now);
      return gaveUp ? "failed" : "retry";
    }
    await prisma.bugReportTrackerLink.update({
      where: { id: row.id },
      data: {
        status: TRACKER_SYNC_STATUS.synced,
        syncedAt: now,
        lastError: null,
        attemptCount: row.attemptCount + 1,
      },
    });
    return "synced";
  }

  if (row.issueKey) {
    // issueKey already stored (create succeeded, crash before status update): just mark synced.
    await prisma.bugReportTrackerLink.update({
      where: { id: row.id },
      data: { status: TRACKER_SYNC_STATUS.synced, syncedAt: now, lastError: null },
    });
    return "synced";
  }

  const existing = await findDedupeTarget(row, now);
  if (existing?.issueKey) {
    // Persist the key first so a retry cannot create a new issue.
    await prisma.bugReportTrackerLink.update({
      where: { id: row.id },
      data: {
        issueKey: existing.issueKey,
        issueUrl: existing.issueUrl,
        status: TRACKER_SYNC_STATUS.pendingComment,
      },
    });
    const comment = await commentOnTrackerIssue(cfg, {
      key: existing.issueKey,
      body: dedupeCommentBody({ reportId: report.id, createdAt: report.createdAt }),
    });
    if (!comment.ok) {
      const gaveUp = await markAttempt({ ...row, issueKey: existing.issueKey, status: TRACKER_SYNC_STATUS.pendingComment }, comment, now);
      return gaveUp ? "failed" : "retry";
    }
    await prisma.bugReportTrackerLink.update({
      where: { id: row.id },
      data: {
        issueKey: existing.issueKey,
        issueUrl: existing.issueUrl,
        status: TRACKER_SYNC_STATUS.synced,
        syncedAt: now,
        lastError: null,
        attemptCount: row.attemptCount + 1,
      },
    });
    return "synced";
  }

  const created = await createTrackerIssue(cfg, {
    summary: row.title,
    description: issueDescriptionFromReport(inputFromReport(report, row.title)),
  });
  if (!created.ok || !created.issue) {
    const gaveUp = await markAttempt(row, created.ok ? { retryable: true, error: "missing_issue_key" } : created, now);
    return gaveUp ? "failed" : "retry";
  }
  await prisma.bugReportTrackerLink.update({
    where: { id: row.id },
    data: {
      issueKey: created.issue.key,
      issueUrl: created.issue.url ?? `${cfg.url}/browse/${created.issue.key}`,
      status: TRACKER_SYNC_STATUS.synced,
      syncedAt: now,
      lastError: null,
      attemptCount: row.attemptCount + 1,
    },
  });
  return "synced";
}

/**
 * Drain due outbox rows. Fail-soft: never throws to the caller after logging.
 * Under Vitest, refuses to use the real network unless a mock fetch was injected.
 */
export async function processBugReportTrackerOutbox(now = new Date(), opts: { limit?: number } = {}): Promise<TrackerSyncRun> {
  if (running) return { ran: false };
  const cfg = trackerConfig();
  if (!cfg.enabled) return { ran: true, processed: 0, synced: 0, failed: 0, skipped: "disabled" };
  if (process.env.VITEST && !hasInjectedTrackerFetch()) {
    return { ran: true, processed: 0, synced: 0, failed: 0, skipped: "vitest_no_mock" };
  }

  running = true;
  let processed = 0;
  let synced = 0;
  let failed = 0;
  try {
    const due = await prisma.bugReportTrackerLink.findMany({
      where: {
        status: { in: [TRACKER_SYNC_STATUS.pending, TRACKER_SYNC_STATUS.pendingComment] },
        nextAttemptAt: { lte: now },
      },
      include: { report: true },
      orderBy: { createdAt: "asc" },
      take: opts.limit ?? 10,
    });
    for (const row of due) {
      processed += 1;
      try {
        const result = await syncOne(row, row.report, now);
        if (result === "synced") synced += 1;
        else if (result === "failed") failed += 1;
      } catch (err) {
        console.error("bug-report tracker sync row failed", row.id, err instanceof Error ? err.name : "error");
        try {
          const giveUp = await markAttempt(row, { retryable: true, error: "exception" }, now);
          if (giveUp) failed += 1;
        } catch {
          // ignore secondary failure
        }
      }
    }
    if (processed > 0) {
      console.info("bug-report tracker sync", `processed=${processed}`, `synced=${synced}`, `failed=${failed}`);
    }
    return { ran: true, processed, synced, failed };
  } catch (err) {
    console.error("bug-report tracker sync failed", err instanceof Error ? err.name : "error");
    return { ran: true, processed, synced, failed, skipped: "error" };
  } finally {
    running = false;
  }
}

/** Test-only: drop the in-flight guard. */
export function resetBugReportTrackerSyncGuard() {
  running = false;
}

/** Fire-and-forget after a 201. No-ops when the feature is disabled or under Vitest (tests call the worker themselves). */
export function kickBugReportTrackerSync() {
  if (!trackerConfig().enabled) return;
  if (process.env.VITEST) return;
  void processBugReportTrackerOutbox().catch(() => undefined);
}
