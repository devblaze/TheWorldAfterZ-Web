import { launcherJson } from "@/lib/launcher/http";
import { CLIENT_ID } from "@/lib/launcher/constants";
import { exchangeAuthorizationCode, pruneNativeAuth, refreshSessionId, rotateRefreshToken, type TokenResult } from "@/lib/launcher/store";
import {
  ipFrom,
  limitLauncherRefreshIp,
  limitLauncherRefreshSid,
  limitLauncherToken,
  limitLauncherTokenIp,
  type Gate,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BODY_MAX = 8192;

function rateLimited(retryAfter: number) {
  return launcherJson({ error: "rate_limited" }, 429, { "Retry-After": String(retryAfter) });
}

function tokenResponse(result: TokenResult) {
  if (!result.ok) return launcherJson({ error: result.error }, 400);
  return launcherJson({
    access_token: result.accessToken,
    token_type: "Bearer",
    expires_in: result.expiresIn,
    refresh_token: result.refreshToken,
    account: { id: result.account.id, email: result.account.email },
  });
}

async function readForm(req: Request): Promise<URLSearchParams | null> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/x-www-form-urlencoded")) return null;
  const raw = await req.text();
  if (raw.length > BODY_MAX) return null;
  return new URLSearchParams(raw);
}

async function blocked(gate: Gate) {
  return gate.ok ? null : rateLimited(gate.retryAfter);
}

export async function POST(req: Request) {
  try {
    try {
      await pruneNativeAuth();
    } catch {
      console.error("launcher auth prune failed");
    }
    const ip = ipFrom(req.headers);
    const form = await readForm(req);
    if (!form) {
      const deny = await blocked(await limitLauncherTokenIp(ip));
      if (deny) return deny;
      return launcherJson({ error: "invalid_request" }, 400);
    }
    const grant = form.get("grant_type");
    if (grant !== "authorization_code" && grant !== "refresh_token") {
      const deny = await blocked(await limitLauncherTokenIp(ip));
      if (deny) return deny;
      return launcherJson({ error: grant ? "unsupported_grant_type" : "invalid_request" }, 400);
    }
    const clientId = form.get("client_id") ?? "";
    if (!clientId || clientId.length > 128) {
      const gate = grant === "refresh_token" ? await limitLauncherRefreshIp(ip) : await limitLauncherTokenIp(ip);
      const deny = await blocked(gate);
      if (deny) return deny;
      return launcherJson({ error: "invalid_request" }, 400);
    }
    if (clientId !== CLIENT_ID) {
      const gate = grant === "refresh_token" ? await limitLauncherRefreshIp(ip) : await limitLauncherTokenIp(ip);
      const deny = await blocked(gate);
      if (deny) return deny;
      return launcherJson({ error: "invalid_client" }, 400);
    }

    if (grant === "authorization_code") {
      const deny = await blocked(await limitLauncherToken(ip, clientId));
      if (deny) return deny;
      const code = form.get("code") ?? "";
      const redirectUri = form.get("redirect_uri") ?? "";
      const codeVerifier = form.get("code_verifier") ?? "";
      if (!code || !redirectUri || !codeVerifier || code.length > 256 || redirectUri.length > 512 || codeVerifier.length > 256) {
        return launcherJson({ error: "invalid_request" }, 400);
      }
      return tokenResponse(await exchangeAuthorizationCode({ code, redirectUri, clientId, codeVerifier }));
    }

    const refreshToken = form.get("refresh_token") ?? "";
    if (!refreshToken || refreshToken.length > 512) {
      const deny = await blocked(await limitLauncherRefreshIp(ip));
      if (deny) return deny;
      return launcherJson({ error: "invalid_request" }, 400);
    }
    const sid = await refreshSessionId(refreshToken);
    const [ipGate, sidGate] = await Promise.all([
      limitLauncherRefreshIp(ip),
      sid ? limitLauncherRefreshSid(sid) : Promise.resolve({ ok: true as const }),
    ]);
    if (!ipGate.ok) return rateLimited(ipGate.retryAfter);
    if (!sidGate.ok) return rateLimited(sidGate.retryAfter);
    return tokenResponse(await rotateRefreshToken({ refreshToken, clientId }));
  } catch (err) {
    console.error("launcher token failed", err instanceof Error ? err.name : "error");
    return launcherJson({ error: "server_error" }, 500);
  }
}
