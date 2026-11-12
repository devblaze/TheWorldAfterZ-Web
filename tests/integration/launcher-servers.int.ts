// Launcher directory + join-ticket through the real route handlers against the Postgres at DATABASE_URL.
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.AUTH_URL ??= "http://localhost:3000";
process.env.AUTH_SECRET ??= randomBytes(32).toString("hex");
process.env.AUTH_TRUST_HOST ??= "true";
if (!process.env.LAUNCHER_TOKEN_SECRET || Buffer.byteLength(process.env.LAUNCHER_TOKEN_SECRET) < 32) {
  process.env.LAUNCHER_TOKEN_SECRET = randomBytes(32).toString("base64url");
}

const { prisma } = await import("@/lib/db");
const { sha256 } = await import("@/lib/crypto");
const { heartbeatKey } = await import("@/lib/servers");
const { signAccessToken } = await import("@/lib/launcher/jwt");
const { LAUNCHER_LIMITS, launcherDirectoryAccountKey, launcherJoinAccountKey, windowStart } = await import("@/lib/rate-limit");
const heartbeat = await import("@/app/api/servers/heartbeat/route");
const directory = await import("@/app/api/launcher/servers/route");
const join = await import("@/app/api/launcher/join-ticket/route");

const BASE = process.env.AUTH_URL!;
const run = randomBytes(4).toString("hex");
const family = `fam-${run}`;
const batch = `launcher-servers-${run}`;
const emails: string[] = [];
const serverIds: string[] = [];
const userIds: string[] = [];

type User = { id: string; token: string; sessionId: string };

async function makeUser(opts: { verified?: boolean; key?: "ACTIVE" | "REVOKED" | null } = {}): Promise<User> {
  const email = `ls-${run}-${emails.length}@example.test`;
  emails.push(email);
  const user = await prisma.user.create({ data: { email, passwordHash: "x", emailVerifiedAt: opts.verified === false ? null : new Date() } });
  userIds.push(user.id);
  if (opts.key !== null) {
    await prisma.accessKey.create({
      data: {
        codeHash: sha256(`${batch}-${email}`), codePrefix: "TEST", tier: "BETA", status: opts.key === "REVOKED" ? "REVOKED" : "REDEEMED",
        batchLabel: batch, redemption: { create: { userId: user.id } },
      },
    });
  }
  const now = Date.now();
  const s = await prisma.nativeSession.create({
    data: { userId: user.id, clientId: "twaz-launcher", lastUsedAt: new Date(now), idleExpiresAt: new Date(now + 3600e3), absoluteExpiresAt: new Date(now + 7200e3) },
  });
  return { id: user.id, sessionId: s.id, token: signAccessToken({ sub: user.id, sid: s.id, pwdAt: 0 }) };
}

async function makeServer(extra: Record<string, unknown> = {}) {
  const s = await prisma.officialServer.create({
    data: {
      name: `srv ${run} ${serverIds.length}`, region: "eu", host: "play.example.org", port: 7777, gameBuild: "0.59.1",
      buildFamily: family, protocolVersion: 3, clientPlatforms: ["win-x64", "linux-x64"], secretHash: sha256(randomBytes(32).toString("base64url")),
      secretRotatedAt: new Date(), lastHeartbeatAt: new Date(), players: 1, maxPlayers: 16, instanceNonce: "n".repeat(16), serverRuntime: "linux-x64",
      reportedGameBuild: "0.59.1-linux", ...extra,
    },
  });
  serverIds.push(s.id);
  return s;
}

const query = { build_family: family, protocol_version: "3", client_platform: "win-x64", game_build: "0.59-abc1234" };
function list(token: string | null, q: Record<string, string> | string = query) {
  const h = new Headers({ "x-real-ip": "13.0.0.1" });
  if (token) h.set("authorization", `Bearer ${token}`);
  const qs = typeof q === "string" ? q : new URLSearchParams(q).toString();
  return directory.GET(new NextRequest(new URL(`/api/launcher/servers?${qs}`, BASE), { headers: h }));
}

const nonce = () => randomBytes(18).toString("base64url");
const joinBody = (serverId: string, extra: Record<string, unknown> = {}) => ({
  serverId, build_family: family, protocol_version: 3, client_platform: "win-x64", game_build: "0.59-abc1234", nonce: nonce(), ...extra,
});
// For tests that make more than 10 calls on purpose; the limiter has its own test.
async function freshTicket(token: string | null, body: unknown, raw?: string) {
  await resetLimits();
  return ticket(token, body, raw);
}
function ticket(token: string | null, body: unknown, raw?: string) {
  const h = new Headers({ "x-real-ip": "13.0.0.1", "content-type": "application/json" });
  if (token) h.set("authorization", `Bearer ${token}`);
  return join.POST(new NextRequest(new URL("/api/launcher/join-ticket", BASE), { method: "POST", headers: h, body: raw ?? JSON.stringify(body) }));
}

