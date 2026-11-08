import { launcherJson } from "@/lib/launcher/http";
import { PLAY_WINDOW_MS } from "@/lib/launcher/constants";
import { authenticateAccess } from "@/lib/launcher/store";
import { ipFrom, limitLauncherPlay } from "@/lib/rate-limit";
import { activeRedemption } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BODY_MAX = 8192;

function bearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer (\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function readBody(raw: unknown): { nonce: string; game_build: unknown; platform: unknown } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  if (typeof (raw as { nonce?: unknown }).nonce !== "string") return null;
  const body = raw as { nonce: string; game_build?: unknown; platform?: unknown };
  if (body.nonce.length < 16 || body.nonce.length > 128) return null;
  if (!Object.prototype.hasOwnProperty.call(raw, "game_build")) return null;
  if (!Object.prototype.hasOwnProperty.call(raw, "platform")) return null;
  return { nonce: body.nonce, game_build: body.game_build, platform: body.platform };
}

export async function POST(req: Request) {
  try {
    const token = bearer(req.headers.get("authorization"));
    if (!token || token.length > 4096) return launcherJson({ error: "invalid_token" }, 401);
    const auth = await authenticateAccess(token);
    if (!auth.ok) return launcherJson({ error: auth.error }, 401);

    const gate = await limitLauncherPlay(ipFrom(req.headers), auth.userId);
    if (!gate.ok) return launcherJson({ error: "rate_limited" }, 429, { "Retry-After": String(gate.retryAfter) });

    const ct = (req.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.includes("application/json")) return launcherJson({ error: "invalid_request" }, 400);
    const raw = await req.text();
    if (raw.length > BODY_MAX) return launcherJson({ error: "invalid_request" }, 400);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return launcherJson({ error: "invalid_request" }, 400);
    }
    const body = readBody(parsed);
    if (!body) return launcherJson({ error: "invalid_request" }, 400);

    const verified = auth.emailVerifiedAt !== null;
    const entitled = verified && (await activeRedemption(auth.userId)) !== null;
    // Unverified wins over a missing key: a key does not entitle an address that has not been confirmed.
    const reason = !verified ? "unverified" : entitled ? "ok" : "no_key";
    const checked = new Date();
    const expires = new Date(checked.getTime() + PLAY_WINDOW_MS);
    return launcherJson({
      entitled,
      reason,
      accountId: auth.userId,
      nonce: body.nonce,
      game_build: body.game_build,
      platform: body.platform,
      checkedAt: checked.toISOString(),
      expiresAt: expires.toISOString(),
    });
  } catch (err) {
    console.error("launcher play-check failed", err instanceof Error ? err.name : "error");
    return launcherJson({ error: "server_error" }, 500);
  }
}
