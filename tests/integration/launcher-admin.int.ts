// In-game admin routes (create server, set capacity), the role claim and the heartbeat capacity, through the real handlers.
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

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
const { LAUNCHER_LIMITS, launcherAdminAccountKey, launcherDirectoryAccountKey, launcherJoinAccountKey, launcherPlayAccountKey, launcherPlayIpKey } =
  await import("@/lib/rate-limit");
const create = await import("@/app/api/launcher/admin/servers/route");
const capacity = await import("@/app/api/launcher/admin/servers/[id]/route");
const heartbeat = await import("@/app/api/servers/heartbeat/route");
const directory = await import("@/app/api/launcher/servers/route");
const join = await import("@/app/api/launcher/join-ticket/route");
const playCheck = await import("@/app/api/launcher/play-check/route");
const { proxy } = await import("@/proxy");

const BASE = process.env.AUTH_URL!;
const run = randomBytes(4).toString("hex");
const family = `adm-${run}`;
const batch = `launcher-admin-${run}`;
const IP = "14.0.0.1";
const emails: string[] = [];
const userIds: string[] = [];
const serverIds: string[] = [];
const ORIGINAL_ADMIN_EMAILS = process.env.ADMIN_EMAILS;

type User = { id: string; email: string; token: string; sessionId: string };

async function makeUser(opts: { role?: "ADMIN" | "PLAYER"; verified?: boolean; key?: boolean } = {}): Promise<User> {
  const email = `la-${run}-${emails.length}@example.test`;
  emails.push(email);
  const user = await prisma.user.create({
    data: { email, passwordHash: "x", role: opts.role ?? "PLAYER", emailVerifiedAt: opts.verified === false ? null : new Date() },
  });
  userIds.push(user.id);
  if (opts.key !== false) {
    await prisma.accessKey.create({
      data: { codeHash: sha256(`${batch}-${email}`), codePrefix: "TEST", tier: "BETA", status: "REDEEMED", batchLabel: batch, redemption: { create: { userId: user.id } } },
    });
  }
  const now = Date.now();
  const s = await prisma.nativeSession.create({
    data: { userId: user.id, clientId: "twaz-launcher", lastUsedAt: new Date(now), idleExpiresAt: new Date(now + 3600e3), absoluteExpiresAt: new Date(now + 7200e3) },
  });
  return { id: user.id, email, sessionId: s.id, token: signAccessToken({ sub: user.id, sid: s.id, pwdAt: 0 }) };
}

function call(method: string, path: string, token: string | null, body?: unknown, raw?: string) {
  const h = new Headers({ "x-real-ip": IP });
  if (token) h.set("authorization", `Bearer ${token}`);
  if (body !== undefined || raw !== undefined) h.set("content-type", "application/json");
  return new NextRequest(new URL(path, BASE), { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const postCreate = (token: string | null, body?: unknown, raw?: string) => create.POST(call("POST", "/api/launcher/admin/servers", token, body, raw));
const patchCap = (token: string | null, id: string, body?: unknown, raw?: string) =>
  capacity.PATCH(call("PATCH", `/api/launcher/admin/servers/${id}`, token, body, raw), params(id));

const input = (extra: Record<string, unknown> = {}) => ({ name: `ingame ${run} ${serverIds.length}`, region: "eu", host: "192.168.4.34", port: 7777, maxPlayers: 16, ...extra });

async function expectError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ error });
}

const nonce = () => randomBytes(16).toString("hex");
const beat = (n: string, extra: Record<string, unknown> = {}) => ({
  game_build: "0.61-df4d111", build_family: family, protocol_version: 3, server_runtime: "linux-x64", instance_nonce: n, players: 0, maxPlayers: 8, ...extra,
});
const hb = (id: string, secret: string, body: unknown) => {
  const h = new Headers({ authorization: `TwazServer ${id}.${secret}`, "content-type": "application/json" });
  return heartbeat.POST(new NextRequest(new URL("/api/servers/heartbeat", BASE), { method: "POST", headers: h, body: JSON.stringify(body) }));
};
/** Stands in for the operator's web "Generate secret" (rotate) step, which the in-game route never does. */
async function provision(id: string) {
  const secret = randomBytes(32).toString("base64url");
  await prisma.officialServer.update({ where: { id }, data: { secretHash: sha256(secret), secretRotatedAt: new Date() } });
  return secret;
}

