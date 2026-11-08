const MIN_SECRET_BYTES = 32;

/**
 * HS256 secret for launcher access tokens.
 * Called when the Node server starts (instrumentation) and on every sign/verify.
 * Throws if the variable is missing or shorter than 32 bytes. The value is not logged.
 */
export function launcherTokenSecret(): string {
  const secret = process.env.LAUNCHER_TOKEN_SECRET;
  if (typeof secret !== "string" || Buffer.byteLength(secret) < MIN_SECRET_BYTES) {
    throw new Error("LAUNCHER_TOKEN_SECRET must be set and at least 32 bytes");
  }
  return secret;
}
