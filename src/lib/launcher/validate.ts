import { createHash, timingSafeEqual } from "node:crypto";
import { CLIENT_ID, NEXT_MAX_LEN } from "./constants";

const REDIRECT_RE = /^http:\/\/127\.0\.0\.1:(\d+)\/callback$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** Loopback callback only: exact host, path, and scheme; port 1024-65535; no query or fragment. */
export function validLauncherRedirect(uri: string): boolean {
  const m = REDIRECT_RE.exec(uri);
  if (!m) return false;
  const port = Number(m[1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return false;
  // Reject leading zeros so the stored redirect is the canonical string we compare at exchange.
  return String(port) === m[1];
}

export function validState(state: string): boolean {
  return state.length >= 16 && state.length <= 512 && !/[\u0000-\u001F\u007F]/.test(state);
}

export function validChallenge(challenge: string): boolean {
  return CHALLENGE_RE.test(challenge);
}

export function validVerifier(verifier: string): boolean {
  return VERIFIER_RE.test(verifier);
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function pkceMatches(verifier: string, challenge: string): boolean {
  const actual = Buffer.from(pkceS256(verifier));
  const expected = Buffer.from(challenge);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export type AuthorizeInput = {
  clientId: string | null;
  redirectUri: string | null;
  responseType: string | null;
  state: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
};

export type AuthorizeOk = {
  ok: true;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
};

export type AuthorizeCheck =
  | AuthorizeOk
  | { ok: false; kind: "client" }
  | { ok: false; kind: "request"; redirectUri: string; state: string | null };

/** Client id and redirect are decided before any other parameter, and a bad redirect is never returned. */
export function evaluateAuthorize(input: AuthorizeInput): AuthorizeCheck {
  if (input.clientId !== CLIENT_ID || !input.redirectUri || !validLauncherRedirect(input.redirectUri)) {
    return { ok: false, kind: "client" };
  }
  const stateOk = input.state !== null && validState(input.state);
  const challengeOk = input.codeChallenge !== null && validChallenge(input.codeChallenge);
  const methodOk = input.codeChallengeMethod === "S256";
  const typeOk = input.responseType === "code";
  if (!stateOk || !challengeOk || !methodOk || !typeOk) {
    return { ok: false, kind: "request", redirectUri: input.redirectUri, state: input.state };
  }
  return {
    ok: true,
    clientId: CLIENT_ID,
    redirectUri: input.redirectUri,
    state: input.state as string,
    codeChallenge: input.codeChallenge as string,
  };
}

/** Relative authorize path, with the loopback redirect percent-encoded so `next` stays same-origin. */
export function authorizePath(checked: AuthorizeOk): string {
  const q = new URLSearchParams({
    client_id: checked.clientId,
    redirect_uri: checked.redirectUri,
    response_type: "code",
    state: checked.state,
    code_challenge: checked.codeChallenge,
    code_challenge_method: "S256",
  });
  return `/launcher/authorize?${q.toString()}`;
}

/**
 * Login return-to. Only a relative `/launcher/authorize?` path. Scheme, host, `//`, backslash,
 * controls, and anything that normalizes to a different path are ignored.
 */
export function safeLauncherNext(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > NEXT_MAX_LEN) return null;
  if (!raw.startsWith("/launcher/authorize?")) return null;
  if (raw.includes("\\") || raw.includes("//")) return null;
  if (/[\u0000-\u001F\u007F]/.test(raw)) return null;
  // Percent-encoded controls (for example %00) are rejected before a second decode can revive them.
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(raw)) return null;
  const path = raw.slice(0, raw.indexOf("?"));
  if (path !== "/launcher/authorize") return null;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decodedPath !== "/launcher/authorize") return null;
  let url: URL;
  try {
    url = new URL(raw, "http://127.0.0.1");
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/launcher/authorize") return null;
  if (url.hash) return null;
  return raw;
}

/** State is echoed on an error redirect only when it cannot break the Location header. */
export function echoState(state: string | null): string | null {
  if (state === null) return null;
  if (state.length < 1 || state.length > 512) return null;
  if (/[\u0000-\u001F\u007F]/.test(state)) return null;
  return state;
}
