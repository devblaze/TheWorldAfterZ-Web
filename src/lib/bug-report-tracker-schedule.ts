import { SYNC_TICK_INTERVAL_MS } from "@/lib/bug-report-tracker";
import type { TrackerSyncRun } from "@/lib/bug-report-tracker-sync";

export type TrackerTickFn = (now?: Date) => Promise<TrackerSyncRun>;

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the in-process outbox worker once per process. An immediate tick covers
 * pending rows after a restart, then it runs every 15 seconds. The interval is
 * unref'd so it does not keep a process alive alone.
 */
export function startBugReportTrackerScheduler(opts: { tick: TrackerTickFn; intervalMs?: number; startNow?: boolean }) {
  if (started) return;
  started = true;
  const intervalMs = opts.intervalMs ?? SYNC_TICK_INTERVAL_MS;
  const run = () => {
    void opts.tick().catch(() => undefined);
  };
  if (opts.startNow !== false) run();
  timer = setInterval(run, intervalMs);
  timer.unref?.();
}

/** Test-only: drop the once-per-process guard and any interval. */
export function resetBugReportTrackerScheduler() {
  started = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
