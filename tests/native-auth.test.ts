import { createHash, createHmac, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

process.env.AUTH_URL ??= "http://localhost:3000";
const ORIGINAL_SECRET = process.env.LAUNCHER_TOKEN_SECRET;
if (!ORIGINAL_SECRET || Buffer.byteLength(ORIGINAL_SECRET) < 32) {
  process.env.LAUNCHER_TOKEN_SECRET = randomBytes(32).toString("base64url");
}

const { launcherTokenSecret } = await import("@/lib/env");
const { register } = await import("@/instrumentation");
const { proxy } = await import("@/proxy");
const {
  authorizePath,
  echoState,
  evaluateAuthorize,
  pkceMatches,
  pkceS256,
  safeLauncherNext,
  validLauncherRedirect,
} = await import("@/lib/launcher/validate");
const { signAccessToken, verifyAccessToken, verifyAccessTokenForRevoke } = await import("@/lib/launcher/jwt");

const base = {
  clientId: "twaz-launcher",
  redirectUri: "http://127.0.0.1:43123/callback",
  responseType: "code",
  state: "abcdefghijklmnop",
  codeChallenge: "A".repeat(43),
  codeChallengeMethod: "S256",
};

afterEach(() => {
  process.env.AUTH_URL = "http://localhost:3000";
  process.env.LAUNCHER_TOKEN_SECRET = ORIGINAL_SECRET && Buffer.byteLength(ORIGINAL_SECRET) >= 32
    ? ORIGINAL_SECRET
    : randomBytes(32).toString("base64url");
  delete process.env.NEXT_PHASE;
});

describe("LAUNCHER_TOKEN_SECRET", () => {
  it("rejects a missing or short secret and accepts 32 bytes", () => {
    delete process.env.LAUNCHER_TOKEN_SECRET;
    expect(() => launcherTokenSecret()).toThrow(/LAUNCHER_TOKEN_SECRET/);
    process.env.LAUNCHER_TOKEN_SECRET = "a".repeat(31);
    expect(() => launcherTokenSecret()).toThrow(/32 bytes/);
    process.env.LAUNCHER_TOKEN_SECRET = "a".repeat(32);
    expect(launcherTokenSecret()).toBe("a".repeat(32));
    process.env.LAUNCHER_TOKEN_SECRET = "é".repeat(15);
    expect(Buffer.byteLength(process.env.LAUNCHER_TOKEN_SECRET)).toBe(30);
    expect(() => launcherTokenSecret()).toThrow(/32 bytes/);
  });

  it("fails startup outside the production build phase", async () => {
    delete process.env.LAUNCHER_TOKEN_SECRET;
    await expect(register()).rejects.toThrow(/LAUNCHER_TOKEN_SECRET/);
    process.env.LAUNCHER_TOKEN_SECRET = "a".repeat(32);
    await expect(register()).resolves.toBeUndefined();
    delete process.env.LAUNCHER_TOKEN_SECRET;
    process.env.NEXT_PHASE = "phase-production-build";
    await expect(register()).resolves.toBeUndefined();
  });
});

describe("launcher redirect", () => {
  it("allows only the canonical loopback callback", () => {
    expect(validLauncherRedirect("http://127.0.0.1:43123/callback")).toBe(true);
    expect(validLauncherRedirect("http://127.0.0.1:1024/callback")).toBe(true);
    expect(validLauncherRedirect("http://127.0.0.1:65535/callback")).toBe(true);
    for (const bad of [
      "https://evil.example/callback",
      "http://localhost:43123/callback",
      "http://127.0.0.1:80/callback",
      "http://127.0.0.1:1023/callback",
      "http://127.0.0.1:65536/callback",
      "http://127.0.0.1:043123/callback",
      "http://127.0.0.1:43123/callback/",
      "http://127.0.0.1:43123/callback?x=1",
      "http://127.0.0.1:43123/callback#frag",
      "http://127.0.0.1:43123/Callback",
      "http://user@127.0.0.1:43123/callback",
      "https://127.0.0.1:43123/callback",
    ]) {
      expect(validLauncherRedirect(bad), bad).toBe(false);
    }
  });

  it("rejects a bad client or redirect before other parameters", () => {
    expect(evaluateAuthorize({ ...base, clientId: "other" }).ok).toBe(false);
    expect(evaluateAuthorize({ ...base, clientId: "other" })).toEqual({ ok: false, kind: "client" });
    expect(evaluateAuthorize({ ...base, redirectUri: "https://evil.example/callback" })).toEqual({ ok: false, kind: "client" });
    expect(evaluateAuthorize({ ...base, redirectUri: null })).toEqual({ ok: false, kind: "client" });
    const plain = evaluateAuthorize({ ...base, codeChallengeMethod: "plain" });
    expect(plain).toMatchObject({ ok: false, kind: "request", redirectUri: base.redirectUri });
    expect(evaluateAuthorize({ ...base, state: "short" })).toMatchObject({ ok: false, kind: "request" });
    expect(evaluateAuthorize({ ...base, codeChallenge: "abc", state: "short" })).toMatchObject({ ok: false, kind: "request" });
    expect(evaluateAuthorize({ ...base, responseType: "token" })).toMatchObject({ ok: false, kind: "request" });
    expect(evaluateAuthorize(base)).toMatchObject({ ok: true, redirectUri: base.redirectUri });
  });
});

describe("login next", () => {
  const valid = authorizePath({
    ok: true,
    clientId: "twaz-launcher",
    redirectUri: "http://127.0.0.1:43123/callback",
    state: "abcdefghijklmnop",
    codeChallenge: "A".repeat(43),
  });

  it("accepts the authorize path the server itself builds", () => {
    expect(valid.startsWith("/launcher/authorize?")).toBe(true);
    expect(valid.includes("//")).toBe(false);
    expect(safeLauncherNext(valid)).toBe(valid);
  });

  it("ignores open redirects, including encoded variants", () => {
    for (const bad of [
      "//evil",
      "https://evil",
      "http://evil/launcher/authorize?x=1",
      "/\\evil",
      "/launcher/authorizeX",
      "/launcher/authorize",
      "/%2F%2Fevil",
      "/launcher%2fauthorize?x=1",
      "/launcher/authorize%3Fclient_id=twaz-launcher",
      "/launcher/authorize?x=1\\evil",
      "/launcher/authorize?x=1\r\nLocation:https://evil",
      "https://theworldafterz.ncatechsolutions.org/launcher/authorize?x=1",
      "//theworldafterz.ncatechsolutions.org/launcher/authorize?x=1",
      "/launcher/authorize?x=1#frag",
      " /launcher/authorize?x=1",
      `/launcher/authorize?${"a".repeat(2100)}`,
      "/Launcher/authorize?x=1",
      "///launcher/authorize?x=1",
      "/launcher/authorize?x=1%00evil",
      "%2F%2Fevil.com",
      "https:%2F%2Fevil.com",
    ]) {
      expect(safeLauncherNext(bad), bad).toBeNull();
    }
  });

  it("does not echo a state that could break a Location header", () => {
    expect(echoState("ok")).toBe("ok");
    expect(echoState("a".repeat(512))).toHaveLength(512);
    expect(echoState("a".repeat(513))).toBeNull();
    expect(echoState("bad\r\n")).toBeNull();
    expect(echoState(null)).toBeNull();
  });
});

describe("PKCE S256", () => {
  it("matches a verifier and rejects a different one", () => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = pkceS256(verifier);
    expect(challenge).toHaveLength(43);
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(pkceMatches(`${verifier}x`, challenge)).toBe(false);
    expect(pkceMatches(verifier, `${challenge}x`)).toBe(false);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
  });
});

