// Official-server admin + heartbeat through the real route handlers against the Postgres at DATABASE_URL.
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.AUTH_URL ??= "http://localhost:3000";
process.env.AUTH_SECRET ??= randomBytes(32).toString("hex");
process.env.AUTH_TRUST_HOST ??= "true";

let ambient = new Headers();
vi.mock("next/headers", () => ({ headers: async () => ambient }));
// Client forms call useRouter, which needs a mounted app router; redirect() stays real.
vi.mock("next/navigation", async (orig) => ({ ...(await orig<typeof import("next/navigation")>()), useRouter: () => ({ refresh() {} }) }));

const { prisma } = await import("@/lib/db");
const { sha256 } = await import("@/lib/crypto");
const { heartbeatKey } = await import("@/lib/servers");
const authRoute = await import("@/app/api/auth/[...nextauth]/route");
const create = await import("@/app/api/admin/servers/route");
const rotate = await import("@/app/api/admin/servers/[id]/rotate/route");
const disable = await import("@/app/api/admin/servers/[id]/disable/route");
const compat = await import("@/app/api/admin/servers/[id]/compat/route");
const endpoint = await import("@/app/api/admin/servers/[id]/endpoint/route");
const capacityRoute = await import("@/app/api/admin/servers/[id]/capacity/route");
const heartbeat = await import("@/app/api/servers/heartbeat/route");
const AdminServersPage = (await import("@/app/admin/servers/page")).default;

const BASE = process.env.AUTH_URL!;
const run = randomBytes(4).toString("hex");
const ip = `12.${randomBytes(3).join(".")}`;
const admin = { email: `srv-admin-${run}@example.test`, password: "admin password 123" };
const player = { email: `srv-player-${run}@example.test`, password: "player password 123" };
const serverInput = {
  name: `ci ${run}`, region: "eu", host: "play.example.org", port: 7777,
  gameBuild: "0.59.1", buildFamily: "playtest-0.59", protocolVersion: 3, clientPlatforms: ["win-x64", "linux-x64"],
};

type Jar = Map<string, string>;
const cookieHeader = (jar: Jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
function absorb(jar: Jar, res: Response) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
}

function req(urlPath: string, init: { jar?: Jar; body?: BodyInit; json?: unknown; auth?: string; raw?: string } = {}) {
  const h = new Headers({ "x-real-ip": ip, origin: new URL(BASE).origin });
  if (init.jar) h.set("cookie", cookieHeader(init.jar));
  if (init.auth) h.set("authorization", init.auth);
  let body = init.body;
  if (init.json !== undefined || init.raw !== undefined) {
    h.set("content-type", "application/json");
    body = init.raw ?? JSON.stringify(init.json);
  }
  ambient = h;
  return new NextRequest(new URL(urlPath, BASE), { method: body !== undefined || init.auth ? "POST" : "GET", headers: h, body });
}

async function login(email: string, password: string): Promise<Jar> {
  const jar: Jar = new Map();
  const csrfRes = await authRoute.GET(req("/api/auth/csrf", { jar }));
  absorb(jar, csrfRes);
  const { csrfToken } = await csrfRes.json();
  absorb(jar, await authRoute.POST(req("/api/auth/callback/credentials", { jar, body: new URLSearchParams({ csrfToken, email, password, callbackUrl: `${BASE}/account` }) })));
  if (![...jar.keys()].some((k) => k.endsWith("authjs.session-token"))) throw new Error("login failed");
  return jar;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const nonce = () => randomBytes(16).toString("hex");
const beat = (n: string, extra: Record<string, unknown> = {}) => ({
  game_build: "0.59.1-linux", build_family: "playtest-0.59", protocol_version: 3, server_runtime: "linux-x64",
  instance_nonce: n, players: 1, maxPlayers: 16, ...extra,
});
const hb = (id: string, secret: string, body: unknown) => heartbeat.POST(req("/api/servers/heartbeat", { auth: `TwazServer ${id}.${secret}`, json: body }));
const resetLimit = (id: string) => prisma.rateLimit.deleteMany({ where: { key: heartbeatKey(id) } });

async function expectError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("location")).toBeNull();
  expect(await res.json()).toEqual({ error });
}

