// Runs once when the Node server is ready to accept requests. `next build` (and the Docker
// image build) does not have runtime secrets, so the check is skipped only for that phase.
export async function register() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { launcherTokenSecret } = await import("./lib/env");
  launcherTokenSecret();
}
