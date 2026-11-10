// Launcher OAuth, refresh, revoke, and play-check against the Postgres at DATABASE_URL.
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

process.env.AUTH_URL ??= "http://localhost:3000";
process.env.AUTH_SECRET ??= randomBytes(32).toString("hex");
process.env.AUTH_TRUST_HOST ??= "true";
process.env.DOWNLOAD_SIGNING_SECRET ??= randomBytes(32).toString("hex");
if (!process.env.LAUNCHER_TOKEN_SECRET || Buffer.byteLength(process.env.LAUNCHER_TOKEN_SECRET) < 32) {
  process.env.LAUNCHER_TOKEN_SECRET = randomBytes(32).toString("base64url");
}

let ambient = new Headers();
vi.mock("next/headers", () => ({
  headers: async () => ambient,
  cookies: async () => ({
    get(name: string) {
      const value = cookieMap().get(name);
      return value === undefined ? undefined : { name, value };
    },
    getAll() {
      return [...cookieMap()].map(([name, value]) => ({ name, value }));
    },
    set(name: string, value: string) {
      const jar = cookieMap();
      jar.set(name, value);
      ambient.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    },
    delete(name: string) {
      const jar = cookieMap();
      jar.delete(name);
      ambient.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    },
    has(name: string) {
      return cookieMap().has(name);
    },
  }),
}));

function cookieMap() {
  const jar = new Map<string, string>();
  for (const part of (ambient.get("cookie") ?? "").split("; ").filter(Boolean)) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i), part.slice(i + 1));
  }
  return jar;
}

const { prisma } = await import("@/lib/db");
const { sha256, generateKey, keyPrefix } = await import("@/lib/crypto");
const { safeLauncherNext } = await import("@/lib/launcher/validate");
const { verifyAccessToken, signAccessToken } = await import("@/lib/launcher/jwt");
const { LAUNCHER_LIMITS, launcherAuthorizeAccountKey, launcherPlayAccountKey, launcherTokenIpKey, windowStart } = await import("@/lib/rate-limit");
const { loginAction } = await import("@/app/actions");
const LoginPage = (await import("@/app/login/page")).default;
const RegisterPage = (await import("@/app/register/page")).default;
const authRoute = await import("@/app/api/auth/[...nextauth]/route");
const registerRoute = await import("@/app/api/register/route");
const verifyRoute = await import("@/app/api/verify/route");
const redeemRoute = await import("@/app/api/redeem/route");
const forgotRoute = await import("@/app/api/forgot-password/route");
const resetRoute = await import("@/app/api/reset-password/route");
const authorize = await import("@/app/launcher/authorize/route");
const tokenRoute = await import("@/app/api/launcher/token/route");
const revokeRoute = await import("@/app/api/launcher/revoke/route");
const playRoute = await import("@/app/api/launcher/play-check/route");

const BASE = process.env.AUTH_URL!;
const run = randomBytes(4).toString("hex");
const batch = `native-auth-${run}`;
const password = "correct horse battery";
const redirectUri = "http://127.0.0.1:43123/callback";
const alice = { email: `alice-${run}@example.test`, password };
const bob = { email: `bob-${run}@example.test`, password };
const carol = { email: `carol-${run}@example.test`, password };
const emails = [alice.email, bob.email, carol.email];

type Jar = Map<string, string>;
const cookieHeader = (jar: Jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
function absorb(jar: Jar, res: Response) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
}