let adminJar: Jar;
let playerJar: Jar;
let adminId = "";
const serverIds: string[] = [];

async function createServer(extra: Record<string, unknown> = {}) {
  const res = await create.POST(req("/api/admin/servers", { jar: adminJar, json: { ...serverInput, ...extra } }));
  expect(res.status).toBe(200);
  const body = await res.json();
  serverIds.push(body.id);
  return body as { id: string; secret: string };
}

beforeAll(async () => {
  for (const [u, role] of [[admin, "ADMIN"], [player, "PLAYER"]] as const) {
    const user = await prisma.user.create({
      data: { email: u.email, role, emailVerifiedAt: new Date(), passwordHash: await argon2.hash(u.password, { type: argon2.argon2id }) },
    });
    if (role === "ADMIN") adminId = user.id;
  }
  adminJar = await login(admin.email, admin.password);
  playerJar = await login(player.email, player.password);
});

afterAll(async () => {
  await prisma.officialServer.deleteMany({ where: { id: { in: serverIds } } });
  await prisma.rateLimit.deleteMany({ where: { key: { in: serverIds.map(heartbeatKey) } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: adminId }, { targetId: { in: serverIds } }] } });
  await prisma.user.deleteMany({ where: { email: { in: [admin.email, player.email] } } });
  await prisma.$disconnect();
});

