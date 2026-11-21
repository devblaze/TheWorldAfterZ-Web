// Runs once when the Node server is ready to accept requests. `next build` (and the Docker
// image build) does not have runtime secrets, so the check is skipped only for that phase.
export async function register() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { launcherTokenSecret } = await import("./lib/env");
  launcherTokenSecret();
  const { warnBugReportStorageAtStartup } = await import("./lib/bug-report-storage");
  await warnBugReportStorageAtStartup();
  const { logTrackerConfigAtStartup } = await import("./lib/bug-report-tracker");
  logTrackerConfigAtStartup();
  if (process.env.VITEST) return;
  const { sweepExpiredBugReports } = await import("./lib/bug-report-sweep");
  const { startBugReportSweepScheduler } = await import("./lib/bug-report-sweep-schedule");
  startBugReportSweepScheduler({ sweep: sweepExpiredBugReports });
  const { processBugReportTrackerOutbox } = await import("./lib/bug-report-tracker-sync");
  const { startBugReportTrackerScheduler } = await import("./lib/bug-report-tracker-schedule");
  startBugReportTrackerScheduler({ tick: processBugReportTrackerOutbox });
}