const resetLimits = () => prisma.rateLimit.deleteMany({
  where: {
    key: {
      in: [
        ...userIds.flatMap((id) => [launcherAdminAccountKey(id), launcherDirectoryAccountKey(id), launcherJoinAccountKey(id), launcherPlayAccountKey(id)]),
        ...serverIds.map(heartbeatKey), launcherPlayIpKey(IP),
      ],
    },
  },
});

let nick: User;
let player: User;
beforeEach(async () => {
  nick ??= await makeUser({ role: "ADMIN" });
  player ??= await makeUser();
  process.env.ADMIN_EMAILS = `someone@example.test, ${nick.email.toUpperCase()}`;
  await resetLimits();
});

afterAll(async () => {
  process.env.ADMIN_EMAILS = ORIGINAL_ADMIN_EMAILS;
  await prisma.joinTicket.deleteMany({ where: { serverId: { in: serverIds } } });
  await prisma.officialServer.deleteMany({ where: { id: { in: serverIds } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { targetId: { in: serverIds } }] } });
  await resetLimits();
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.accessKey.deleteMany({ where: { batchLabel: batch } });
  await prisma.$disconnect();
});

async function createOk(extra: Record<string, unknown> = {}) {
  const res = await postCreate(nick.token, input(extra));
  expect(res.status).toBe(201);
  const body = await res.json();
  serverIds.push(body.serverId);
  return body as { serverId: string; name: string; region: string; host: string; port: number; maxPlayers: number; status: string };
}