let ipSeq = 0;
const nextIp = () => `11.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;
let ip = nextIp();

function req(urlPath: string, init: { method?: string; jar?: Jar; body?: BodyInit; json?: unknown; origin?: string | null; ip?: string; auth?: string } = {}) {
  const h = new Headers({ "x-real-ip": init.ip ?? ip });
  if (init.origin !== null) h.set("origin", init.origin ?? new URL(BASE).origin);
  if (init.jar && init.jar.size) h.set("cookie", cookieHeader(init.jar));
  if (init.auth) h.set("authorization", init.auth);
  let body = init.body;
  if (init.json !== undefined) {
    h.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  } else if (body instanceof URLSearchParams) {
    h.set("content-type", "application/x-www-form-urlencoded");
    body = body.toString();
  }
  ambient = h;
  return new NextRequest(new URL(urlPath, BASE), { method: init.method ?? (body ? "POST" : "GET"), headers: h, body });
}

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

async function login(email: string, pw: string): Promise<Jar | null> {
  const jar: Jar = new Map();
  const csrfRes = await authRoute.GET(req("/api/auth/csrf", { jar }));
  absorb(jar, csrfRes);
  const { csrfToken } = await csrfRes.json();
  const res = await authRoute.POST(
    req("/api/auth/callback/credentials", { jar, body: new URLSearchParams({ csrfToken, email, password: pw, callbackUrl: `${BASE}/account` }) }),
  );
  absorb(jar, res);
  return [...jar.keys()].some((k) => k.endsWith("authjs.session-token")) ? jar : null;
}

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizePath(opts: { challenge?: string; state?: string; redirect?: string; method?: string; client?: string; responseType?: string; extra?: Record<string, string> } = {}) {
  const q = new URLSearchParams({
    client_id: opts.client ?? "twaz-launcher",
    redirect_uri: opts.redirect ?? redirectUri,
    response_type: opts.responseType ?? "code",
    state: opts.state ?? "state-state-state",
    ...(opts.challenge ? { code_challenge: opts.challenge } : {}),
    ...(opts.method ? { code_challenge_method: opts.method } : opts.challenge ? { code_challenge_method: "S256" } : {}),
    ...opts.extra,
  });
  return `/launcher/authorize?${q}`;
}

function hidden(html: string, name: string) {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!m) throw new Error(`missing hidden ${name}`);
  return m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function noStore(res: Response) {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("pragma")).toBe("no-cache");
}

function pageHeaders(res: Response) {
  noStore(res);
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(res.headers.get("content-security-policy")).toContain("form-action 'self' http://127.0.0.1:*");
}

async function approve(jar: Jar, challenge: string, state = "state-state-state") {
  const page = await authorize.GET(req(authorizePath({ challenge, state }), { jar }));
  expect(page.status).toBe(200);
  pageHeaders(page);
  const html = await page.text();
  expect(html).toContain("Allow TheWorldAfterZ Launcher to sign in as");
  expect(html).toContain("Not you?");
  expect(html).toContain("Sign out");
  const fields: Record<string, string> = { decision: "approve" };
  for (const name of ["userId", "client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method"]) {
    fields[name] = hidden(html, name);
  }
  const res = await authorize.POST(req("/launcher/authorize", { jar, body: new URLSearchParams(fields) }));
  return { res, html, fields };
}

async function exchange(code: string, verifier: string, redirect = redirectUri) {
  return tokenRoute.POST(req("/api/launcher/token", {
    origin: null,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: "twaz-launcher",
      code_verifier: verifier,
    }),
  }));
}

async function refresh(refreshToken: string) {
  return tokenRoute.POST(req("/api/launcher/token", {
    origin: null,
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: "twaz-launcher" }),
  }));
}

async function play(access: string, body: Record<string, unknown> = {}) {
  return playRoute.POST(req("/api/launcher/play-check", {
    origin: null,
    auth: `Bearer ${access}`,
    json: { nonce: "nonce-nonce-nonce", game_build: "1.0.0", platform: "linux", ...body },
  }));
}

let aliceId = "";
let bobId = "";
let carolId = "";
let aliceJar: Jar;
let bobJar: Jar;
let carolJar: Jar;

beforeAll(async () => {
  await prisma.rateLimit.deleteMany({ where: { key: { startsWith: "launcher-" } } });
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  for (const [email, role] of [[alice.email, "PLAYER"], [bob.email, "PLAYER"], [carol.email, "PLAYER"]] as const) {
    const user = await prisma.user.create({ data: { email, passwordHash: hash, emailVerifiedAt: new Date(), role } });
    if (email === alice.email) aliceId = user.id;
    if (email === bob.email) bobId = user.id;
    if (email === carol.email) carolId = user.id;
  }
  // Login is capped at 5 per account per 15 minutes. Reuse these sessions.
  aliceJar = (await login(alice.email, password))!;
  bobJar = (await login(bob.email, password))!;
  carolJar = (await login(carol.email, password))!;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.accessKey.deleteMany({ where: { batchLabel: batch } });
  await prisma.rateLimit.deleteMany({ where: { key: { startsWith: "launcher-" } } });
  await prisma.$disconnect();
});

describe("authorize", () => {
  it("does not redirect or reflect an invalid client or redirect", async () => {
    for (const redirect of ["https://evil.example/callback", "http://127.0.0.1:80/callback", "http://127.0.0.1:43123/callback?x=1", "http://localhost:43123/callback"]) {
      const res = await authorize.GET(req(authorizePath({ challenge: "A".repeat(43), redirect, client: redirect.includes("evil") ? "twaz-launcher" : "twaz-launcher" })));
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      pageHeaders(res);
      const body = await res.text();
      expect(body).not.toContain("evil.example");
      expect(body).not.toContain("x=1");
      expect(body).not.toContain("localhost");
    }
    const badClient = await authorize.GET(req(authorizePath({ challenge: "A".repeat(43), client: "other-app" })));
    expect(badClient.status).toBe(200);
    expect(badClient.headers.get("location")).toBeNull();
    expect(await badClient.text()).not.toContain("other-app");
  });

  it("sends invalid state, challenge, or method to the validated redirect", async () => {
    const challenge = "B".repeat(43);
    const cases = [
      authorizePath({ challenge, state: "short" }),
      authorizePath({ challenge, method: "plain" }),
      authorizePath({ state: "state-state-state" }),
      authorizePath({ challenge, responseType: "token" }),
    ];
    for (const path of cases) {
      const res = await authorize.GET(req(path));
      expect(res.status).toBe(302);
      pageHeaders(res);
      const loc = new URL(res.headers.get("location")!);
      expect(`${loc.origin}${loc.pathname}`).toBe(redirectUri);
      expect(loc.searchParams.get("error")).toBe("invalid_request");
      expect(loc.searchParams.get("code")).toBeNull();
    }
    const echoed = new URL((await authorize.GET(req(authorizePath({ challenge, state: "short" })))).headers.get("location")!);
    expect(echoed.searchParams.get("state")).toBe("short");
    expect(await prisma.nativeAuthCode.count({ where: { userId: aliceId } })).toBe(0);
  });

  it("sends an anonymous player to login and back", async () => {
    const { challenge } = pkcePair();
    const path = authorizePath({ challenge });
    const res = await authorize.GET(req(path));
    expect(res.status).toBe(303);
    pageHeaders(res);
    const next = new URL(res.headers.get("location")!, BASE).searchParams.get("next");
    expect(safeLauncherNext(next)).toBe(next);
    expect(next).toContain("client_id=twaz-launcher");
    expect(next).toContain("code_challenge=");
  });

  it("shows consent for a verified session and refuses an unverified one without a code", async () => {
    const jar = aliceJar;
    await prisma.user.update({ where: { id: aliceId }, data: { emailVerifiedAt: null } });
    const { challenge } = pkcePair();
    const blocked = await authorize.GET(req(authorizePath({ challenge }), { jar }));
    expect(blocked.status).toBe(200);
    expect(blocked.headers.get("location")).toBeNull();
    expect(await blocked.text()).toContain("Verify your email first");
    expect(await prisma.nativeAuthCode.count({ where: { userId: aliceId } })).toBe(0);
    await prisma.user.update({ where: { id: aliceId }, data: { emailVerifiedAt: new Date() } });
    const { res, html } = await approve(jar, challenge);
    expect(html).toContain(alice.email);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(redirectUri);
    expect(loc.searchParams.get("state")).toBe("state-state-state");
    const code = loc.searchParams.get("code")!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await prisma.nativeAuthCode.findUniqueOrThrow({ where: { codeHash: sha256(code) } });
    expect(JSON.stringify(row)).not.toContain(code);
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(45_000);
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
  });

  it("rejects a consent POST from another origin and an account switch", async () => {
    const jar = aliceJar;
    const { challenge } = pkcePair();
    const page = await authorize.GET(req(authorizePath({ challenge }), { jar }));
    const html = await page.text();
    const fields: Record<string, string> = { decision: "approve" };
    for (const name of ["userId", "client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method"]) {
      fields[name] = hidden(html, name);
    }
    const before = await prisma.nativeAuthCode.count({ where: { userId: { in: [aliceId, bobId] } } });
    const csrf = await authorize.POST(req("/launcher/authorize", { jar, origin: "https://evil.example", body: new URLSearchParams(fields) }));
    expect(csrf.status).toBe(403);
    expect(csrf.headers.get("location")).toBeNull();
    pageHeaders(csrf);
    const switched = await authorize.POST(req("/launcher/authorize", { jar: bobJar, body: new URLSearchParams(fields) }));
    expect(switched.status).toBe(403);
    expect(switched.headers.get("location")).toBeNull();
    expect(await switched.text()).toContain("different account");
    expect(await prisma.nativeAuthCode.count({ where: { userId: { in: [aliceId, bobId] } } })).toBe(before);
  });

  it("denies with access_denied and does not mint a code", async () => {
    const jar = aliceJar;
    const { challenge } = pkcePair();
    const page = await authorize.GET(req(authorizePath({ challenge, state: "deny-deny-deny-1" }), { jar }));
    const html = await page.text();
    const fields: Record<string, string> = { decision: "deny" };
    for (const name of ["userId", "client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method"]) {
      fields[name] = hidden(html, name);
    }
    const before = await prisma.nativeAuthCode.count({ where: { userId: aliceId } });
    const res = await authorize.POST(req("/launcher/authorize", { jar, body: new URLSearchParams(fields) }));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("deny-deny-deny-1");
    expect(loc.searchParams.get("code")).toBeNull();
    expect(await prisma.nativeAuthCode.count({ where: { userId: aliceId } })).toBe(before);
  });
});

describe("authorization code", () => {
  it("exchanges a code once and rejects a bad verifier, redirect, or expired code", async () => {
    const jar = aliceJar;
    const good = pkcePair();
    const approved = await approve(jar, good.challenge, "exchange-state-1");
    const code = new URL(approved.res.headers.get("location")!).searchParams.get("code")!;
    const wrong = await exchange(code, `${good.verifier.slice(0, -1)}x`);
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "invalid_grant" });
    noStore(wrong);
    expect(wrong.headers.get("location")).toBeNull();
    const burned = await prisma.nativeAuthCode.findUniqueOrThrow({ where: { codeHash: sha256(code) } });
    expect(burned.usedAt).toBeTruthy();
    expect(burned.sessionId).toBeNull();

    const mismatch = pkcePair();
    const mismatchCode = new URL((await approve(jar, mismatch.challenge, "exchange-state-2")).res.headers.get("location")!).searchParams.get("code")!;
    const mismatched = await exchange(mismatchCode, mismatch.verifier, "http://127.0.0.1:43124/callback");
    expect(await mismatched.json()).toEqual({ error: "invalid_grant" });
    expect((await prisma.nativeAuthCode.findUniqueOrThrow({ where: { codeHash: sha256(mismatchCode) } })).sessionId).toBeNull();

    const expired = pkcePair();
    const expiredCode = new URL((await approve(jar, expired.challenge, "exchange-state-3")).res.headers.get("location")!).searchParams.get("code")!;
    await prisma.nativeAuthCode.update({ where: { codeHash: sha256(expiredCode) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await (await exchange(expiredCode, expired.verifier)).json()).toEqual({ error: "invalid_grant" });
    const expiredRow = await prisma.nativeAuthCode.findUniqueOrThrow({ where: { codeHash: sha256(expiredCode) } });
    expect(expiredRow.usedAt).toBeNull();

    const ok = pkcePair();
    const okCode = new URL((await approve(jar, ok.challenge, "exchange-state-4")).res.headers.get("location")!).searchParams.get("code")!;
    const res = await exchange(okCode, ok.verifier);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 900, account: { id: aliceId, email: alice.email } });
    expect(typeof body.account.id).toBe("string");
    expect(Object.keys(body).sort()).toEqual(["access_token", "account", "expires_in", "refresh_token", "token_type"]);
    const claims = verifyAccessToken(body.access_token);
    expect(claims).toMatchObject({ sub: aliceId, aud: "twaz-launcher", iss: new URL(BASE).origin });
    expect(claims!.exp - claims!.iat).toBe(900);
    const stored = JSON.stringify(await prisma.nativeRefreshToken.findMany({ where: { sessionId: claims!.sid } }));
    expect(stored).not.toContain(body.refresh_token);
    expect(stored).not.toContain(body.access_token);
    const session = await prisma.nativeSession.findUniqueOrThrow({ where: { id: claims!.sid } });
    expect(session.absoluteExpiresAt.getTime() - session.createdAt.getTime()).toBeGreaterThan(89 * 24 * 60 * 60 * 1000);
    expect(session.idleExpiresAt.getTime() - session.createdAt.getTime()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(await prisma.auditLog.count({ where: { targetId: session.id, action: "NATIVE_SESSION_CREATED" } })).toBe(1);
  });

  it("revokes the linked session when a code is presented twice", async () => {
    const jar = aliceJar;
    const pair = pkcePair();
    const code = new URL((await approve(jar, pair.challenge, "reuse-state-state")).res.headers.get("location")!).searchParams.get("code")!;
    const first = await (await exchange(code, pair.verifier)).json();
    const second = await exchange(code, pair.verifier);
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: "invalid_grant" });
    const sid = verifyAccessToken(first.access_token)!.sid;
    const session = await prisma.nativeSession.findUniqueOrThrow({ where: { id: sid } });
    expect(session.revokeReason).toBe("code_reuse");
    expect(await prisma.auditLog.count({ where: { targetId: sid, action: "NATIVE_CODE_REUSE" } })).toBe(1);
    const again = await play(first.access_token);
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: "session_revoked" });
    expect(again.headers.get("location")).toBeNull();
  });

  it("uses RFC errors and never redirects", async () => {
    const missing = await tokenRoute.POST(req("/api/launcher/token", { origin: null, body: new URLSearchParams({ client_id: "twaz-launcher" }) }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "invalid_request" });
    const unsupported = await tokenRoute.POST(req("/api/launcher/token", {
      origin: "https://evil.example",
      body: new URLSearchParams({ grant_type: "password", client_id: "twaz-launcher" }),
    }));
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toEqual({ error: "unsupported_grant_type" });
    expect(unsupported.headers.get("location")).toBeNull();
    const client = await tokenRoute.POST(req("/api/launcher/token", {
      origin: null,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: "nope", code: "x", redirect_uri: redirectUri, code_verifier: "y".repeat(43) }),
    }));
    expect(await client.json()).toEqual({ error: "invalid_client" });
  });
});

describe("refresh", () => {
  it("rotates, and a replay revokes the family", async () => {
    const jar = aliceJar;
    const pair = pkcePair();
    const code = new URL((await approve(jar, pair.challenge, "refresh-state-11")).res.headers.get("location")!).searchParams.get("code")!;
    const first = await (await exchange(code, pair.verifier)).json();
    const secondRes = await refresh(first.refresh_token);
    expect(secondRes.status).toBe(200);
    const second = await secondRes.json();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await play(second.access_token)).status).toBe(200);
    const third = await (await refresh(second.refresh_token)).json();
    const replay = await refresh(second.refresh_token);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_grant" });
    expect((await play(third.access_token)).status).toBe(401);
    expect((await refresh(third.refresh_token)).status).toBe(400);
    const sid = verifyAccessToken(first.access_token)!.sid;
    expect((await prisma.nativeSession.findUniqueOrThrow({ where: { id: sid } })).revokeReason).toBe("refresh_reuse");
    expect(await prisma.auditLog.count({ where: { targetId: sid, action: "NATIVE_REFRESH_REUSE" } })).toBe(1);
  });

  it("lets exactly one of two concurrent refreshes succeed, then the family is dead", async () => {
    const jar = aliceJar;
    const pair = pkcePair();
    const code = new URL((await approve(jar, pair.challenge, "concurrent-state1")).res.headers.get("location")!).searchParams.get("code")!;
    const first = await (await exchange(code, pair.verifier)).json();
    const [a, b] = await Promise.all([refresh(first.refresh_token), refresh(first.refresh_token)]);
    const oks = [a, b].filter((r) => r.status === 200);
    const bads = [a, b].filter((r) => r.status === 400);
    expect(oks).toHaveLength(1);
    expect(bads).toHaveLength(1);
    expect(await bads[0].json()).toEqual({ error: "invalid_grant" });
    const winner = await oks[0].json();
    expect((await refresh(winner.refresh_token)).status).toBe(400);
    expect((await play(winner.access_token)).status).toBe(401);
  });

  it("rejects idle expiry, absolute expiry, and a revoked family", async () => {
    const jar = aliceJar;
    async function minted(state: string) {
      const pair = pkcePair();
      const code = new URL((await approve(jar, pair.challenge, state)).res.headers.get("location")!).searchParams.get("code")!;
      const body = await (await exchange(code, pair.verifier)).json();
      const sid = verifyAccessToken(body.access_token)!.sid;
      return { body, sid };
    }
    const idle = await minted("idle-state-state1");
    await prisma.nativeSession.update({ where: { id: idle.sid }, data: { idleExpiresAt: new Date(Date.now() - 1000) } });
    expect(await (await refresh(idle.body.refresh_token)).json()).toEqual({ error: "invalid_grant" });
    expect((await prisma.nativeRefreshToken.findFirstOrThrow({ where: { sessionId: idle.sid, usedAt: null } })).usedAt).toBeNull();
    expect((await play(idle.body.access_token)).status).toBe(401);

    const absolute = await minted("absolute-state-1");
    await prisma.nativeSession.update({ where: { id: absolute.sid }, data: { absoluteExpiresAt: new Date(Date.now() - 1000) } });
    expect((await refresh(absolute.body.refresh_token)).status).toBe(400);
    expect((await play(absolute.body.access_token)).status).toBe(401);

    const revoked = await minted("revoked-state-11");
    await revokeRoute.POST(req("/api/launcher/revoke", {
      origin: null,
      body: new URLSearchParams({ token: revoked.body.refresh_token, token_type_hint: "refresh_token" }),
    }));
    expect((await refresh(revoked.body.refresh_token)).status).toBe(400);
    expect(await (await play(revoked.body.access_token)).json()).toEqual({ error: "session_revoked" });
  });
});

describe("revoke", () => {
  it("revokes by the current or a used refresh token, and by an expired access token", async () => {
    const jar = aliceJar;
    async function minted(state: string) {
      const pair = pkcePair();
      const code = new URL((await approve(jar, pair.challenge, state)).res.headers.get("location")!).searchParams.get("code")!;
      return (await exchange(code, pair.verifier)).json();
    }
    const current = await minted("revoke-current-1");
    const byCurrent = await revokeRoute.POST(req("/api/launcher/revoke", {
      origin: null,
      body: new URLSearchParams({ token: current.refresh_token, token_type_hint: "refresh_token" }),
    }));
    expect(byCurrent.status).toBe(200);
    expect(await byCurrent.json()).toEqual({});
    noStore(byCurrent);
    expect((await play(current.access_token)).status).toBe(401);

    const rotated = await minted("revoke-rotated-1");
    const next = await (await refresh(rotated.refresh_token)).json();
    const byUsed = await revokeRoute.POST(req("/api/launcher/revoke", {
      origin: null,
      body: new URLSearchParams({ token: rotated.refresh_token }),
    }));
    expect(byUsed.status).toBe(200);
    expect((await play(next.access_token)).status).toBe(401);

    const aged = await minted("revoke-aged-tok1");
    const sid = verifyAccessToken(aged.access_token)!.sid;
    const pwdAt = verifyAccessToken(aged.access_token)!.pwdAt;
    const expired = signAccessToken({ sub: aliceId, sid, pwdAt }, Math.floor(Date.now() / 1000) - 1000);
    expect(verifyAccessToken(expired)).toBeNull();
    const byExpired = await revokeRoute.POST(req("/api/launcher/revoke", {
      origin: null,
      body: new URLSearchParams({ token: expired, token_type_hint: "access_token" }),
    }));
    expect(byExpired.status).toBe(200);
    expect((await prisma.nativeSession.findUniqueOrThrow({ where: { id: sid } })).revokedAt).toBeTruthy();
  });

  it("does nothing for a forged token or another user's session id", async () => {
    const alicePair = pkcePair();
    const bobPair = pkcePair();
    const aliceCode = new URL((await approve(aliceJar, alicePair.challenge, "forge-alice-state")).res.headers.get("location")!).searchParams.get("code")!;
    const bobCode = new URL((await approve(bobJar, bobPair.challenge, "forge-bob-state-1")).res.headers.get("location")!).searchParams.get("code")!;
    const aliceTokens = await (await exchange(aliceCode, alicePair.verifier)).json();
    const bobTokens = await (await exchange(bobCode, bobPair.verifier)).json();
    const bobSid = verifyAccessToken(bobTokens.access_token)!.sid;
    const forged = await revokeRoute.POST(req("/api/launcher/revoke", {
      origin: null,
      body: new URLSearchParams({ token: "not.a.jwt", token_type_hint: "access_token" }),
    }));
    expect(forged.status).toBe(200);
    expect(await forged.json()).toEqual({});
    expect((await prisma.nativeSession.findUniqueOrThrow({ where: { id: bobSid } })).revokedAt).toBeNull();
    const mismatched = signAccessToken({ sub: aliceId, sid: bobSid, pwdAt: 0 });
    await revokeRoute.POST(req("/api/launcher/revoke", {
      origin: null,
      body: new URLSearchParams({ token: mismatched, token_type_hint: "access_token" }),
    }));
    expect((await prisma.nativeSession.findUniqueOrThrow({ where: { id: bobSid } })).revokedAt).toBeNull();
    expect((await play(aliceTokens.access_token)).status).toBe(200);
    expect((await play(bobTokens.access_token)).status).toBe(200);
  });
});

describe("password reset", () => {
  it("revokes every family, rejects the old access token, and requires a new browser login", async () => {
    const jar = carolJar;
    const first = pkcePair();
    const second = pkcePair();
    const code1 = new URL((await approve(jar, first.challenge, "reset-state-one1")).res.headers.get("location")!).searchParams.get("code")!;
    const code2 = new URL((await approve(jar, second.challenge, "reset-state-two2")).res.headers.get("location")!).searchParams.get("code")!;
    const a = await (await exchange(code1, first.verifier)).json();
    const b = await (await exchange(code2, second.verifier)).json();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await forgotRoute.POST(req("/api/forgot-password", { body: form({ email: carol.email }) }));
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes(carol.email));
    log.mockRestore();
    const resetToken = new URL(line!.split(": ").pop()!).searchParams.get("token")!;
    const newPassword = "brand new password 2";
    expect((await resetRoute.POST(req("/api/reset-password", { body: form({ token: resetToken, password: newPassword, confirm: newPassword }) }))).headers.get("location")).toBe("/login?reset=1");
    expect(await (await play(a.access_token)).json()).toEqual({ error: "password_changed" });
    expect(await (await play(b.access_token)).json()).toEqual({ error: "password_changed" });
    expect((await refresh(a.refresh_token)).status).toBe(400);
    expect((await refresh(b.refresh_token)).status).toBe(400);
    const families = await prisma.nativeSession.findMany({ where: { userId: carolId } });
    expect(families.every((s) => s.revokeReason === "password_changed")).toBe(true);
    const stale = await authorize.GET(req(authorizePath({ challenge: "C".repeat(43) }), { jar }));
    expect(stale.status).toBe(303);
    expect(stale.headers.get("location")).toContain("/login?next=");
    const fresh = (await login(carol.email, newPassword))!;
    const page = await authorize.GET(req(authorizePath({ challenge: "C".repeat(43) }), { jar: fresh }));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Allow TheWorldAfterZ Launcher to sign in as");
  });
});

describe("play-check", () => {
  async function entitledSession() {
    const jar = aliceJar;
    const pair = pkcePair();
    const code = new URL((await approve(jar, pair.challenge, `play-state-${randomBytes(4).toString("hex")}`)).res.headers.get("location")!).searchParams.get("code")!;
    return (await exchange(code, pair.verifier)).json();
  }

  it("echoes nonce, build, and platform, and requires a non-revoked key", async () => {
    const tokens = await entitledSession();
    const none = await play(tokens.access_token, { nonce: "0123456789abcdef", game_build: " 1.2.3+build ", platform: " Linux " });
    expect(none.status).toBe(200);
    noStore(none);
    const body = await none.json();
    expect(body.entitled).toBe(false);
    expect(body.reason).toBe("no_key");
    expect(body.accountId).toBe(aliceId);
    expect(typeof body.accountId).toBe("string");
    expect(body.nonce).toBe("0123456789abcdef");
    expect(body.game_build).toBe(" 1.2.3+build ");
    expect(body.platform).toBe(" Linux ");
    expect(body.checkedAt).toBe(new Date(body.checkedAt).toISOString());
    expect(new Date(body.expiresAt).getTime() - new Date(body.checkedAt).getTime()).toBe(30_000);
    expect(Object.keys(body).sort()).toEqual(["accountId", "checkedAt", "entitled", "expiresAt", "game_build", "nonce", "platform", "reason"]);

    const numeric = await play(tokens.access_token, { game_build: 42, platform: false, nonce: "n".repeat(16) });
    expect(await numeric.json()).toMatchObject({ game_build: 42, platform: false, nonce: "n".repeat(16) });

    const code = generateKey();
    await prisma.accessKey.create({
      data: { codeHash: sha256(code), codePrefix: keyPrefix(code), tier: "BETA", status: "ACTIVE", batchLabel: batch },
    });
    const redeemed = await redeemRoute.POST(req("/api/redeem", { jar: aliceJar, body: form({ code }) }));
    expect(redeemed.headers.get("location")).toBe("/account?redeemed=1");
    expect((await play(tokens.access_token)).status).toBe(200);
    expect(await (await play(tokens.access_token, { nonce: "p".repeat(20), game_build: "beta-build", platform: "win-x64" })).json()).toMatchObject({
      entitled: true,
      reason: "ok",
      game_build: "beta-build",
      platform: "win-x64",
    });

    const active = await prisma.redemption.findFirstOrThrow({ where: { userId: aliceId, key: { status: { not: "REVOKED" } } } });
    await prisma.accessKey.update({ where: { id: active.keyId }, data: { status: "REVOKED", revokedAt: new Date(), revokeReason: "test" } });
    const alpha = await prisma.accessKey.create({
      data: {
        codeHash: sha256(`alpha-${run}-${randomBytes(4).toString("hex")}`),
        codePrefix: "ALPH",
        tier: "ALPHA",
        status: "REDEEMED",
        batchLabel: batch,
        redemption: { create: { userId: aliceId } },
      },
    });
    expect(await (await play(tokens.access_token)).json()).toMatchObject({ entitled: true, reason: "ok" });
    await prisma.accessKey.update({ where: { id: alpha.id }, data: { status: "REVOKED", revokedAt: new Date() } });
    expect(await (await play(tokens.access_token)).json()).toMatchObject({ entitled: false, reason: "no_key" });
  });

  it("reports unverified ahead of a missing or present key, and rejects bad input", async () => {
    const tokens = await entitledSession();
    await prisma.user.update({ where: { id: aliceId }, data: { emailVerifiedAt: null } });
    expect(await (await play(tokens.access_token)).json()).toMatchObject({ entitled: false, reason: "unverified" });
    expect((await refresh(tokens.refresh_token)).status).toBe(200);
    await prisma.user.update({ where: { id: aliceId }, data: { emailVerifiedAt: new Date() } });

    expect((await playRoute.POST(req("/api/launcher/play-check", { origin: null, json: { nonce: "n".repeat(16), game_build: "1", platform: "linux" } }))).status).toBe(401);
    const short = await play(tokens.access_token, { nonce: "short" });
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ error: "invalid_request" });
    expect(short.headers.get("location")).toBeNull();
    expect((await play(tokens.access_token, { nonce: "n".repeat(129) })).status).toBe(400);
    expect((await play("not-a-token")).status).toBe(401);
    expect(await (await play("not-a-token")).json()).toEqual({ error: "invalid_token" });
  });
});

describe("registration and return-to", () => {
  it("changes only the launcher copy and never grants Play", async () => {
    const email = `newbie-${run}@example.test`;
    emails.push(email);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await registerRoute.POST(req("/api/register", { body: form({ email, password, from: "launcher" }) }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?registered=1&from=launcher");
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes(email));
    log.mockRestore();
    const token = new URL(line!.split(": ").pop()!).searchParams.get("token")!;
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).toBeNull();
    expect(await prisma.redemption.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.nativeSession.count({ where: { userId: user.id } })).toBe(0);
    expect(await login(email, password)).toBeNull();

    const registered = renderToStaticMarkup(await RegisterPage({ searchParams: Promise.resolve({ from: "launcher" }) }));
    expect(registered).toContain("Check your email, then return to the launcher and press Log in");
    expect(renderToStaticMarkup(await RegisterPage({ searchParams: Promise.resolve({}) }))).not.toContain("return to the launcher");
    const after = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ registered: "1", from: "launcher" }) }));
    expect(after).toContain("Check your email, then return to the launcher and press Log in");
    expect(renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ registered: "1" }) }))).not.toContain("return to the launcher");

    expect((await verifyRoute.GET(req(`/api/verify?token=${token}`))).headers.get("location")).toBe("/login?verified=1");
    const jar = (await login(email, password))!;
    const pair = pkcePair();
    const code = new URL((await approve(jar, pair.challenge, "newbie-state-111")).res.headers.get("location")!).searchParams.get("code")!;
    const tokens = await (await exchange(code, pair.verifier)).json();
    expect(await (await play(tokens.access_token)).json()).toMatchObject({ entitled: false, reason: "no_key" });
  });

  it("drops an unsafe next and lands a valid one on authorize", async () => {
    const evilHtml = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ next: "//evil" }) }));
    expect(evilHtml).not.toContain("//evil");
    expect(evilHtml).not.toContain('name="next"');
    expect(evilHtml).toContain('href="/register"');
    const next = `/launcher/authorize?client_id=twaz-launcher&state=${"n".repeat(16)}`;
    const goodHtml = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ next }) }));
    expect(goodHtml).toContain('name="next"');
    expect(goodHtml).toContain("/launcher/authorize?client_id=twaz-launcher&amp;state=");
    expect(goodHtml).not.toContain("/register?next");

    await prisma.rateLimit.deleteMany({ where: { key: { startsWith: "login:" } } });
    const redirectTarget = async (value: string | null, pw = password) => {
      ambient = new Headers({ host: "localhost:3000", origin: new URL(BASE).origin, "x-forwarded-proto": "http", "x-forwarded-host": "localhost:3000" });
      const fd = new FormData();
      fd.set("email", alice.email);
      fd.set("password", pw);
      if (value !== null) fd.set("next", value);
      try {
        await loginAction(fd);
      } catch (err) {
        const digest = err && typeof err === "object" && "digest" in err ? String(err.digest) : "";
        if (!digest.startsWith("NEXT_REDIRECT")) throw err;
        return digest.split(";").slice(2, -2).join(";");
      }
      throw new Error("loginAction did not redirect");
    };
    expect(await redirectTarget("//evil")).toMatch(/\/account$/);
    expect(await redirectTarget("https://evil.example/launcher/authorize?x=1")).toMatch(/\/account$/);
    expect(await redirectTarget("/\\evil")).toMatch(/\/account$/);
    expect(await redirectTarget("/launcher/authorizeX")).toMatch(/\/account$/);
    const landed = await redirectTarget(next);
    expect(landed).toContain("/launcher/authorize?");
    expect(landed).toContain("client_id=twaz-launcher");
    expect(landed).not.toContain("evil");
    const failed = await redirectTarget(next, "wrong password");
    expect(failed).toContain("/login?");
    expect(failed).toContain("error=1");
    expect(decodeURIComponent(failed)).toContain(next);
    const failedEvil = await redirectTarget("//evil", "wrong password");
    expect(failedEvil).not.toContain("evil");
    expect(failedEvil).toContain("error=1");
  });
});

describe("rate limits and retention", () => {
  it("returns 429 with Retry-After and does not burn a code", async () => {
    ip = nextIp();
    const jar = aliceJar;
    const pair = pkcePair();
    const code = new URL((await approve(jar, pair.challenge, "ratelimit-state1")).res.headers.get("location")!).searchParams.get("code")!;
    const ws = windowStart(Date.now(), LAUNCHER_LIMITS.token.windowMs);
    await prisma.rateLimit.upsert({
      where: { key: launcherTokenIpKey(ip) },
      create: { key: launcherTokenIpKey(ip), windowStart: ws, count: LAUNCHER_LIMITS.token.ip },
      update: { windowStart: ws, count: LAUNCHER_LIMITS.token.ip },
    });
    const limited = await exchange(code, pair.verifier);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    noStore(limited);
    expect((await prisma.nativeAuthCode.findUniqueOrThrow({ where: { codeHash: sha256(code) } })).usedAt).toBeNull();
    await prisma.rateLimit.delete({ where: { key: launcherTokenIpKey(ip) } });
    expect((await exchange(code, pair.verifier)).status).toBe(200);
  });

  it("limits play-check and consent", async () => {
    const tokens = await (async () => {
      const jar = bobJar;
      const pair = pkcePair();
      const code = new URL((await approve(jar, pair.challenge, "bob-play-state-1")).res.headers.get("location")!).searchParams.get("code")!;
      return (await exchange(code, pair.verifier)).json();
    })();
    const ws = windowStart(Date.now(), LAUNCHER_LIMITS.play.windowMs);
    await prisma.rateLimit.upsert({
      where: { key: launcherPlayAccountKey(bobId) },
      create: { key: launcherPlayAccountKey(bobId), windowStart: ws, count: LAUNCHER_LIMITS.play.account },
      update: { windowStart: ws, count: LAUNCHER_LIMITS.play.account },
    });
    const limited = await play(tokens.access_token);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });

    const jar = bobJar;
    const pair = pkcePair();
    const page = await authorize.GET(req(authorizePath({ challenge: pair.challenge, state: "bob-consent-limit" }), { jar }));
    const html = await page.text();
    const fields: Record<string, string> = { decision: "approve" };
    for (const name of ["userId", "client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method"]) {
      fields[name] = hidden(html, name);
    }
    const authWs = windowStart(Date.now(), LAUNCHER_LIMITS.authorize.windowMs);
    await prisma.rateLimit.upsert({
      where: { key: launcherAuthorizeAccountKey(bobId) },
      create: { key: launcherAuthorizeAccountKey(bobId), windowStart: authWs, count: LAUNCHER_LIMITS.authorize.account },
      update: { windowStart: authWs, count: LAUNCHER_LIMITS.authorize.account },
    });
    const before = await prisma.nativeAuthCode.count({ where: { userId: bobId } });
    const consent = await authorize.POST(req("/launcher/authorize", { jar, body: new URLSearchParams(fields) }));
    expect(consent.status).toBe(429);
    expect(consent.headers.get("retry-after")).toBeTruthy();
    expect(await prisma.nativeAuthCode.count({ where: { userId: bobId } })).toBe(before);
  });

  it("keeps codes for 24h after expiry and drops refresh hashes after the family ends", async () => {
    const old = await prisma.nativeAuthCode.create({
      data: {
        codeHash: sha256(`old-${run}`),
        userId: aliceId,
        clientId: "twaz-launcher",
        redirectUri,
        codeChallenge: "C".repeat(43),
        pwdAt: new Date(0),
        expiresAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      },
    });
    const recent = await prisma.nativeAuthCode.create({
      data: {
        codeHash: sha256(`recent-${run}`),
        userId: aliceId,
        clientId: "twaz-launcher",
        redirectUri,
        codeChallenge: "D".repeat(43),
        pwdAt: new Date(0),
        expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    const jar = aliceJar;
    const pair = pkcePair();
    const code = new URL((await approve(jar, pair.challenge, "prune-state-state")).res.headers.get("location")!).searchParams.get("code")!;
    const body = await (await exchange(code, pair.verifier)).json();
    const sid = verifyAccessToken(body.access_token)!.sid;
    await prisma.nativeSession.update({ where: { id: sid }, data: { absoluteExpiresAt: new Date(Date.now() - 1000) } });
    await tokenRoute.POST(req("/api/launcher/token", { origin: null, body: "grant_type=nope" }));
    expect(await prisma.nativeAuthCode.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.nativeAuthCode.findUnique({ where: { id: recent.id } })).toBeTruthy();
    expect(await prisma.nativeRefreshToken.count({ where: { sessionId: sid } })).toBe(0);
  });
});
