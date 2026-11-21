// Runs once when the Node server is ready to accept requests. `next build` (and the Docker
// image build) does not have runtime secrets, so the check is skipped only for that phase.
export async function register() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { launcherTokenSecret } = await import("./lib/env");
  launcherTokenSecret();
  const { assertBugReportStorage } = await import("./lib/bug-report-storage");
  assertBugReportStorage();
  if (process.env.VITEST) return;
  const { sweepExpiredBugReports } = await import("./lib/bug-report-sweep");
  const { startBugReportSweepScheduler } = await import("./lib/bug-report-sweep-schedule");
  startBugReportSweepScheduler({ sweep: sweepExpiredBugReports });
}