describe("role claim", () => {
  it("is admin only for a verified ADMIN listed in ADMIN_EMAILS, on play-check and the directory", async () => {
    const roleOf = async (u: User) => {
      const res = await playCheck.POST(call("POST", "/api/launcher/play-check", u.token, { nonce: "0123456789abcdef", game_build: "x", platform: "win-x64" }));
      expect(res.status).toBe(200);
      return (await res.json()).role;
    };
    expect(await roleOf(nick)).toBe("admin");
    expect(await roleOf(player)).toBe("player");

    // Fail closed: allowlist unset, empty or not listing the account; DB role PLAYER while listed; unverified admin.
    for (const env of [undefined, "", " , ", "other@example.test"]) {
      if (env === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = env;
      expect(await roleOf(nick)).toBe("player");
    }
    process.env.ADMIN_EMAILS = `${nick.email},${player.email}`;
    expect(await roleOf(player)).toBe("player");
    const unverified = await makeUser({ role: "ADMIN", verified: false });
    process.env.ADMIN_EMAILS = unverified.email;
    expect(await roleOf(unverified)).toBe("player");
  });

  it("marks directory rows canManage only for the admin", async () => {
    const created = await createOk();
    const secret = await provision(created.serverId);
    expect((await hb(created.serverId, secret, beat(nonce()))).status).toBe(200);
    const q = new URLSearchParams({ build_family: family, protocol_version: "3", client_platform: "win-x64", game_build: "0.61-df4d111" });
    const list = async (u: User) => (await directory.GET(call("GET", `/api/launcher/servers?${q}`, u.token))).json();
    const asNick = await list(nick);
    expect(asNick.role).toBe("admin");
    expect(asNick.servers.find((s: { id: string }) => s.id === created.serverId)).toMatchObject({ canManage: true, maxPlayers: 8 });
    const asPlayer = await list(player);
    expect(asPlayer.role).toBe("player");
    expect(asPlayer.servers.every((s: { canManage: boolean }) => s.canManage === false)).toBe(true);
  });
});

describe("POST /api/launcher/admin/servers", () => {
  it("401s without a live bearer and ignores cookies", async () => {
    await expectError(await postCreate(null, input()), 401, "invalid_token");
    await expectError(await postCreate("not.a.token", input()), 401, "invalid_token");
    const cookieOnly = new NextRequest(new URL("/api/launcher/admin/servers", BASE), {
      method: "POST", headers: { cookie: "authjs.session-token=x", "content-type": "application/json" }, body: JSON.stringify(input()),
    });
    await expectError(await create.POST(cookieOnly), 401, "invalid_token");
    const revoked = await makeUser({ role: "ADMIN" });
    process.env.ADMIN_EMAILS = revoked.email;
    await prisma.nativeSession.update({ where: { id: revoked.sessionId }, data: { revokedAt: new Date() } });
    await expectError(await postCreate(revoked.token, input()), 401, "session_revoked");
  });

  it("403s every non-admin before reading the body, and creates nothing", async () => {
    const before = await prisma.officialServer.count();
    await expectError(await postCreate(player.token, input()), 403, "forbidden");
    await expectError(await postCreate(player.token, undefined, "{not json"), 403, "forbidden");
    process.env.ADMIN_EMAILS = "";
    await expectError(await postCreate(nick.token, input()), 403, "forbidden");
    expect(await prisma.officialServer.count()).toBe(before);
  });

  it("creates a pending row with no credential, returns no secret, and audits it", async () => {
    const res = await postCreate(nick.token, input({ name: `EU host ${run}`, maxPlayers: 24 }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const body = JSON.parse(text);
    serverIds.push(body.serverId);
    expect(Object.keys(body).sort()).toEqual(["host", "maxPlayers", "name", "port", "region", "serverId", "status"]);
    expect(body).toMatchObject({ name: `EU host ${run}`, region: "eu", host: "192.168.4.34", port: 7777, maxPlayers: 24, status: "pending" });
    expect(body.serverId).toMatch(/^[a-z0-9]{1,64}$/);
    expect(text).not.toMatch(/secret/i);

    const row = await prisma.officialServer.findUniqueOrThrow({ where: { id: body.serverId } });
    expect(row).toMatchObject({
      secretHash: null, secretRotatedAt: null, adminMaxPlayers: 24, maxPlayers: 0, status: "ACTIVE", createdById: nick.id,
      buildFamily: "pending", protocolVersion: 1, gameBuild: "pending", clientPlatforms: ["win-x64", "linux-x64"], lastHeartbeatAt: null,
    });
    const audit = await prisma.auditLog.findMany({ where: { targetId: body.serverId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: nick.id, action: "SERVER_CREATED" });
    expect(audit[0].meta).toEqual({ name: `EU host ${run}`, region: "eu", host: "192.168.4.34", port: 7777, maxPlayers: 24, source: "launcher" });

    // Without a credential nothing can heartbeat as it, even with a well-formed guess.
    await expectError(await hb(body.serverId, randomBytes(32).toString("base64url"), beat(nonce())), 401, "invalid_server");
    // After the operator provisions a secret, the first heartbeat adopts the real family and gets the capacity back.
    const secret = await provision(body.serverId);
    const ok = await hb(body.serverId, secret, beat(nonce()));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, maxPlayers: 24 });
    expect(await prisma.officialServer.findUniqueOrThrow({ where: { id: body.serverId } })).toMatchObject({ buildFamily: family, protocolVersion: 3, maxPlayers: 8 });
  });

  it("422s invalid fields (and unknown ones), 400s an unreadable body", async () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ maxPlayers: 0 }, "maxPlayers"], [{ maxPlayers: 65 }, "maxPlayers"], [{ maxPlayers: 1.5 }, "maxPlayers"], [{ maxPlayers: "8" }, "maxPlayers"],
      [{ name: "" }, "name"], [{ name: "bad<name>" }, "name"], [{ region: "x".repeat(33) }, "region"], [{ host: "bad host" }, "host"],
      [{ port: 0 }, "port"], [{ port: 65536 }, "port"], [{ secretHash: "x" }, "body"], [{ buildFamily: "x" }, "body"],
    ];
    for (const [extra, field] of bad) {
      await resetLimits();
      const res = await postCreate(nick.token, input(extra));
      expect(res.status, JSON.stringify(extra)).toBe(422);
      expect(await res.json()).toEqual({ error: "validation_failed", fields: [field] });
    }
    await resetLimits();
    const noCap: Record<string, unknown> = input();
    delete noCap.maxPlayers;
    expect((await postCreate(nick.token, noCap)).status).toBe(422);
    await expectError(await postCreate(nick.token, undefined, "{not json"), 400, "invalid_request");
    await expectError(await postCreate(nick.token, undefined, JSON.stringify({ ...input(), name: "x".repeat(5000) })), 400, "invalid_request");
  });

  it("accepts 1 and 64 as maxPlayers bounds", async () => {
    expect((await createOk({ maxPlayers: 1 })).maxPlayers).toBe(1);
    expect((await createOk({ maxPlayers: 64 })).maxPlayers).toBe(64);
  });

  it("rate limits per account with Retry-After, also for non-admins", async () => {
    for (const u of [nick, player]) {
      for (let i = 0; i < LAUNCHER_LIMITS.admin.account; i++) await postCreate(u.token, undefined, "{bad");
      const res = await postCreate(u.token, input());
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    }
  });

  it("405s other methods", async () => {
    for (const m of [create.GET, create.PUT, create.PATCH, create.DELETE]) expect((await m()).status).toBe(405);
  });
});

