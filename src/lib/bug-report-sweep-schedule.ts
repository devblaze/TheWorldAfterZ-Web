export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type SweepResult = { deleted: number; removedBlobs: number; expiredGrants: number };
export type SweepFn = (now?: Date) => Promise<SweepResult>;
export type SweepRun = { ran: false } | { ran: true; result: SweepResult };

let running = false;
let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

/** One sweep at a time: a second call while the first is in flight returns { ran: false }. */
export async function runBugReportSweepGuarded(sweep: SweepFn, now = new Date()): Promise<SweepRun> {
  if (running) return { ran: false };
  running = true;
  try {
    const result = await sweep(now);
    console.info("bug-report sweep", `deleted=${result.deleted}`, `blobs=${result.removedBlobs}`, `grants=${result.expiredGrants}`);
    return { ran: true, result };
  } catch (err) {
    console.error("bug-report sweep failed", err instanceof Error ? err.name : "error");
    throw err;
  } finally {
    running = false;
  }
}

/**
 * Start the daily in-process sweep once per process. An immediate run covers the current
 * window, then it ticks every 24 hours. No-op under Vitest unless a sweep function is injected.
 * The interval is unref'd so it does not keep a process alive alone.
 */
export function startBugReportSweepScheduler(opts: { sweep: SweepFn; intervalMs?: number; startNow?: boolean }) {
  if (started) return;
  started = true;
  const intervalMs = opts.intervalMs ?? SWEEP_INTERVAL_MS;
  const tick = () => {
    void runBugReportSweepGuarded(opts.sweep).catch(() => undefined);
  };
  if (opts.startNow !== false) tick();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
}

/** Test-only: drop the once-per-process guard and any interval. */
export function resetBugReportSweepScheduler() {
  started = false;
  running = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