async function expectError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("location")).toBeNull();
  expect(await res.json()).toEqual({ error });
}
async function expectDeny(res: Response, reason: string) {
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ entitled: false, reason });
}

const resetLimits = () => prisma.rateLimit.deleteMany({ where: { key: { in: userIds.flatMap((id) => [launcherDirectoryAccountKey(id), launcherJoinAccountKey(id)]) } } });

let entitled: User;
beforeAll(async () => {
  entitled = await makeUser();
});
beforeEach(resetLimits);

afterAll(async () => {
  await prisma.officialServer.deleteMany({ where: { id: { in: serverIds } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { targetId: { in: serverIds } }] } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.accessKey.deleteMany({ where: { batchLabel: batch } });
  await prisma.rateLimit.deleteMany({ where: { key: { in: serverIds.map(heartbeatKey) } } });
  await resetLimits();
  await prisma.$disconnect();
});

describe("native auth on both routes", () => {
  it("401s a missing, foreign or malformed bearer and ignores cookies", async () => {
    const { id } = await makeServer();
    await expectError(await list(null), 401, "invalid_token");
    await expectError(await ticket(null, joinBody(id)), 401, "invalid_token");
    await expectError(await list("not.a.token"), 401, "invalid_token");
    await expectError(await ticket("not.a.token", joinBody(id)), 401, "invalid_token");
    const cookieOnly = new NextRequest(new URL(`/api/launcher/servers?${new URLSearchParams(query)}`, BASE), { headers: { cookie: "authjs.session-token=x" } });
    await expectError(await directory.GET(cookieOnly), 401, "invalid_token");
  });

  it("401s expired, revoked and password-changed live sessions", async () => {
    const { id } = await makeServer();
    const cases: [string, (u: User) => Promise<unknown>][] = [
      ["session_revoked", (u) => prisma.nativeSession.update({ where: { id: u.sessionId }, data: { revokedAt: new Date() } })],
      ["session_revoked", (u) => prisma.nativeSession.update({ where: { id: u.sessionId }, data: { idleExpiresAt: new Date(Date.now() - 1000) } })],
      ["session_revoked", (u) => prisma.nativeSession.update({ where: { id: u.sessionId }, data: { absoluteExpiresAt: new Date(Date.now() - 1000) } })],
      ["password_changed", (u) => prisma.user.update({ where: { id: u.id }, data: { passwordChangedAt: new Date() } })],
    ];
    for (const [error, spoil] of cases) {
      const u = await makeUser();
      expect((await list(u.token)).status).toBe(200);
      await spoil(u);
      await expectError(await list(u.token), 401, error);
      await expectError(await ticket(u.token, joinBody(id)), 401, error);
    }
    expect(await prisma.joinTicket.count({ where: { serverId: id } })).toBe(0);
  });
});

describe("GET /api/launcher/servers", () => {
  it("lists only ACTIVE, recently heard, compatible servers with exactly the allowlisted fields", async () => {
    const fam = `${family}-list`;
    const q = { ...query, build_family: fam };
    const good = await makeServer({ buildFamily: fam, region: "aa" });
    await makeServer({ buildFamily: fam, status: "DISABLED" });
    await makeServer({ buildFamily: fam, lastHeartbeatAt: null });
    await makeServer({ buildFamily: fam, lastHeartbeatAt: new Date(Date.now() - 91_000) });
    await makeServer({ buildFamily: fam, protocolVersion: 4 });
    await makeServer({ buildFamily: `${fam}-other` });
    const linuxOnly = await makeServer({ buildFamily: fam, clientPlatforms: ["linux-x64"], region: "ab" });

    const res = await list(entitled.token, q);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("location")).toBeNull();
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["checkedAt", "servers"]);
    expect(body.checkedAt).toBe(new Date(body.checkedAt).toISOString());
    const ids = body.servers.map((s: { id: string }) => s.id);
    expect(ids).toEqual([good.id]);
    expect(body.servers[0]).toEqual({
      id: good.id, name: good.name, region: "aa", host: "play.example.org", port: 7777, buildFamily: fam, protocolVersion: 3,
      players: 1, maxPlayers: 16, online: true,
    });
    const text = JSON.stringify(body);
    for (const leak of [good.secretHash, "secretHash", "linux-x64", "0.59.1-linux", "n".repeat(16), "instanceNonce", "status"]) expect(text).not.toContain(leak);

    const linux = await (await list(entitled.token, { ...q, client_platform: "linux-x64" })).json();
    expect(linux.servers.map((s: { id: string }) => s.id)).toEqual([good.id, linuxOnly.id]);
  });

  it("returns 200 with an empty list on any mismatch, never 409", async () => {
    await makeServer();
    for (const q of [{ ...query, build_family: "nope" }, { ...query, protocol_version: "999" }]) {
      const res = await list(entitled.token, q);
      expect(res.status).toBe(200);
      expect((await res.json()).servers).toEqual([]);
    }
    const winBlocked = `${family}-lin`;
    await makeServer({ buildFamily: winBlocked, clientPlatforms: ["linux-x64"] });
    expect((await (await list(entitled.token, { ...query, build_family: winBlocked })).json()).servers).toEqual([]);
  });

  it("lists and issues tickets against the family adopted by a new-process heartbeat", async () => {
    const secret = randomBytes(32).toString("base64url");
    const s = await makeServer({ secretHash: sha256(secret), instanceNonce: "o".repeat(16) });
    const newFamily = `${family}-hb`;
    const newNonce = "p".repeat(16);
    const hb = await heartbeat.POST(new NextRequest(new URL("/api/servers/heartbeat", BASE), {
      method: "POST",
      headers: new Headers({ authorization: `TwazServer ${s.id}.${secret}`, "content-type": "application/json" }),
      body: JSON.stringify({
        game_build: "0.60-linux", build_family: newFamily, protocol_version: 4, server_runtime: "linux-x64",
        instance_nonce: newNonce, players: 1, maxPlayers: 16,
      }),
    }));
    expect(hb.status).toBe(200);

    const oldList = await (await list(entitled.token)).json();
    expect(oldList.servers.map((row: { id: string }) => row.id)).not.toContain(s.id);
    const newList = await (await list(entitled.token, { ...query, build_family: newFamily, protocol_version: "4" })).json();
    expect(newList.servers.map((row: { id: string; buildFamily: string; protocolVersion: number }) => row)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: s.id, buildFamily: newFamily, protocolVersion: 4 })]),
    );
    await expectDeny(await freshTicket(entitled.token, joinBody(s.id)), "build_mismatch");
    const issued = await freshTicket(entitled.token, joinBody(s.id, { build_family: newFamily, protocol_version: 4 }));
    expect(issued.status).toBe(200);
    const body = await issued.json();
    expect(body).toMatchObject({ serverId: s.id, build_family: newFamily, protocol_version: 4 });
    expect(body.ticket).toEqual(expect.any(String));
    // Later tests count TICKET_ISSUED rows for this account; remove the one this case wrote.
    await prisma.auditLog.deleteMany({ where: { actorId: entitled.id, action: "TICKET_ISSUED", targetId: { not: null } } });
    await prisma.joinTicket.deleteMany({ where: { serverId: s.id } });
  });

  it("caps at 64 rows in a deterministic order", async () => {
    const big = `${family}-big`;
    for (let i = 0; i < 66; i++) await makeServer({ buildFamily: big, region: `r${String(i % 3)}`, name: `n${String(65 - i).padStart(2, "0")}` });
    const a = await (await list(entitled.token, { ...query, build_family: big })).json();
    const b = await (await list(entitled.token, { ...query, build_family: big })).json();
    expect(a.servers).toHaveLength(64);
    expect(a.servers.map((s: { id: string }) => s.id)).toEqual(b.servers.map((s: { id: string }) => s.id));
    const keys = a.servers.map((s: { region: string; name: string }) => `${s.region}|${s.name}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("400s missing or malformed params", async () => {
    for (const q of ["", "build_family=x", new URLSearchParams({ ...query, protocol_version: "abc" }).toString(),
      new URLSearchParams({ ...query, protocol_version: "0" }).toString(), new URLSearchParams({ ...query, client_platform: "osx-x64" }).toString(),
      `${new URLSearchParams(query)}&build_family=dup`, new URLSearchParams({ ...query, game_build: "" }).toString()]) {
      await expectError(await list(entitled.token, q), 400, "invalid_request");
    }
  });

  it("403s unverified before no_key, and no_key for all-revoked keys", async () => {
    await makeServer();
    await expectError(await list((await makeUser({ verified: false, key: null })).token), 403, "unverified");
    await expectError(await list((await makeUser({ verified: false })).token), 403, "unverified");
    await expectError(await list((await makeUser({ key: null })).token), 403, "no_key");
    await expectError(await list((await makeUser({ key: "REVOKED" })).token), 403, "no_key");
  });

  it("rate limits 30/min/account with a positive delta-seconds Retry-After, separate from join", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      const u = await makeUser();
      const { id } = await makeServer();
      for (let i = 0; i < LAUNCHER_LIMITS.directory.account; i++) expect((await list(u.token)).status).toBe(200);
      const limited = await list(u.token);
      await expectError(limited, 429, "rate_limited");
      const ra = limited.headers.get("retry-after")!;
      expect(ra).toMatch(/^[1-9][0-9]*$/);
      expect(Number(ra)).toBeLessThanOrEqual(60);
      // Another account and the join bucket are untouched.
      expect((await list(entitled.token)).status).toBe(200);
      expect((await ticket(u.token, joinBody(id))).status).toBe(200);
      expect(await prisma.rateLimit.findUnique({ where: { key: launcherDirectoryAccountKey(u.id) } })).toMatchObject({ count: 31 });
    } finally {
      clock.mockRestore();
    }
  });
});

describe("POST /api/launcher/join-ticket", () => {
  it("issues a ticket once, stores only its sha256 and audits without the plaintext", async () => {
    const s = await makeServer();
    const body = joinBody(s.id, { client_platform: "linux-x64", game_build: "0.59-linux build" });
    const spies = (["log", "error", "warn", "info"] as const).map((m) => vi.spyOn(console, m));
    const res = await ticket(entitled.token, body);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("location")).toBeNull();
    const out = await res.json();
    expect(Object.keys(out).sort()).toEqual(["accountId", "build_family", "checkedAt", "client_platform", "expiresAt", "game_build", "nonce", "protocol_version", "serverId", "ticket"]);
    expect(out).toMatchObject({
      serverId: s.id, accountId: entitled.id, nonce: body.nonce, build_family: family, protocol_version: 3, client_platform: "linux-x64", game_build: "0.59-linux build",
    });
    expect(out.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(out.ticket, "base64url")).toHaveLength(32);
    expect(out.checkedAt).toBe(new Date(out.checkedAt).toISOString());
    expect(out.expiresAt).toBe(new Date(out.expiresAt).toISOString());
    expect(Date.parse(out.expiresAt) - Date.parse(out.checkedAt)).toBe(60_000);

    const row = await prisma.joinTicket.findUniqueOrThrow({ where: { ticketHash: sha256(out.ticket) } });
    expect(row).toMatchObject({
      userId: entitled.id, nativeSessionId: entitled.sessionId, serverId: s.id, buildFamily: family, protocolVersion: 3,
      clientPlatform: "linux-x64", gameBuild: "0.59-linux build", usedAt: null, usedByConnection: null,
    });
    expect(row.expiresAt.toISOString()).toBe(out.expiresAt);
    expect(JSON.stringify(row)).not.toContain(out.ticket);
    const audits = await prisma.auditLog.findMany({ where: { actorId: entitled.id } });
    const issued = audits.filter((a) => a.action === "TICKET_ISSUED");
    expect(issued).toHaveLength(1);
    expect(issued[0].targetId).toBe(row.id);
    expect(JSON.stringify(audits)).not.toContain(out.ticket);
    expect(JSON.stringify(audits)).not.toContain(row.ticketHash);
    expect(spies.flatMap((s) => s.mock.calls).flat().map(String).join(" ")).not.toContain(out.ticket);
    spies.forEach((s) => s.mockRestore());

    const again = await (await ticket(entitled.token, joinBody(s.id))).json();
    expect(again.ticket).not.toBe(out.ticket);
  });

  it("denies in order: unverified, no_key, server_not_found, server_offline, build_mismatch, server_full", async () => {
    const ok = await makeServer();
    const disabled = await makeServer({ status: "DISABLED" });
    const stale = await makeServer({ lastHeartbeatAt: new Date(Date.now() - 91_000) });
    const never = await makeServer({ lastHeartbeatAt: null });
    const full = await makeServer({ players: 16, maxPlayers: 16 });
    const linuxOnly = await makeServer({ clientPlatforms: ["linux-x64"] });
    // A disabled, stale, mismatched and full server: the first failing rule wins.
    const worst = await makeServer({ status: "DISABLED", lastHeartbeatAt: null, protocolVersion: 9, players: 16, maxPlayers: 16 });

    // Entitlement before lookup: unknown and existing ids are indistinguishable.
    for (const sid of [ok.id, "doesnotexist", worst.id]) {
      await expectDeny(await freshTicket((await makeUser({ verified: false })).token, joinBody(sid)), "unverified");
      await expectDeny(await freshTicket((await makeUser({ verified: false, key: null })).token, joinBody(sid)), "unverified");
      await expectDeny(await freshTicket((await makeUser({ key: null })).token, joinBody(sid)), "no_key");
      await expectDeny(await freshTicket((await makeUser({ key: "REVOKED" })).token, joinBody(sid)), "no_key");
    }
    await expectDeny(await freshTicket(entitled.token, joinBody("doesnotexist")), "server_not_found");
    await expectDeny(await freshTicket(entitled.token, joinBody(disabled.id)), "server_not_found");
    await expectDeny(await freshTicket(entitled.token, joinBody(worst.id)), "server_not_found");
    await expectDeny(await freshTicket(entitled.token, joinBody(stale.id)), "server_offline");
    await expectDeny(await freshTicket(entitled.token, joinBody(never.id)), "server_offline");
    const staleFull = await makeServer({ lastHeartbeatAt: new Date(Date.now() - 91_000), protocolVersion: 9, players: 16, maxPlayers: 16 });
    await expectDeny(await freshTicket(entitled.token, joinBody(staleFull.id)), "server_offline");
    await expectDeny(await freshTicket(entitled.token, joinBody(ok.id, { protocol_version: 4 })), "build_mismatch");
    await expectDeny(await freshTicket(entitled.token, joinBody(ok.id, { build_family: "other" })), "build_mismatch");
    await expectDeny(await freshTicket(entitled.token, joinBody(linuxOnly.id)), "build_mismatch");
    await expectDeny(await freshTicket(entitled.token, joinBody(full.id, { protocol_version: 4 })), "build_mismatch");
    await expectDeny(await freshTicket(entitled.token, joinBody(full.id)), "server_full");
    expect((await freshTicket(entitled.token, joinBody(linuxOnly.id, { client_platform: "linux-x64" }))).status).toBe(200);
    expect(await prisma.joinTicket.count({ where: { serverId: { in: [disabled.id, stale.id, never.id, full.id, worst.id, staleFull.id] } } })).toBe(0);
  });

  it("400s malformed bodies", async () => {
    const { id } = await makeServer();
    const bad = [
      { nonce: "n".repeat(15) }, { nonce: "n".repeat(129) }, { nonce: `${"n".repeat(16)}!` }, { protocol_version: 0 }, { protocol_version: 1_000_001 },
      { protocol_version: "3" }, { client_platform: "linux" }, { build_family: "" }, { build_family: "f".repeat(65) }, { game_build: "g".repeat(129) },
      { serverId: "a/b" }, { serverId: "s".repeat(129) }, { serverId: undefined },
    ];
    for (const patch of bad) await expectError(await freshTicket(entitled.token, joinBody(id, patch)), 400, "invalid_request");
    for (const raw of ["{nope", "[]", "null", " ".repeat(8193)]) await expectError(await freshTicket(entitled.token, null, raw), 400, "invalid_request");
    const noCt = new NextRequest(new URL("/api/launcher/join-ticket", BASE), { method: "POST", headers: { authorization: `Bearer ${entitled.token}` }, body: JSON.stringify(joinBody(id)) });
    await expectError(await join.POST(noCt), 400, "invalid_request");
    expect(await prisma.joinTicket.count({ where: { serverId: id } })).toBe(0);
  });

  it("rate limits 10/min/account with a positive delta-seconds Retry-After", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      const u = await makeUser();
      const { id } = await makeServer();
      for (let i = 0; i < LAUNCHER_LIMITS.join.account; i++) expect((await ticket(u.token, joinBody(id))).status).toBe(200);
      const limited = await ticket(u.token, joinBody(id));
      await expectError(limited, 429, "rate_limited");
      expect(limited.headers.get("retry-after")).toMatch(/^[1-9][0-9]*$/);
      expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(60);
      expect(await prisma.joinTicket.count({ where: { userId: u.id } })).toBe(10);
      expect((await list(u.token)).status).toBe(200);
      expect((await ticket(entitled.token, joinBody(id))).status).toBe(200);
      const ws = windowStart(Date.now(), LAUNCHER_LIMITS.join.windowMs);
      expect((await prisma.rateLimit.findUniqueOrThrow({ where: { key: launcherJoinAccountKey(u.id) } })).windowStart).toEqual(ws);
    } finally {
      clock.mockRestore();
    }
  });

  it("serializes with a concurrent disable: a disable committed mid-flight wins", async () => {
    const { id } = await makeServer();
    let pending: Promise<Response> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "OfficialServer" WHERE "id" = ${id} FOR UPDATE`;
      pending = ticket(entitled.token, joinBody(id));
      await new Promise((r) => setTimeout(r, 300));
      await tx.officialServer.update({ where: { id }, data: { status: "DISABLED" } });
    });
    await expectDeny(await pending!, "server_not_found");
    expect(await prisma.joinTicket.count({ where: { serverId: id } })).toBe(0);
  });

  it("serializes with a concurrent compat change and key revoke", async () => {
    const { id } = await makeServer();
    let pending: Promise<Response> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "OfficialServer" WHERE "id" = ${id} FOR UPDATE`;
      pending = ticket(entitled.token, joinBody(id));
      await new Promise((r) => setTimeout(r, 300));
      await tx.officialServer.update({ where: { id }, data: { protocolVersion: 4 } });
    });
    await expectDeny(await pending!, "build_mismatch");

    const u = await makeUser();
    const s2 = await makeServer();
    const red = await prisma.redemption.findFirstOrThrow({ where: { userId: u.id } });
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "AccessKey" WHERE "id" = ${red.keyId} FOR UPDATE`;
      pending = ticket(u.token, joinBody(s2.id));
      await new Promise((r) => setTimeout(r, 300));
      await tx.accessKey.update({ where: { id: red.keyId }, data: { status: "REVOKED", revokedAt: new Date() } });
    });
    await expectDeny(await pending!, "no_key");

    const v = await makeUser();
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "NativeSession" WHERE "id" = ${v.sessionId} FOR UPDATE`;
      pending = ticket(v.token, joinBody(s2.id));
      await new Promise((r) => setTimeout(r, 300));
      await tx.nativeSession.update({ where: { id: v.sessionId }, data: { revokedAt: new Date() } });
    });
    await expectError(await pending!, 401, "session_revoked");
    expect(await prisma.joinTicket.count({ where: { serverId: { in: [id, s2.id] } } })).toBe(0);
  });

  it("keeps entitlement when one racing key is revoked but another remains active", async () => {
    const u = await makeUser();
    const s = await makeServer();
    const first = await prisma.redemption.findFirstOrThrow({ where: { userId: u.id } });
    await prisma.accessKey.create({
      data: {
        id: `z${run}second`, codeHash: sha256(`${batch}-second`), codePrefix: "TEST", tier: "ALPHA",
        status: "REDEEMED", batchLabel: batch, redemption: { create: { userId: u.id } },
      },
    });
    let pending: Promise<Response> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "AccessKey" WHERE "id" = ${first.keyId} FOR UPDATE`;
      pending = ticket(u.token, joinBody(s.id));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await tx.accessKey.update({ where: { id: first.keyId }, data: { status: "REVOKED", revokedAt: new Date() } });
    });
    const res = await pending!;
    expect(res.status).toBe(200);
    expect((await res.json()).ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await prisma.joinTicket.count({ where: { userId: u.id, serverId: s.id } })).toBe(1);
  });

  it("rolls back the ticket when the audit write fails", async () => {
    const { id } = await makeServer();
    const real = prisma.$transaction.bind(prisma) as (fn: (tx: object) => Promise<unknown>, opts?: unknown) => Promise<unknown>;
    // Run the real transaction but make the audit insert inside it fail.
    const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce(((fn: (tx: object) => Promise<unknown>, opts?: unknown) =>
      real((tx) => fn(new Proxy(tx, {
        get: (t, p) => (p === "auditLog" ? { create: () => Promise.reject(new Error("audit down")) } : Reflect.get(t, p)),
      })), opts)) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expectError(await ticket(entitled.token, joinBody(id)), 500, "server_error");
    err.mockRestore();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(await prisma.joinTicket.count({ where: { serverId: id } })).toBe(0);
  });

  it("405s unsupported methods with JSON", async () => {
    for (const m of [join.GET, join.PUT, join.DELETE, directory.POST, directory.PATCH, directory.OPTIONS]) {
      await expectError(m(), 405, "method_not_allowed");
    }
  });
});