describe("access token", () => {
  const now = 1_700_000_000;
  const claims = { sub: "user_1", sid: "sess_1", pwdAt: 0 };

  function craft(payload: Record<string, unknown>, secret = process.env.LAUNCHER_TOKEN_SECRET!) {
    const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
    return `${h}.${p}.${sig}`;
  }

  it("round-trips HS256 claims for 900 seconds", () => {
    const token = signAccessToken(claims, now);
    const read = verifyAccessToken(token, now + 10);
    expect(read).toMatchObject({ ...claims, aud: "twaz-launcher", iss: "http://localhost:3000", iat: now, exp: now + 900 });
    expect(read?.jti.length).toBeGreaterThan(10);
    expect(verifyAccessToken(token, now + 900)).toBeNull();
  });

  it("rejects none, a different secret, the wrong audience, and the wrong issuer", () => {
    const token = signAccessToken(claims, now);
    process.env.LAUNCHER_TOKEN_SECRET = randomBytes(32).toString("base64url");
    expect(verifyAccessToken(token, now)).toBeNull();
    process.env.LAUNCHER_TOKEN_SECRET = "a".repeat(32);
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = token.split(".")[1];
    expect(verifyAccessToken(`${header}.${body}.`, now)).toBeNull();
    const payload = { ...claims, iat: now, exp: now + 900, aud: "twaz-launcher", iss: "http://localhost:3000", jti: "j" };
    expect(verifyAccessToken(craft({ ...payload, aud: "other" }), now)).toBeNull();
    expect(verifyAccessToken(craft({ ...payload, iss: "https://evil.example" }), now)).toBeNull();
    expect(verifyAccessToken(craft({ ...payload, alg: "none" }), now)).not.toBeNull();
  });

  it("accepts an expired token for revoke until it is 90 days old", () => {
    const expired = signAccessToken(claims, now - 1000);
    expect(verifyAccessToken(expired, now)).toBeNull();
    expect(verifyAccessTokenForRevoke(expired, now)?.sid).toBe("sess_1");
    const ancient = signAccessToken(claims, now - 91 * 24 * 60 * 60);
    expect(verifyAccessTokenForRevoke(ancient, now)).toBeNull();
    const within = signAccessToken(claims, now - 89 * 24 * 60 * 60);
    expect(verifyAccessTokenForRevoke(within, now)?.sub).toBe("user_1");
  });
});