describe("admin server management", () => {
  it("refuses anonymous and non-admin callers on every admin route and the page", async () => {
    const fakeId = "doesnotexist";
    for (const jar of [undefined, playerJar]) {
      expect((await create.POST(req("/api/admin/servers", { jar, json: serverInput }))).status).toBe(403);
      expect((await rotate.POST(req(`/api/admin/servers/${fakeId}/rotate`, { jar, json: {} }), params(fakeId))).status).toBe(403);
      expect((await disable.POST(req(`/api/admin/servers/${fakeId}/disable`, { jar, json: {} }), params(fakeId))).status).toBe(403);
      expect((await compat.POST(req(`/api/admin/servers/${fakeId}/compat`, { jar, json: {} }), params(fakeId))).status).toBe(403);
      expect((await endpoint.POST(req(`/api/admin/servers/${fakeId}/endpoint`, { jar, json: {} }), params(fakeId))).status).toBe(403);
      expect((await capacityRoute.POST(req(`/api/admin/servers/${fakeId}/capacity`, { jar, json: { maxPlayers: 8 } }), params(fakeId))).status).toBe(403);
    }
    req("/admin/servers");
    await expect(AdminServersPage()).rejects.toMatchObject({ digest: expect.stringContaining("/login") });
    req("/admin/servers", { jar: playerJar });
    await expect(AdminServersPage()).rejects.toMatchObject({ digest: expect.stringContaining("/account") });
    expect(await prisma.officialServer.count({ where: { name: serverInput.name } })).toBe(0);
  });

  it("rejects invalid input without creating anything", async () => {
    for (const bad of [{ port: 70000 }, { host: "x.org/evil" }, { clientPlatforms: ["osx"] }, { protocolVersion: "3" }, { name: "" }, { maxPlayers: 0 }, { maxPlayers: 65 }]) {
      expect((await create.POST(req("/api/admin/servers", { jar: adminJar, json: { ...serverInput, ...bad } }))).status).toBe(400);
    }
    expect((await create.POST(req("/api/admin/servers", { jar: adminJar, raw: "{not json" }))).status).toBe(400);
    expect(await prisma.officialServer.count({ where: { name: serverInput.name } })).toBe(0);
  });

  it("creates a server, shows the secret once and stores only its sha256", async () => {
    const log = vi.spyOn(console, "log");
    const err = vi.spyOn(console, "error");
    const { id, secret } = await createServer();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
    const row = await prisma.officialServer.findUniqueOrThrow({ where: { id } });
    expect(row.secretHash).toBe(sha256(secret));
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row).toMatchObject({ status: "ACTIVE", host: "play.example.org", port: 7777, createdById: adminId, clientPlatforms: ["win-x64", "linux-x64"], adminMaxPlayers: 64, maxPlayers: 0 });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "SERVER_CREATED", targetId: id } });
    expect(audit.meta).toEqual({ name: serverInput.name, maxPlayers: 64, source: "web" });
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect([...log.mock.calls, ...err.mock.calls].flat().join(" ")).not.toContain(secret);
    log.mockRestore();
    err.mockRestore();

    // The list page never renders the secret or its hash.
    req("/admin/servers", { jar: adminJar });
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(await AdminServersPage());
    expect(html).toContain(serverInput.name);
    expect(html).not.toContain(secret);
    expect(html).not.toContain(row.secretHash);
    expect(html).toContain("capacity 64 players");
  });

  it("creates with a chosen capacity, edits it with an audit, and shows a credential-less server as needing a secret", async () => {
    const { id, secret } = await createServer({ maxPlayers: 12 });
    expect((await prisma.officialServer.findUniqueOrThrow({ where: { id } })).adminMaxPlayers).toBe(12);
    const set = (body: unknown, sid = id) => capacityRoute.POST(req(`/api/admin/servers/${sid}/capacity`, { jar: adminJar, json: body }), params(sid));
    for (const bad of [{ maxPlayers: 0 }, { maxPlayers: 65 }, { maxPlayers: "8" }, {}, { maxPlayers: 8, extra: 1 }]) expect((await set(bad)).status).toBe(400);
    expect((await set({ maxPlayers: 8 }, "nosuch")).status).toBe(404);
    const res = await set({ maxPlayers: 40 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, maxPlayers: 40 });
    const audits = await prisma.auditLog.findMany({ where: { action: "SERVER_CAPACITY_CHANGED", targetId: id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: adminId, meta: { oldMaxPlayers: 12, newMaxPlayers: 40, source: "web" } });
    const beatRes = await hb(id, secret, beat(nonce()));
    expect(await beatRes.json()).toMatchObject({ ok: true, maxPlayers: 40 });

    // A server created in game has no credential: the page says so and offers "Generate secret"; rotate provisions it once.
    const pending = await prisma.officialServer.create({
      data: { ...serverInput, name: `${serverInput.name} pending`, secretHash: null, secretRotatedAt: null, adminMaxPlayers: 20 },
    });
    serverIds.push(pending.id);
    req("/admin/servers", { jar: adminJar });
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(await AdminServersPage());
    expect(html).toContain("no secret yet");
    expect(html).toContain("Generate secret");
    expect(html).toContain("capacity 20 players");
    const rot = await rotate.POST(req(`/api/admin/servers/${pending.id}/rotate`, { jar: adminJar, json: {} }), params(pending.id));
    expect(rot.status).toBe(200);
    const fresh = (await rot.json()).secret as string;
    expect((await prisma.officialServer.findUniqueOrThrow({ where: { id: pending.id } })).secretHash).toBe(sha256(fresh));
    expect(await (await hb(pending.id, fresh, beat(nonce()))).json()).toMatchObject({ ok: true, maxPlayers: 20 });
  });

  it("updates compatibility values and audits it", async () => {
    const { id } = await createServer();
    const res = await compat.POST(req(`/api/admin/servers/${id}/compat`, { jar: adminJar, json: { gameBuild: "0.60.0", buildFamily: "playtest-0.60", protocolVersion: 4, clientPlatforms: ["win-x64"] } }), params(id));
    expect(res.status).toBe(200);
    expect(await prisma.officialServer.findUniqueOrThrow({ where: { id } })).toMatchObject({ buildFamily: "playtest-0.60", protocolVersion: 4, clientPlatforms: ["win-x64"] });
    expect(await prisma.auditLog.count({ where: { action: "SERVER_COMPAT_UPDATED", targetId: id } })).toBe(1);
    expect((await compat.POST(req(`/api/admin/servers/${id}/compat`, { jar: adminJar, json: { buildFamily: "x" } }), params(id))).status).toBe(400);
    expect((await compat.POST(req("/api/admin/servers/nosuch/compat", { jar: adminJar, json: { gameBuild: "1", buildFamily: "f", protocolVersion: 1, clientPlatforms: ["win-x64"] } }), params("nosuch"))).status).toBe(404);
  });

  it("updates host and port, audits it, and expires unused tickets without ending sessions or rotating the secret", async () => {
    const { id, secret } = await createServer();
    const before = await prisma.officialServer.findUniqueOrThrow({ where: { id } });
    const ns = await prisma.nativeSession.create({
      data: {
        userId: adminId, clientId: `endpoint-${run}`,
        absoluteExpiresAt: new Date(Date.now() + 60_000), lastUsedAt: new Date(), idleExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const liveTicket = await prisma.joinTicket.create({
      data: {
        ticketHash: sha256(`live-${run}`), userId: adminId, nativeSessionId: ns.id, serverId: id,
        gameBuild: "0.59.1", buildFamily: "playtest-0.59", protocolVersion: 3, clientPlatform: "win-x64",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const usedTicket = await prisma.joinTicket.create({
      data: {
        ticketHash: sha256(`used-${run}`), userId: adminId, nativeSessionId: ns.id, serverId: id,
        gameBuild: "0.59.1", buildFamily: "playtest-0.59", protocolVersion: 3, clientPlatform: "win-x64",
        expiresAt: new Date(Date.now() + 60_000), usedAt: new Date(),
      },
    });
    const session = await prisma.serverSession.create({
      data: { serverId: id, userId: adminId, ticketId: usedTicket.id, instanceNonce: "n".repeat(16), connectionId: "1" },
    });

    const res = await endpoint.POST(req(`/api/admin/servers/${id}/endpoint`, { jar: adminJar, json: { host: "192.168.4.34", port: 7778 } }), params(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = await prisma.officialServer.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ host: "192.168.4.34", port: 7778, secretHash: before.secretHash });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "SERVER_ENDPOINT_CHANGED", targetId: id } });
    expect(audit.meta).toEqual({ oldHost: "play.example.org", oldPort: 7777, newHost: "192.168.4.34", newPort: 7778 });
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect((await prisma.joinTicket.findUniqueOrThrow({ where: { id: liveTicket.id } })).expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await prisma.joinTicket.findUniqueOrThrow({ where: { id: usedTicket.id } })).toMatchObject({ usedAt: expect.any(Date) });
    expect((await prisma.joinTicket.findUniqueOrThrow({ where: { id: usedTicket.id } })).expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await prisma.serverSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ endedAt: null, endReason: null });

    expect((await endpoint.POST(req(`/api/admin/servers/${id}/endpoint`, { jar: adminJar, json: { host: "x.org/evil", port: 7777 } }), params(id))).status).toBe(400);
    expect((await endpoint.POST(req(`/api/admin/servers/${id}/endpoint`, { jar: adminJar, json: { host: "play.example.org", port: 70000 } }), params(id))).status).toBe(400);
    expect((await endpoint.POST(req("/api/admin/servers/nosuch/endpoint", { jar: adminJar, json: { host: "play.example.org", port: 7777 } }), params("nosuch"))).status).toBe(404);
    expect((await prisma.officialServer.findUniqueOrThrow({ where: { id } })).host).toBe("192.168.4.34");

    await prisma.serverSession.delete({ where: { id: session.id } });
    await prisma.joinTicket.deleteMany({ where: { id: { in: [liveTicket.id, usedTicket.id] } } });
    await prisma.nativeSession.delete({ where: { id: ns.id } });
  });
});

describe("heartbeat", () => {
  it("accepts a good credential and records state", async () => {
    const { id, secret } = await createServer();
    const n = nonce();
    const res = await hb(id, secret, beat(n));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({ ok: true, checkedAt: body.checkedAt, maxPlayers: 64 });
    expect(new Date(body.checkedAt).toISOString()).toBe(body.checkedAt);
    const row = await prisma.officialServer.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ instanceNonce: n, players: 1, maxPlayers: 16, reportedGameBuild: "0.59.1-linux", serverRuntime: "linux-x64" });
    expect(row.lastHeartbeatAt?.toISOString()).toBe(body.checkedAt);
  });

  it("treats game_build and server_runtime as informational only", async () => {
    const { id, secret } = await createServer();
    expect((await hb(id, secret, beat(nonce(), { game_build: "0.59.1-win", server_runtime: "win-x64" }))).status).toBe(200);
  });

  it("401s wrong secrets, unknown ids, bad schemes and disabled servers", async () => {
    const { id, secret } = await createServer();
    const other = randomBytes(32).toString("base64url");
    await expectError(await hb(id, other, beat(nonce())), 401, "invalid_server");
    await expectError(await hb("nosuchserver", secret, beat(nonce())), 401, "invalid_server");
    await expectError(await heartbeat.POST(req("/api/servers/heartbeat", { auth: `Bearer ${secret}`, json: beat(nonce()) })), 401, "invalid_server");
    // A plaintext-hash value as the "secret" must not match either.
    const row = await prisma.officialServer.findUniqueOrThrow({ where: { id } });
    await expectError(await hb(id, row.secretHash!, beat(nonce())), 401, "invalid_server");

    expect((await disable.POST(req(`/api/admin/servers/${id}/disable`, { jar: adminJar, json: {} }), params(id))).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: "SERVER_DISABLED", targetId: id } })).toBe(1);
    await expectError(await hb(id, secret, beat(nonce())), 401, "invalid_server");
    expect((await disable.POST(req(`/api/admin/servers/${id}/disable`, { jar: adminJar, json: {} }), params(id))).status).toBe(404);
    expect((await prisma.officialServer.findUniqueOrThrow({ where: { id } })).lastHeartbeatAt).toBeNull();
  });

  it("invalidates the old secret immediately on rotation", async () => {
    const { id, secret: oldSecret } = await createServer();
    expect((await hb(id, oldSecret, beat(nonce()))).status).toBe(200);
    const res = await rotate.POST(req(`/api/admin/servers/${id}/rotate`, { jar: adminJar, json: {} }), params(id));
    expect(res.status).toBe(200);
    const { secret: newSecret } = await res.json();
    expect(newSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSecret).not.toBe(oldSecret);
    expect((await prisma.officialServer.findUniqueOrThrow({ where: { id } })).secretHash).toBe(sha256(newSecret));
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "SERVER_SECRET_ROTATED", targetId: id } });
    expect(JSON.stringify(audit)).not.toContain(newSecret);
    await resetLimit(id);
    await expectError(await hb(id, oldSecret, beat(nonce())), 401, "invalid_server");
    expect((await hb(id, newSecret, beat(nonce()))).status).toBe(200);
  });

  it("adopts build_family and protocol_version from a new process, ends prior sessions and writes an audit", async () => {
    const { id, secret } = await createServer();
    const first = nonce();
    expect((await hb(id, secret, beat(first))).status).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: player.email } });
    const ns = await prisma.nativeSession.create({
      data: { userId: user.id, clientId: "twaz-launcher", absoluteExpiresAt: new Date(Date.now() + 3600e3), lastUsedAt: new Date(), idleExpiresAt: new Date(Date.now() + 3600e3) },
    });
    const ticket = () => prisma.joinTicket.create({
      data: { ticketHash: sha256(nonce()), userId: user.id, nativeSessionId: ns.id, serverId: id, gameBuild: "0.59.1", buildFamily: "playtest-0.59", protocolVersion: 3, clientPlatform: "win-x64", expiresAt: new Date(Date.now() + 60e3) },
    });
    const old = await prisma.serverSession.create({ data: { serverId: id, userId: user.id, ticketId: (await ticket()).id, instanceNonce: first, connectionId: "1" } });

    await resetLimit(id);
    const second = nonce();
    const err = vi.spyOn(console, "error");
    const res = await hb(id, secret, beat(second, { build_family: "playtest-0.60", protocol_version: 4, game_build: "0.60.0-linux" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = await prisma.officialServer.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      buildFamily: "playtest-0.60",
      protocolVersion: 4,
      instanceNonce: second,
      reportedGameBuild: "0.60.0-linux",
      gameBuild: "0.59.1",
    });
    expect(row.lastHeartbeatAt?.toISOString()).toBe(body.checkedAt);
    expect(await prisma.serverSession.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ endReason: "server_restart" });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "SERVER_COMPAT_ADOPTED", targetId: id } });
    expect(audit.actorId).toBeNull();
    expect(audit.meta).toEqual({
      oldBuildFamily: "playtest-0.59",
      newBuildFamily: "playtest-0.60",
      oldProtocolVersion: 3,
      newProtocolVersion: 4,
    });
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect([...err.mock.calls].flat().join(" ")).not.toContain(secret);
    err.mockRestore();
    await prisma.nativeSession.delete({ where: { id: ns.id } });
  });

  it("409s when the same process reports a different family or protocol and leaves the row unchanged", async () => {
    const { id, secret } = await createServer();
    const n = nonce();
    const first = await hb(id, secret, beat(n));
    expect(first.status).toBe(200);
    const before = await prisma.officialServer.findUniqueOrThrow({ where: { id } });
    await resetLimit(id);
    await expectError(await hb(id, secret, beat(n, { build_family: "playtest-0.58" })), 409, "build_mismatch");
    await resetLimit(id);
    await expectError(await hb(id, secret, beat(n, { protocol_version: 2 })), 409, "build_mismatch");
    const after = await prisma.officialServer.findUniqueOrThrow({ where: { id } });
    expect(after).toMatchObject({
      buildFamily: "playtest-0.59",
      protocolVersion: 3,
      instanceNonce: n,
      lastHeartbeatAt: before.lastHeartbeatAt,
      reportedGameBuild: before.reportedGameBuild,
    });
    expect(await prisma.auditLog.count({ where: { action: "SERVER_COMPAT_ADOPTED", targetId: id } })).toBe(0);
  });

  it("does not audit or change family when a new process reports the registered values", async () => {
    const { id, secret } = await createServer();
    const first = nonce();
    expect((await hb(id, secret, beat(first))).status).toBe(200);
    await resetLimit(id);
    const second = nonce();
    expect((await hb(id, secret, beat(second))).status).toBe(200);
    expect(await prisma.officialServer.findUniqueOrThrow({ where: { id } })).toMatchObject({
      buildFamily: "playtest-0.59",
      protocolVersion: 3,
      instanceNonce: second,
    });
    expect(await prisma.auditLog.count({ where: { action: "SERVER_COMPAT_ADOPTED", targetId: id } })).toBe(0);
  });

  it("401s bad credentials before reading the body, even when the body would mismatch", async () => {
    const { id } = await createServer();
    const mismatched = beat(nonce(), { build_family: "playtest-0.58" });
    await expectError(await heartbeat.POST(req("/api/servers/heartbeat", { body: JSON.stringify(mismatched) })), 401, "invalid_server");
    await expectError(await hb(id, "B".repeat(43), mismatched), 401, "invalid_server");
    expect(await prisma.officialServer.findUniqueOrThrow({ where: { id } })).toMatchObject({
      buildFamily: "playtest-0.59",
      protocolVersion: 3,
      lastHeartbeatAt: null,
    });
    expect(await prisma.auditLog.count({ where: { action: "SERVER_COMPAT_ADOPTED", targetId: id } })).toBe(0);
  });

  it("400s malformed bodies after auth", async () => {
    const { id, secret } = await createServer();
    for (const bad of [beat("short"), beat(nonce(), { players: 17 }), beat(nonce(), { players: -1 }), beat(nonce(), { maxPlayers: 1.5 }), [], null]) {
      await resetLimit(id);
      await expectError(await hb(id, secret, bad), 400, "invalid_request");
    }
    await resetLimit(id);
    await expectError(await heartbeat.POST(req("/api/servers/heartbeat", { auth: `TwazServer ${id}.${secret}`, raw: "{nope" })), 400, "invalid_request");
    await resetLimit(id);
    await expectError(await heartbeat.POST(req("/api/servers/heartbeat", { auth: `TwazServer ${id}.${secret}`, raw: " ".repeat(4097) })), 400, "invalid_request");
  });

  it("rate limits to 4 per minute per server, after auth", async () => {
    const { id, secret } = await createServer();
    const n = nonce();
    for (let i = 0; i < 4; i++) expect((await hb(id, secret, beat(n))).status).toBe(200);
    const limited = await hb(id, secret, beat(n));
    await expectError(limited, 429, "rate_limited");
    // Wrong credentials neither consume nor see the bucket.
    await expectError(await hb(id, randomBytes(32).toString("base64url"), beat(n)), 401, "invalid_server");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("ends open sessions of the previous instance on restart, keeping the new instance's", async () => {
    const { id, secret } = await createServer();
    const first = nonce();
    expect((await hb(id, secret, beat(first))).status).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: player.email } });
    const ns = await prisma.nativeSession.create({
      data: { userId: user.id, clientId: "twaz-launcher", absoluteExpiresAt: new Date(Date.now() + 3600e3), lastUsedAt: new Date(), idleExpiresAt: new Date(Date.now() + 3600e3) },
    });
    const ticket = (i: number) => prisma.joinTicket.create({
      data: { ticketHash: sha256(`${run}-${id}-${i}`), userId: user.id, nativeSessionId: ns.id, serverId: id, gameBuild: "0.59.1-win", buildFamily: "playtest-0.59", protocolVersion: 3, clientPlatform: "win-x64", expiresAt: new Date(Date.now() + 60e3), usedAt: new Date() },
    });
    const old = await prisma.serverSession.create({ data: { serverId: id, userId: user.id, ticketId: (await ticket(1)).id, instanceNonce: first, connectionId: "1" } });
    const done = await prisma.serverSession.create({ data: { serverId: id, userId: user.id, ticketId: (await ticket(2)).id, instanceNonce: first, connectionId: "2", endedAt: new Date(0), endReason: "client_disconnect" } });

    // Same nonce: nothing ends.
    expect((await hb(id, secret, beat(first))).status).toBe(200);
    expect((await prisma.serverSession.findUniqueOrThrow({ where: { id: old.id } })).endedAt).toBeNull();

    const second = nonce();
    // Same connection id under a new instance does not collide.
    const fresh = await prisma.serverSession.create({ data: { serverId: id, userId: user.id, ticketId: (await ticket(3)).id, instanceNonce: second, connectionId: "1" } });
    const res = await hb(id, secret, beat(second));
    expect(res.status).toBe(200);
    expect(await prisma.serverSession.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ endReason: "server_restart" });
    expect((await prisma.serverSession.findUniqueOrThrow({ where: { id: old.id } })).endedAt?.toISOString()).toBe((await res.json()).checkedAt);
    expect(await prisma.serverSession.findUniqueOrThrow({ where: { id: done.id } })).toMatchObject({ endReason: "client_disconnect" });
    expect(await prisma.serverSession.findUniqueOrThrow({ where: { id: fresh.id } })).toMatchObject({ endedAt: null });
    expect((await prisma.officialServer.findUniqueOrThrow({ where: { id } })).instanceNonce).toBe(second);
    await expect(prisma.serverSession.create({ data: { serverId: id, userId: user.id, ticketId: (await ticket(4)).id, instanceNonce: second, connectionId: "1" } })).rejects.toThrow();
    await prisma.nativeSession.delete({ where: { id: ns.id } });
  });

  it("serializes heartbeats against rotation: a rotation committed mid-flight wins", async () => {
    const { id, secret } = await createServer();
    // Hold the row lock, rotate inside, and let a concurrent heartbeat queue behind it.
    let pending: Promise<Response> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "OfficialServer" WHERE "id" = ${id} FOR UPDATE`;
      pending = hb(id, secret, beat(nonce()));
      await new Promise((r) => setTimeout(r, 300));
      await tx.officialServer.update({ where: { id }, data: { secretHash: sha256(randomBytes(32).toString("base64url")) } });
    });
    await expectError(await pending!, 401, "invalid_server");
    expect((await prisma.officialServer.findUniqueOrThrow({ where: { id } })).lastHeartbeatAt).toBeNull();
  });
});