describe("PATCH /api/launcher/admin/servers/{id}", () => {
  it("sets capacity, audits old/new, and the next heartbeat returns it", async () => {
    const s = await createOk({ maxPlayers: 16 });
    const secret = await provision(s.serverId);
    const n = nonce();
    expect(await (await hb(s.serverId, secret, beat(n))).json()).toMatchObject({ maxPlayers: 16 });

    const res = await patchCap(nick.token, s.serverId, { maxPlayers: 32 });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ serverId: s.serverId, maxPlayers: 32 });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { targetId: s.serverId, action: "SERVER_CAPACITY_CHANGED" } });
    expect(audit).toMatchObject({ actorId: nick.id, meta: { oldMaxPlayers: 16, newMaxPlayers: 32, source: "launcher" } });

    // Same process keeps beating: no 409, gets the new cap; a reported cap of 32 is recorded but not authoritative.
    const again = await hb(s.serverId, secret, beat(n, { maxPlayers: 32 }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, maxPlayers: 32 });
    expect(await prisma.officialServer.findUniqueOrThrow({ where: { id: s.serverId } })).toMatchObject({ adminMaxPlayers: 32, maxPlayers: 32 });
  });

  it("enforces the role, the id, the bounds and the body", async () => {
    const s = await createOk();
    await expectError(await patchCap(null, s.serverId, { maxPlayers: 8 }), 401, "invalid_token");
    await expectError(await patchCap(player.token, s.serverId, { maxPlayers: 8 }), 403, "forbidden");
    await expectError(await patchCap(nick.token, "NOT-AN-ID", { maxPlayers: 8 }), 404, "not_found");
    await expectError(await patchCap(nick.token, "nosuchserver", { maxPlayers: 8 }), 404, "not_found");
    for (const bad of [{ maxPlayers: 0 }, { maxPlayers: 65 }, { maxPlayers: null }, {}, { maxPlayers: 8, name: "x" }]) {
      const res = await patchCap(nick.token, s.serverId, bad);
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "validation_failed", fields: ["maxPlayers"] });
    }
    await expectError(await patchCap(nick.token, s.serverId, undefined, "nope"), 400, "invalid_request");
    expect((await prisma.officialServer.findUniqueOrThrow({ where: { id: s.serverId } })).adminMaxPlayers).toBe(16);
    expect(await prisma.auditLog.count({ where: { targetId: s.serverId, action: "SERVER_CAPACITY_CHANGED" } })).toBe(0);
  });

  it("join-ticket treats the lower of admin and reported caps as full", async () => {
    const s = await createOk({ maxPlayers: 4 });
    const secret = await provision(s.serverId);
    const n = nonce();
    const joinBody = { serverId: s.serverId, nonce: randomBytes(16).toString("base64url"), build_family: family, protocol_version: 3, client_platform: "win-x64", game_build: "0.61" };
    const ticket = async () => (await join.POST(call("POST", "/api/launcher/join-ticket", player.token, joinBody))).json();
    expect((await hb(s.serverId, secret, beat(n, { players: 4, maxPlayers: 8 }))).status).toBe(200);
    expect(await ticket()).toEqual({ entitled: false, reason: "server_full" });
    await patchCap(nick.token, s.serverId, { maxPlayers: 6 });
    expect((await ticket()).ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await resetLimits();
    expect((await hb(s.serverId, secret, beat(n, { players: 4, maxPlayers: 4 }))).status).toBe(200);
    expect(await ticket()).toEqual({ entitled: false, reason: "server_full" });
  });
});

describe("proxy", () => {
  it("lets bearer-only admin routes through without a browser Origin, but not the cookie admin routes", async () => {
    const r = (path: string) => proxy(new NextRequest(new URL(path, BASE), { method: "POST" }));
    expect(r("/api/launcher/admin/servers").status).toBe(200);
    expect(r("/api/launcher/admin/servers/abc123").status).toBe(200);
    expect(r("/api/launcher/admin/servers/abc123/x").status).toBe(403);
    expect(r("/api/launcher/admin/other").status).toBe(403);
    expect(r("/api/admin/servers").status).toBe(403);
    expect(r("/api/admin/servers/abc123/capacity").status).toBe(403);
  });
});
