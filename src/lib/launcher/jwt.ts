import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { launcherTokenSecret } from "@/lib/env";
import { ACCESS_TTL_S, CLIENT_ID, REVOKE_MAX_IAT_AGE_S } from "./constants";

const IAT_FUTURE_SKEW_S = 60;

export type AccessClaims = {
  sub: string;
  sid: string;
  pwdAt: number;
  iat: number;
  exp: number;
  aud: string;
  iss: string;
  jti: string;
};

export function siteOrigin(): string {
  const raw = process.env.AUTH_URL;
  if (!raw) throw new Error("AUTH_URL is required");
  return new URL(raw).origin;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function b64urlDecode(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const buf = Buffer.from(s, "base64url");
  return buf.length > 0 ? buf : null;
}

export function signAccessToken(claims: { sub: string; sid: string; pwdAt: number }, nowSec = Math.floor(Date.now() / 1000)): string {
  const secret = launcherTokenSecret();
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = {
    sub: claims.sub,
    sid: claims.sid,
    pwdAt: claims.pwdAt,
    iat: nowSec,
    exp: nowSec + ACCESS_TTL_S,
    aud: CLIENT_ID,
    iss: siteOrigin(),
    jti: randomBytes(16).toString("base64url"),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const sig = b64url(createHmac("sha256", secret).update(data).digest());
  return `${data}.${sig}`;
}

function readPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  if (!h || !p || !s) return null;
  const headerJson = b64urlDecode(h);
  const sig = b64urlDecode(s);
  if (!headerJson || !sig) return null;
  let header: unknown;
  try {
    header = JSON.parse(headerJson.toString("utf8"));
  } catch {
    return null;
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) return null;
  // Always HMAC-SHA256. The header is not allowed to choose an algorithm.
  if ((header as { alg?: unknown }).alg !== "HS256") return null;
  const expected = createHmac("sha256", launcherTokenSecret()).update(`${h}.${p}`).digest();
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  const payloadJson = b64urlDecode(p);
  if (!payloadJson) return null;
  try {
    const payload = JSON.parse(payloadJson.toString("utf8")) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asClaims(payload: Record<string, unknown>, nowSec: number, ignoreExpiry: boolean): AccessClaims | null {
  const { sub, sid, pwdAt, iat, exp, aud, iss, jti } = payload;
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 128) return null;
  if (typeof sid !== "string" || sid.length === 0 || sid.length > 128) return null;
  if (typeof pwdAt !== "number" || !Number.isFinite(pwdAt)) return null;
  if (typeof iat !== "number" || !Number.isFinite(iat)) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  if (aud !== CLIENT_ID) return null;
  if (iss !== siteOrigin()) return null;
  if (typeof jti !== "string" || jti.length === 0 || jti.length > 128) return null;
  if (iat > nowSec + IAT_FUTURE_SKEW_S) return null;
  if (ignoreExpiry) {
    if (nowSec - iat > REVOKE_MAX_IAT_AGE_S) return null;
  } else if (exp <= nowSec) {
    return null;
  }
  return { sub, sid, pwdAt, iat, exp, aud, iss, jti };
}

/** Verifies signature, audience, issuer, and expiry. Session state is checked separately. */
export function verifyAccessToken(token: string, nowSec = Math.floor(Date.now() / 1000)): AccessClaims | null {
  const payload = readPayload(token);
  if (!payload) return null;
  return asClaims(payload, nowSec, false);
}

/** Revocation may present an expired access token. Expiry is ignored; iat older than 90 days is not. */
export function verifyAccessTokenForRevoke(token: string, nowSec = Math.floor(Date.now() / 1000)): AccessClaims | null {
  const payload = readPayload(token);
  if (!payload) return null;
  return asClaims(payload, nowSec, true);
}
