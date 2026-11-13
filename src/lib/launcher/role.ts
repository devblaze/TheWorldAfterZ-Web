import { isAdminEmail } from "@/lib/admin";
import { launcherJson } from "./http";
import { authenticateAccess, bearerToken, type AccessOk } from "./store";
import { limitLauncherAdmin } from "@/lib/rate-limit";

/** Role the game client sees. "owner" is reserved in the contract and not emitted today. */
export type LauncherRole = "admin" | "player";

/**
 * Fails closed: "admin" only for a live session (already checked by authenticateAccess) whose account is verified,
 * holds the existing ADMIN role in the database, AND is still listed in ADMIN_EMAILS. Unset or empty ADMIN_EMAILS,
 * an unknown role value or anything else is "player". Recomputed from the database on every request, never from the token.
 */
export function launcherRole(
  auth: Pick<AccessOk, "email" | "emailVerifiedAt" | "role">,
  adminEnv: string | undefined = process.env.ADMIN_EMAILS,
): LauncherRole {
  if (!auth.emailVerifiedAt) return "player";
  if (auth.role !== "ADMIN") return "player";
  return isAdminEmail(auth.email, adminEnv) ? "admin" : "player";
}

/**
 * Bearer -> live session -> per-account admin rate limit -> role. Returns the session or the error response.
 * Bearer-only: these routes never read cookies, which is why the proxy exempts them from the browser origin check.
 */
export async function requireLauncherAdmin(req: Request): Promise<{ ok: true; auth: AccessOk } | { ok: false; res: Response }> {
  const token = bearerToken(req.headers.get("authorization"));
  if (!token) return { ok: false, res: launcherJson({ error: "invalid_token" }, 401) };
  const auth = await authenticateAccess(token);
  if (!auth.ok) return { ok: false, res: launcherJson({ error: auth.error }, 401) };
  const gate = await limitLauncherAdmin(auth.userId);
  if (!gate.ok) return { ok: false, res: launcherJson({ error: "rate_limited" }, 429, { "Retry-After": String(gate.retryAfter) }) };
  if (launcherRole(auth) !== "admin") return { ok: false, res: launcherJson({ error: "forbidden" }, 403) };
  return { ok: true, auth };
}