describe("proxy origin check", () => {
  function post(path: string, origin?: string, extra?: Record<string, string>) {
    const headers = new Headers(extra);
    if (origin) headers.set("origin", origin);
    return proxy(new NextRequest(`http://localhost:3000${path}`, { method: "POST", headers }));
  }

  it("exempts the three launcher APIs and still checks consent and other APIs", () => {
    expect(post("/api/launcher/token", "https://evil.example").status).not.toBe(403);
    expect(post("/api/launcher/revoke", "https://evil.example").status).not.toBe(403);
    expect(post("/api/launcher/play-check").status).not.toBe(403);
    expect(post("/api/redeem", "https://evil.example").status).toBe(403);
    expect(post("/launcher/authorize", "https://evil.example").status).toBe(403);
    expect(post("/api/redeem", "http://localhost:3000").status).not.toBe(403);
    expect(post("/launcher/authorize", "null", { "sec-fetch-site": "same-origin" }).status).not.toBe(403);
  });

  it("marks launcher responses no-store", () => {
    const res = post("/api/launcher/token", "https://evil.example");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    const page = proxy(new NextRequest("http://localhost:3000/launcher/authorize"));
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("cache-control")).toBe("no-store");
  });

  it("allows loopback form-action only on /launcher/authorize", () => {
    const formAction = (csp: string | null) =>
      (csp ?? "")
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("form-action ")) ?? "";

    const authorize = proxy(new NextRequest("http://localhost:3000/launcher/authorize"));
    expect(formAction(authorize.headers.get("content-security-policy"))).toBe(
      "form-action 'self' http://127.0.0.1:*",
    );

    const login = proxy(new NextRequest("http://localhost:3000/login"));
    expect(formAction(login.headers.get("content-security-policy"))).toBe("form-action 'self'");
    expect(login.headers.get("content-security-policy")).not.toContain("127.0.0.1");
  });
});
