// Moderation panel routes + the game-server moderation API + ban enforcement, through the real handlers against the Postgres at DATABASE_URL.
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.AUTH_URL ??= "http://localhost:3000";
process.env.AUTH_SECRET ??= randomBytes(32).toString("hex");
process.env.AUTH_TRUST_HOST ??= "true";
if (!process.env.LAUNCHER_TOKEN_SECRET || Buffer.byteLength(process.env.LAUNCHER_TOKEN_SECRET) < 32) {
  process.env.LAUNCHER_TOKEN_SECRET = randomBytes(32).toString("base64url");
}
const run = randomBytes(4).toString("hex");
const mail = (label: string) => `${label}-${run}@example.test`;
const savedEnv = { admin: process.env.ADMIN_EMAILS, owner: process.env.OWNER_EMAILS };
process.env.OWNER_EMAILS = mail("owner");
process.env.ADMIN_EMAILS = [mail("owner"), mail("env"), mail("env2")].join(",");

// The signed-in browser user, read by currentUser(); the pages and web routes recompute the standing from the DB.
let actor: string | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: { id: actor }, issuedPwdAt: 0 } : null) }));

const { prisma } = await import("@/lib/db");
const { sha256, displayName } = await import("@/lib/crypto");
const { SERVER_LIMITS, heartbeatKey } = await import("@/lib/servers");
const { launcherJoinAccountKey, windowStart } = await import("@/lib/rate-limit");
const { signAccessToken } = await import("@/lib/launcher/jwt");
const mod = await import("@/lib/moderation");
const adminsRoute = await import("@/app/api/admin/moderation/admins/route");
const demoteRoute = await import("@/app/api/admin/moderation/admins/[userId]/demote/route");
const powersRoute = await import("@/app/api/admin/moderation/admins/[userId]/powers/route");
const kickRoute = await import("@/app/api/admin/moderation/servers/[id]/kick/route");
const webBans = await import("@/app/api/admin/moderation/bans/route");
const unbanRoute = await import("@/app/api/admin/moderation/bans/[banId]/unban/route");
const rosterRoute = await import("@/app/api/servers/[id]/admin-roster/route");
const bansRoute = await import("@/app/api/servers/[id]/bans/route");
const commandsRoute = await import("@/app/api/servers/[id]/commands/route");
const ackRoute = await import("@/app/api/servers/[id]/commands/[cmdId]/ack/route");
const heartbeat = await import("@/app/api/servers/heartbeat/route");
const admit = await import("@/app/api/servers/admit/route");
const check = await import("@/app/api/servers/sessions/check/route");
const join = await import("@/app/api/launcher/join-ticket/route");
const ModerationPage = (await import("@/app/admin/moderation/page")).default;
const BansPage = (await import("@/app/admin/moderation/bans/page")).default;
const PlayersPage = (await import("@/app/admin/moderation/servers/[id]/page")).default;

const BASE = process.env.AUTH_URL!;
const family = `fam-${run}`;
const batch = `mod-${run}`;
const NONCE = "n".repeat(20);
const emails: string[] = [];
const serverIds: string[] = [];
const userIds: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { ALL_POWERS, NO_POWERS, gamePowers } = mod;
type Powers = typeof ALL_POWERS;

type User = { id: string; email: string; sessionId: string; token: string };
type Server = { id: string; secret: string };

async function makeUser(label: string, o: { role?: "ADMIN" | "PLAYER"; verified?: boolean; powers?: Partial<Powers> | null } = {}): Promise<User> {
  const email = mail(label);
  emails.push(email);
  const user = await prisma.user.create({
    data: {
      email, passwordHash: "x", role: o.role ?? "PLAYER", emailVerifiedAt: o.verified === false ? null : new Date(Date.now() - 1000),
      ...(o.powers ? { gameAdmin: { create: o.powers } } : {}),
    },
  });
  userIds.push(user.id);
  await prisma.accessKey.create({
    data: { codeHash: sha256(`${batch}-${email}`), codePrefix: "TEST", tier: "BETA", status: "REDEEMED", batchLabel: batch, redemption: { create: { userId: user.id } } },
  });
  const now = Date.now();
  const s = await prisma.nativeSession.create({
    data: { userId: user.id, clientId: "twaz-launcher", createdAt: new Date(now - 500), lastUsedAt: new Date(now), idleExpiresAt: new Date(now + 3600e3), absoluteExpiresAt: new Date(now + 7200e3) },
  });
  return { id: user.id, email, sessionId: s.id, token: signAccessToken({ sub: user.id, sid: s.id, pwdAt: 0 }) };
}

async function makeServer(extra: Record<string, unknown> = {}): Promise<Server> {
  const secret = randomBytes(32).toString("base64url");
  const s = await prisma.officialServer.create({
    data: {
      name: `srv ${run} ${serverIds.length}`, region: "eu", host: "play.example.org", port: 7777, gameBuild: "0.59.1", buildFamily: family, protocolVersion: 3,
      clientPlatforms: ["win-x64"], secretHash: sha256(secret), secretRotatedAt: new Date(), lastHeartbeatAt: new Date(), players: 0, maxPlayers: 16,
      instanceNonce: NONCE, serverRuntime: "linux-x64", reportedGameBuild: "0.59.1-linux", ...extra,
    },
  });
  serverIds.push(s.id);
  return { id: s.id, secret };
}

const U = {} as Record<"owner" | "env" | "env2" | "site" | "gaKick" | "gaBan" | "gaNone" | "unver" | "player", User>;
let A: Server;
let B: Server;
let C: Server; // disabled

const rateKeys = () => serverIds.flatMap((id) => [heartbeatKey(id), ...Object.values(SERVER_LIMITS).map((l) => `${l.prefix}:${id}`)]);
beforeEach(async () => {
  actor = null;
  await prisma.rateLimit.deleteMany({ where: { key: { in: [...rateKeys(), ...userIds.map(launcherJoinAccountKey)] } } });
});

beforeAll(async () => {
  U.owner = await makeUser("owner", { role: "ADMIN" });
  U.env = await makeUser("env", { role: "ADMIN" });
  U.env2 = await makeUser("env2", { role: "ADMIN" });
  U.site = await makeUser("site", { role: "ADMIN" });
  U.gaKick = await makeUser("gakick", { powers: { kick: true } });
  U.gaBan = await makeUser("gaban", { powers: { ban: true } });
  U.gaNone = await makeUser("ganone", { powers: {} });
  U.unver = await makeUser("unver", { verified: false, powers: { kick: true, ban: true } });
  U.player = await makeUser("player");
  A = await makeServer();
  B = await makeServer();
  C = await makeServer({ status: "DISABLED" });
});

afterAll(async () => {
  await prisma.officialServer.deleteMany({ where: { id: { in: serverIds } } });
  await prisma.auditLog.deleteMany({ where: { OR: [
    { actorId: { in: userIds } }, { targetId: { in: [...userIds, ...serverIds] } },
    ...serverIds.map((serverId) => ({ meta: { path: ["serverId"], equals: serverId } })),
  ] } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.accessKey.deleteMany({ where: { batchLabel: batch } });
  await prisma.moderationCounter.deleteMany({ where: { key: { in: serverIds.map(mod.counterKey.commands) } } });
  await prisma.rateLimit.deleteMany({ where: { key: { in: [...rateKeys(), ...userIds.map(launcherJoinAccountKey)] } } });
  if (savedEnv.admin === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = savedEnv.admin;
  if (savedEnv.owner === undefined) delete process.env.OWNER_EMAILS; else process.env.OWNER_EMAILS = savedEnv.owner;
  await prisma.$disconnect();
});

// ---- helpers: browser (form) routes ----
type Handler = (...a: never[]) => Promise<Response>;
const call = (h: Handler, req: NextRequest, params?: Record<string, string>) => (h as unknown as (r: Request, c: unknown) => Promise<Response>)(req, { params: Promise.resolve(params ?? {}) });
async function web(route: { POST: Handler }, path: string, as: string | null, fields: Record<string, string> = {}, params?: Record<string, string>) {
  actor = as;
  return call(route.POST, new NextRequest(new URL(path, BASE), { method: "POST", body: new URLSearchParams(fields) }), params);
}
const loc = (res: Response) => res.headers.get("location");
const forbidden = async (res: Response) => { expect(res.status).toBe(403); expect(await res.json()).toEqual({ error: "forbidden" }); };
const ver = (serverId: string) => mod.counters(prisma, serverId);
const auditsOf = (action: string, targetId: string) => prisma.auditLog.findMany({ where: { action, targetId }, orderBy: { at: "asc" } });

// ---- helpers: dedicated-server routes ----
const authOf = (s: Server) => `TwazServer ${s.id}.${s.secret}`;
function srv(h: Handler, method: "GET" | "POST", s: Server | null, id: string, tail: string, o: { body?: unknown; raw?: string; auth?: string; inm?: string; params?: Record<string, string> } = {}) {
  const hd = new Headers();
  const auth = o.auth ?? (s ? authOf(s) : null);
  if (auth) hd.set("authorization", auth);
  if (o.inm) hd.set("if-none-match", o.inm);
  const hasBody = o.body !== undefined || o.raw !== undefined;
  if (hasBody) hd.set("content-type", "application/json");
  return call(h, new NextRequest(new URL(`/api/servers/${id}/${tail}`, BASE), { method, headers: hd, body: hasBody ? (o.raw ?? JSON.stringify(o.body)) : undefined }), { id, ...o.params });
}
const getRoster = (s: Server | null, o = {}, id = s?.id ?? A.id) => srv(rosterRoute.GET, "GET", s, id, "admin-roster", o);
const getBans = (s: Server | null, o = {}, id = s?.id ?? A.id) => srv(bansRoute.GET, "GET", s, id, "bans", o);
const getCommands = (s: Server | null, o = {}, id = s?.id ?? A.id) => srv(commandsRoute.GET, "GET", s, id, "commands", o);
const postBan = (s: Server | null, body: unknown, o: { raw?: string; auth?: string } = {}, id = s?.id ?? A.id) => srv(bansRoute.POST, "POST", s, id, "bans", { body, ...o });
const postAck = (s: Server | null, cmdId: string, body: unknown, o: { raw?: string; auth?: string } = {}, id = s?.id ?? A.id) => srv(ackRoute.POST, "POST", s, id, `commands/${cmdId}/ack`, { body, params: { cmdId }, ...o });
const expectError = async (res: Response, status: number, error: string) => {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ error });
};
const beat = (s: Server, extra: Record<string, unknown> = {}, nonce = NONCE) =>
  heartbeat.POST(new NextRequest(new URL("/api/servers/heartbeat", BASE), {
    method: "POST", headers: { authorization: authOf(s), "content-type": "application/json" },
    body: JSON.stringify({ game_build: "0.59.1-linux", build_family: family, protocol_version: 3, server_runtime: "linux-x64", instance_nonce: nonce, players: 1, maxPlayers: 16, ...extra }),
  }));

let seq = 0;
const fresh = (label: string, o: Parameters<typeof makeUser>[1] = {}) => makeUser(`${label}${seq++}`, o);
const WEB = "/api/admin/moderation";
const activeServers = () => prisma.officialServer.count({ where: { status: "ACTIVE" } });

describe("web panel routes", () => {
  it("refuses anonymous, plain players and unverified accounts on every route and page", async () => {
    const t = await fresh("t");
    for (const as of [null, U.player.id, U.unver.id]) {
      await forbidden(await web(adminsRoute, `${WEB}/admins`, as, { email: t.email }));
      await forbidden(await web(demoteRoute, `${WEB}/admins/x/demote`, as, {}, { userId: U.gaNone.id }));
      await forbidden(await web(powersRoute, `${WEB}/admins/x/powers`, as, { kick: "on" }, { userId: U.gaNone.id }));
      await forbidden(await web(kickRoute, `${WEB}/servers/${A.id}/kick`, as, { userId: t.id }, { id: A.id }));
      await forbidden(await web(webBans, `${WEB}/bans`, as, { userId: t.id }));
      await forbidden(await web(unbanRoute, `${WEB}/bans/x/unban`, as, {}, { banId: "x" }));
    }
    expect(await prisma.gameAdmin.count({ where: { userId: t.id } })).toBe(0);
    expect(await prisma.playerBan.count({ where: { userId: t.id } })).toBe(0);
    expect(await prisma.serverCommand.count({ where: { userId: t.id } })).toBe(0);
    const sp = { searchParams: Promise.resolve({}) };
    const id = { params: Promise.resolve({ id: A.id }) };
    for (const [as, where] of [[null, "/login"], [U.player.id, "/account"], [U.unver.id, "/account"]] as const) {
      actor = as;
      await expect(ModerationPage(sp)).rejects.toMatchObject({ digest: expect.stringContaining(where) });
      await expect(BansPage(sp)).rejects.toMatchObject({ digest: expect.stringContaining(where) });
      await expect(PlayersPage({ ...id, ...sp })).rejects.toMatchObject({ digest: expect.stringContaining(where) });
    }
  });

  it("promotes by exact email of a verified non-admin, with no powers, no site role, an audit and a roster bump", async () => {
    const t = await fresh("promo");
    const v0 = (await ver(A.id)).rosterVersion;
    const res = await web(adminsRoute, `${WEB}/admins`, U.gaNone.id, { email: ` ${t.email.toUpperCase()} ` });
    expect(res.status).toBe(303);
    expect(loc(res)).toBe("/admin/moderation?done=promoted");
    expect(await prisma.gameAdmin.findUniqueOrThrow({ where: { userId: t.id } })).toMatchObject({ ...NO_POWERS, grantedById: U.gaNone.id });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: t.id } })).role).toBe("PLAYER");
    expect((await ver(A.id)).rosterVersion).toBe(v0 + 1);
    const [a, ...rest] = await auditsOf("ADMIN_GRANTED", t.id);
    expect(rest).toHaveLength(0);
    expect(a).toMatchObject({ actorId: U.gaNone.id, meta: { old: null, new: NO_POWERS, source: "web" } });
    expect(JSON.stringify(a.meta)).not.toContain("@");

    // Not twice, not an admin, not the owner, not yourself, not a near match, not an unverified account.
    for (const email of [t.email, U.env.email, U.owner.email, U.gaNone.email, U.gaKick.email]) {
      expect(loc(await web(adminsRoute, `${WEB}/admins`, U.owner.id, { email }))).toBe("/admin/moderation?error=conflict");
    }
    for (const email of [`x${t.email}`, U.unver.email]) {
      expect(loc(await web(adminsRoute, `${WEB}/admins`, U.owner.id, { email }))).toBe("/admin/moderation?error=unknown_account");
    }
    expect((await web(adminsRoute, `${WEB}/admins`, U.owner.id, { email: "nope" })).status).toBe(400);
    expect((await ver(A.id)).rosterVersion).toBe(v0 + 1);
    expect(await auditsOf("ADMIN_GRANTED", t.id)).toHaveLength(1);
  });

  it("lets only the owner change powers or demote, and never the owner", async () => {
    const t = await fresh("pw", { powers: {} });
    for (const as of [U.env.id, U.site.id, U.gaBan.id, U.gaKick.id, U.gaNone.id]) {
      await forbidden(await web(powersRoute, `${WEB}/admins/x/powers`, as, { kick: "on", ban: "on" }, { userId: t.id }));
      await forbidden(await web(demoteRoute, `${WEB}/admins/x/demote`, as, {}, { userId: t.id }));
    }
    expect(await prisma.gameAdmin.findUniqueOrThrow({ where: { userId: t.id } })).toMatchObject(NO_POWERS);

    const v0 = (await ver(A.id)).rosterVersion;
    const res = await web(powersRoute, `${WEB}/admins/x/powers`, U.owner.id, { kick: "on", ban: "on" }, { userId: t.id });
    expect(res.status).toBe(303);
    expect(loc(res)).toBe("/admin/moderation?done=powers");
    expect(await prisma.gameAdmin.findUniqueOrThrow({ where: { userId: t.id } })).toMatchObject({ ...NO_POWERS, kick: true, ban: true });
    expect((await ver(A.id)).rosterVersion).toBe(v0 + 1);
    const [pc] = await auditsOf("ADMIN_POWERS_CHANGED", t.id);
    expect(pc).toMatchObject({ actorId: U.owner.id, meta: { old: NO_POWERS, new: { ...NO_POWERS, kick: true, ban: true }, source: "web" } });

    // Same powers again: no write, no audit, no bump.
    expect((await web(powersRoute, `${WEB}/admins/x/powers`, U.owner.id, { kick: "on", ban: "on" }, { userId: t.id })).status).toBe(303);
    expect(await auditsOf("ADMIN_POWERS_CHANGED", t.id)).toHaveLength(1);
    expect((await ver(A.id)).rosterVersion).toBe(v0 + 1);

    // Nobody changes the owner, the owner included; a plain player is not an admin.
    await forbidden(await web(powersRoute, `${WEB}/admins/x/powers`, U.owner.id, { kick: "on" }, { userId: U.owner.id }));
    await forbidden(await web(demoteRoute, `${WEB}/admins/x/demote`, U.owner.id, {}, { userId: U.owner.id }));
    expect((await web(powersRoute, `${WEB}/admins/x/powers`, U.owner.id, { kick: "on" }, { userId: U.player.id })).status).toBe(404);
    expect((await web(demoteRoute, `${WEB}/admins/x/demote`, U.owner.id, {}, { userId: U.player.id })).status).toBe(404);

    const dv = (await ver(A.id)).rosterVersion;
    const dem = await web(demoteRoute, `${WEB}/admins/x/demote`, U.owner.id, {}, { userId: t.id });
    expect(dem.status).toBe(303);
    expect(loc(dem)).toBe("/admin/moderation?done=demoted");
    expect(await prisma.gameAdmin.count({ where: { userId: t.id } })).toBe(0);
    expect((await ver(A.id)).rosterVersion).toBe(dv + 1);
    const [rv] = await auditsOf("ADMIN_REVOKED", t.id);
    expect(rv).toMatchObject({ actorId: U.owner.id, meta: { old: { ...NO_POWERS, kick: true, ban: true }, new: null, source: "web" } });
    expect((await web(demoteRoute, `${WEB}/admins/x/demote`, U.owner.id, {}, { userId: t.id })).status).toBe(404);
  });

  it("lets the owner narrow an env admin's powers (creating the row) but never demote one", async () => {
    try {
      const res = await web(powersRoute, `${WEB}/admins/x/powers`, U.owner.id, { kick: "on" }, { userId: U.env2.id });
      expect(res.status).toBe(303);
      expect(await prisma.gameAdmin.findUniqueOrThrow({ where: { userId: U.env2.id } })).toMatchObject({ ...NO_POWERS, kick: true });
      const [a] = await auditsOf("ADMIN_POWERS_CHANGED", U.env2.id);
      expect(a.meta).toEqual({ old: ALL_POWERS, new: { ...NO_POWERS, kick: true }, source: "web" });
      const s = await mod.loadStandingById(prisma, U.env2.id);
      expect(s?.standing).toMatchObject({ level: "admin", source: "env", powers: { ...NO_POWERS, kick: true } });
      await forbidden(await web(demoteRoute, `${WEB}/admins/x/demote`, U.owner.id, {}, { userId: U.env2.id }));
      expect(await prisma.gameAdmin.count({ where: { userId: U.env2.id } })).toBe(1);
    } finally {
      await prisma.gameAdmin.deleteMany({ where: { userId: U.env2.id } });
    }
  });

  it("queues a kick only for admins with the kick power, never against the owner, yourself or (non-owner) an admin", async () => {
    const t = await fresh("kick");
    const k = `${WEB}/servers/${A.id}/kick`;
    const c0 = (await ver(A.id)).commandsVersion;
    const res = await web(kickRoute, k, U.gaKick.id, { userId: t.id, reason: "afk" }, { id: A.id });
    expect(res.status).toBe(303);
    expect(loc(res)).toBe(`/admin/moderation/servers/${A.id}?done=kicked`);
    const cmd = await prisma.serverCommand.findFirstOrThrow({ where: { serverId: A.id, userId: t.id } });
    expect(cmd).toMatchObject({ type: "kick", reason: "afk", createdById: U.gaKick.id, banId: null, ackedAt: null, result: null });
    const ttl = cmd.expiresAt.getTime() - cmd.createdAt.getTime();
    expect(ttl).toBeGreaterThan(290_000);
    expect(ttl).toBeLessThan(310_000);
    expect((await ver(A.id)).commandsVersion).toBe(c0 + 1);
    const [a] = await auditsOf("PLAYER_KICK_REQUESTED", t.id);
    expect(a).toMatchObject({ actorId: U.gaKick.id, meta: { old: null, new: { kick: true }, reason: "afk", source: "web", serverId: A.id } });

    for (const [as, target] of [[U.gaBan.id, t.id], [U.gaNone.id, t.id], [U.gaKick.id, U.owner.id], [U.gaKick.id, U.env.id], [U.gaKick.id, U.gaBan.id], [U.gaKick.id, U.gaKick.id], [U.env.id, U.owner.id]]) {
      await forbidden(await web(kickRoute, k, as, { userId: target }, { id: A.id }));
    }
    expect((await web(kickRoute, k, U.owner.id, { userId: U.env.id }, { id: A.id })).status).toBe(303); // the owner may reach admins
    expect(loc(await web(kickRoute, k, U.gaKick.id, { userId: "nosuchaccount" }, { id: A.id }))).toBe(`/admin/moderation/servers/${A.id}?error=unknown_account`);
    expect((await web(kickRoute, `${WEB}/servers/${C.id}/kick`, U.gaKick.id, { userId: t.id }, { id: C.id })).status).toBe(404);
    expect((await web(kickRoute, k, U.gaKick.id, { userId: "BAD ID" }, { id: A.id })).status).toBe(400);
    expect((await web(kickRoute, k, U.gaKick.id, { userId: t.id, reason: "x".repeat(201) }, { id: A.id })).status).toBe(400);
    expect(await prisma.serverCommand.count({ where: { serverId: A.id, userId: t.id } })).toBe(1);
    expect(await prisma.serverCommand.count({ where: { serverId: C.id } })).toBe(0);
  });

  it("bans globally (kicks on every active server) or per server, and unbans without deleting", async () => {
    const t = await fresh("ban");
    const t2 = await fresh("ban");
    const b0 = (await ver(A.id)).bansVersion;
    const ca = (await ver(A.id)).commandsVersion;
    const cb = (await ver(B.id)).commandsVersion;
    const res = await web(webBans, `${WEB}/bans`, U.gaBan.id, { userId: t.id, reason: "cheating", amount: "2", unit: "hours" });
    expect(res.status).toBe(303);
    expect(loc(res)).toBe("/admin/moderation/bans?done=banned");
    const ban = await prisma.playerBan.findFirstOrThrow({ where: { userId: t.id } });
    expect(ban).toMatchObject({ serverId: null, reason: "cheating", createdById: U.gaBan.id, revokedAt: null });
    expect(Math.abs(ban.expiresAt!.getTime() - Date.now() - 2 * 3_600_000)).toBeLessThan(15_000);
    expect((await ver(A.id)).bansVersion).toBe(b0 + 1);
    const kicks = await prisma.serverCommand.findMany({ where: { userId: t.id } });
    expect(kicks.every((c) => c.banId === ban.id && c.reason === "cheating" && c.type === "kick")).toBe(true);
    expect(kicks.map((c) => c.serverId)).toEqual(expect.arrayContaining([A.id, B.id]));
    expect(kicks.map((c) => c.serverId)).not.toContain(C.id);
    expect(kicks).toHaveLength(await activeServers());
    expect((await ver(A.id)).commandsVersion).toBe(ca + 1);
    expect((await ver(B.id)).commandsVersion).toBe(cb + 1);
    const [a] = await auditsOf("PLAYER_BANNED", t.id);
    expect(a).toMatchObject({ actorId: U.gaBan.id });
    expect(a.meta).toMatchObject({ source: "web", scope: "global", banId: ban.id, reason: "cheating", durationMinutes: 120, queuedKicks: kicks.length, expiresAt: ban.expiresAt!.toISOString() });
    expect(JSON.stringify(a.meta)).not.toContain("@");

    // Scoped to one server: one kick, on that server; no reason means the kick reason is "banned"; no duration means permanent.
    expect((await web(webBans, `${WEB}/bans`, U.owner.id, { userId: t2.id, serverId: B.id })).status).toBe(303);
    const sb = await prisma.playerBan.findFirstOrThrow({ where: { userId: t2.id } });
    expect(sb).toMatchObject({ serverId: B.id, reason: null, expiresAt: null });
    expect(await prisma.serverCommand.findMany({ where: { userId: t2.id }, select: { serverId: true, reason: true } })).toEqual([{ serverId: B.id, reason: "banned" }]);

    // Unban: needs the ban power, sets revokedAt/revokedById, keeps the row, bumps the version once.
    const v1 = (await ver(A.id)).bansVersion;
    await forbidden(await web(unbanRoute, `${WEB}/bans/x/unban`, U.gaKick.id, {}, { banId: ban.id }));
    const un = await web(unbanRoute, `${WEB}/bans/x/unban`, U.gaBan.id, {}, { banId: ban.id });
    expect(un.status).toBe(303);
    expect(loc(un)).toBe("/admin/moderation/bans?done=unbanned");
    expect(await prisma.playerBan.findUniqueOrThrow({ where: { id: ban.id } })).toMatchObject({ revokedById: U.gaBan.id, reason: "cheating" });
    expect((await prisma.playerBan.findUniqueOrThrow({ where: { id: ban.id } })).revokedAt).not.toBeNull();
    expect((await ver(A.id)).bansVersion).toBe(v1 + 1);
    const [u] = await auditsOf("PLAYER_UNBANNED", t.id);
    expect(u).toMatchObject({ actorId: U.gaBan.id, meta: { old: { active: true }, new: { active: false }, source: "web", banId: ban.id } });
    expect((await web(unbanRoute, `${WEB}/bans/x/unban`, U.gaBan.id, {}, { banId: ban.id })).status).toBe(404);
    expect((await web(unbanRoute, `${WEB}/bans/x/unban`, U.gaBan.id, {}, { banId: "nosuchban" })).status).toBe(404);
  });

  it("applies the game's ban rules: the owner may ban admins; nobody bans the owner or themselves; invalid input is 400", async () => {
    const ga = await fresh("target", { powers: {} });
    const t = await fresh("plain");
    const b = `${WEB}/bans`;
    for (const [as, target] of [[U.gaKick.id, t.id], [U.gaNone.id, t.id], [U.gaBan.id, U.owner.id], [U.env.id, U.owner.id], [U.owner.id, U.owner.id], [U.gaBan.id, U.gaBan.id], [U.gaBan.id, ga.id], [U.env.id, ga.id], [U.env.id, U.site.id]]) {
      await forbidden(await web(webBans, b, as, { userId: target }));
    }
    expect(await prisma.playerBan.count({ where: { userId: { in: [t.id, ga.id, U.owner.id, U.gaBan.id, U.site.id] } } })).toBe(0);
    expect(loc(await web(webBans, b, U.gaBan.id, { userId: "nosuchaccount" }))).toBe("/admin/moderation/bans?error=unknown_account");
    for (const bad of [{ amount: "0" }, { amount: "1.5" }, { amount: "366", unit: "days" }, { durationMinutes: "525601" }, { unit: "weeks", amount: "1" }, { reason: "x".repeat(201) }, { serverId: "BAD ID" }, { extra: "1" }]) {
      expect((await web(webBans, b, U.gaBan.id, { userId: t.id, ...bad } as unknown as Record<string, string>)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await web(webBans, b, U.gaBan.id, { userId: t.id, amount: "365", unit: "days" })).status).toBe(303);
    expect(await prisma.playerBan.count({ where: { userId: t.id } })).toBe(1);
    expect((await web(webBans, b, U.owner.id, { userId: ga.id })).status).toBe(303);
    expect(await prisma.playerBan.count({ where: { userId: ga.id } })).toBe(1);
  });

  it("renders the panel for moderators, hiding full emails from game admins", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const t = await fresh("page");
    await web(webBans, `${WEB}/bans`, U.owner.id, { userId: t.id, reason: "page-test" });
    const sp = { searchParams: Promise.resolve({}) };
    const masked = (e: string) => `${e[0]}***${e.slice(e.indexOf("@"))}`;

    actor = U.gaNone.id;
    const gaHome = renderToStaticMarkup(await ModerationPage(sp));
    const gaBans = renderToStaticMarkup(await BansPage(sp));
    for (const html of [gaHome, gaBans]) {
      for (const e of [U.env.email, t.email, U.owner.email]) expect(html).not.toContain(e);
    }
    expect(gaHome).toContain(masked(U.env.email));
    expect(gaBans).toContain(masked(t.email));
    expect(gaBans).toContain(displayName(t.id));
    expect(gaBans).toContain("page-test");
    expect(gaBans).not.toContain("Unban"); // no ban power
    expect(gaHome).not.toContain("Demote"); // the owner edits admins

    actor = U.site.id; // site admins and the owner see full addresses
    expect(renderToStaticMarkup(await BansPage(sp))).toContain(t.email);
    actor = U.owner.id;
    const ownerHome = renderToStaticMarkup(await ModerationPage(sp));
    expect(ownerHome).toContain(U.env.email);
    expect(ownerHome).toContain("Save"); // power toggles
    expect(renderToStaticMarkup(await BansPage({ searchParams: Promise.resolve({ all: "1" }) }))).toContain("page-test");
  });

  it("lists a server's online players from a fresh heartbeat list only, with admitted state and no kick on the owner", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const s = await makeServer();
    const p = await fresh("online");
    await admitted(s, p);
    const idle = await fresh("idle");
    const page = async (as: string) => {
      actor = as;
      return renderToStaticMarkup(await PlayersPage({ params: Promise.resolve({ id: s.id }), searchParams: Promise.resolve({}) }));
    };
    expect(await page(U.gaKick.id)).toContain("No recent player list");

    expect((await beat(s, { playerAccountIds: [p.id, idle.id, U.owner.id, "ghostaccount"] })).status).toBe(200);
    const html = await page(U.gaKick.id);
    expect(html).toContain(displayName(p.id));
    expect(html).toContain(displayName(idle.id));
    expect(html).toContain("unknown account");
    expect(html).not.toContain(p.email);
    expect(html).toContain(`${WEB}/servers/${s.id}/kick`);
    expect(html).not.toContain(`/api/admin/moderation/bans"`); // no ban power
    expect(html.match(/name="userId" value="/g)).toHaveLength(2); // p and idle; neither the owner nor the unknown id gets a form
    expect(await page(U.gaBan.id)).toContain(`${WEB}/bans`);
    expect(await page(U.site.id)).toContain(p.email);

    await prisma.officialServer.update({ where: { id: s.id }, data: { onlinePlayersAt: new Date(Date.now() - 120_000) } });
    expect(await page(U.gaKick.id)).toContain("No recent player list");
  });

  it("lists a heartbeating server as online even when it has not reported playerAccountIds", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const freshName = `eu1-fresh-${run}`;
    const staleName = `eu1-stale-${run}`;
    await makeServer({ name: freshName, lastHeartbeatAt: new Date(), players: 0, adminMaxPlayers: 64, onlinePlayersAt: null, onlinePlayerIds: [] });
    await makeServer({
      name: staleName, lastHeartbeatAt: new Date(Date.now() - 91_000), players: 3, adminMaxPlayers: 64,
      onlinePlayersAt: new Date(), onlinePlayerIds: [U.player.id],
    });
    actor = U.owner.id;
    const html = renderToStaticMarkup(await ModerationPage({ searchParams: Promise.resolve({}) }));
    const row = (name: string) => {
      const i = html.indexOf(name);
      expect(i, name).toBeGreaterThan(-1);
      return html.slice(i, html.indexOf("</tr>", i));
    };
    expect(row(freshName)).toContain(">online<");
    expect(row(freshName)).toContain(">0/64<");
    expect(row(freshName)).not.toContain("unknown");
    expect(row(staleName)).toContain(">offline<");
    expect(row(staleName)).toContain(">3/64<");
    expect(row(staleName)).not.toContain(">online<");
  });
});

// ---- helpers: tickets, admit, check, join ----
let conn = 5000;
async function makeTicket(u: User, s: Server) {
  const ticket = randomBytes(32).toString("base64url");
  const row = await prisma.joinTicket.create({
    data: {
      ticketHash: sha256(ticket), userId: u.id, nativeSessionId: u.sessionId, serverId: s.id, gameBuild: "0.59-win", buildFamily: family, protocolVersion: 3,
      clientPlatform: "win-x64", expiresAt: new Date(Date.now() + 60e3),
    },
  });
  return { ticket, id: row.id };
}
const plain = (route: { POST: Handler }, path: string, s: Server, body: unknown) =>
  (route.POST as unknown as (r: Request) => Promise<Response>)(new NextRequest(new URL(path, BASE), {
    method: "POST", headers: { authorization: authOf(s), "content-type": "application/json" }, body: JSON.stringify(body),
  }));
const admitBody = (ticket: string) => ({ ticket, instance_nonce: NONCE, connection_id: String(conn++), build_family: family, protocol_version: 3, game_build: "0.59-win" });
const doAdmit = (s: Server, ticket: string) => plain(admit as { POST: Handler }, "/api/servers/admit", s, admitBody(ticket));
const doCheck = (s: Server, ids: string[]) => plain(check as { POST: Handler }, "/api/servers/sessions/check", s, { serverSessionIds: ids });
async function admitted(s: Server, u: User) {
  const t = await makeTicket(u, s);
  const j = await (await doAdmit(s, t.ticket)).json();
  expect(j.admitted).toBe(true);
  return { ...t, sessionId: j.serverSessionId as string };
}
const doJoin = (u: User, s: Server) =>
  (join.POST as unknown as (r: Request) => Promise<Response>)(new NextRequest(new URL("/api/launcher/join-ticket", BASE), {
    method: "POST",
    headers: { authorization: `Bearer ${u.token}`, "content-type": "application/json", "x-real-ip": "13.0.0.9" },
    body: JSON.stringify({ serverId: s.id, build_family: family, protocol_version: 3, client_platform: "win-x64", game_build: "0.59-abc1234", nonce: randomBytes(18).toString("base64url") }),
  }));
/** Fills a rate-limit bucket so the next request is the first one over the limit. */
const exhaust = (key: string, limit: number) =>
  prisma.rateLimit.upsert({ where: { key }, create: { key, windowStart: windowStart(Date.now(), 60_000), count: limit }, update: { windowStart: windowStart(Date.now(), 60_000), count: limit } });
const banVia = (targetId: string, o: { serverId?: string | null; minutes?: number | null; reason?: string | null; by?: string } = {}) =>
  prisma.$transaction((tx) => mod.createBan(tx, {
    actorId: o.by ?? U.owner.id, targetId, reason: o.reason ?? null, durationMinutes: o.minutes ?? null, serverId: o.serverId ?? null, source: "web",
  }));
/** Runs `mutate` in a transaction holding its row locks, while `req` starts and has to wait for them. */
async function raceWith(mutate: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>, req: () => Promise<Response>) {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const ready = new Promise<void>((r) => (locked = r));
  const tx = prisma.$transaction(async (t) => { await mutate(t); locked(); await held; }, { timeout: 20_000 });
  await ready;
  const pending = req();
  await sleep(400);
  release();
  await tx;
  return pending;
}
/** A ban row that already ran out, for "expired ban" cases (the panel cannot create one). */
const expiredBan = (userId: string, serverId: string | null = null) => prisma.playerBan.create({ data: { userId, serverId, expiresAt: new Date(Date.now() - 60_000), createdById: U.owner.id } });

describe("dedicated-server endpoints: credential, path, limits, methods", () => {
  const endpoints: [string, (s: Server | null, id?: string, o?: { auth?: string }) => Promise<Response>, string, number][] = [
    ["GET admin-roster", (s, id, o) => getRoster(s, o, id), "server-roster", 30],
    ["GET bans", (s, id, o) => getBans(s, o, id), "server-bans", 30],
    ["GET commands", (s, id, o) => getCommands(s, o, id), "server-commands", 30],
    ["POST bans", (s, id, o) => postBan(s, { accountId: U.player.id, byAccountId: U.owner.id, reason: null, durationMinutes: null }, o, id), "server-ban-write", 30],
    ["POST ack", (s, id, o) => postAck(s, "nosuchcommand", { result: "done" }, o, id), "server-ack", 600],
  ];

  it.each(endpoints)("%s: 401 on missing, malformed, wrong, rotated and disabled credentials", async (_n, call) => {
    await expectError(await call(null), 401, "invalid_server");
    await expectError(await call(A, A.id, { auth: "Bearer abc" }), 401, "invalid_server");
    await expectError(await call(A, A.id, { auth: `TwazServer ${A.id}.${"B".repeat(43)}` }), 401, "invalid_server");
    await expectError(await call({ id: "nosuchserver", secret: A.secret }), 401, "invalid_server");
    await expectError(await call(C, C.id), 401, "invalid_server");
    const R = await makeServer();
    const fresh2 = randomBytes(32).toString("base64url");
    await prisma.officialServer.update({ where: { id: R.id }, data: { secretHash: sha256(fresh2) } });
    await expectError(await call(R, R.id), 401, "invalid_server");
    await prisma.rateLimit.deleteMany({ where: { key: { in: rateKeys() } } });
    expect((await call({ id: R.id, secret: fresh2 }, R.id)).status).not.toBe(401);
  });

  it.each(endpoints)("%s: 403 forbidden when the path id is not the authenticated server (before limits and the body)", async (_n, call) => {
    await expectError(await call(A, B.id), 403, "forbidden");
    await expectError(await call(A, "nosuchserver"), 403, "forbidden");
    expect(await prisma.rateLimit.count({ where: { key: { in: [`server-roster:${A.id}`, `server-bans:${A.id}`, `server-commands:${A.id}`, `server-ban-write:${A.id}`, `server-ack:${A.id}`] } } })).toBe(0);
  });

  it.each(endpoints)("%s: 429 with Retry-After once the per-server bucket is full, other servers unaffected", async (_n, call, prefix, limit) => {
    await exhaust(`${prefix}:${A.id}`, limit);
    const res = await call(A, A.id);
    await expectError(res, 429, "rate_limited");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await call(B, B.id)).status).not.toBe(429);
    await expectError(await call(null), 401, "invalid_server"); // bad credentials neither see nor consume the bucket
  });

  it("405 on every other method, with Allow", async () => {
    const m = (h: Handler, id = A.id, params: Record<string, string> = {}) => call(h, new NextRequest(new URL(`/api/servers/${id}/x`, BASE), { method: "PUT" }), { id, ...params });
    for (const [h, allow] of [[rosterRoute.POST, "GET"], [rosterRoute.PUT, "GET"], [bansRoute.PUT, "GET, POST"], [bansRoute.DELETE, "GET, POST"], [commandsRoute.POST, "GET"], [commandsRoute.PATCH, "GET"], [ackRoute.GET, "POST"], [ackRoute.DELETE, "POST"]] as unknown as [Handler, string][]) {
      const res = await m(h, A.id, { cmdId: "x" });
      await expectError(res, 405, "method_not_allowed");
      expect(res.headers.get("allow")).toBe(allow);
    }
  });
});

describe("GET /api/servers/{id}/admin-roster", () => {
  it("has exactly the contract shape: owner once, verified admins only, all five powers, sorted, no emails", async () => {
    const res = await getRoster(A);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const text = await res.text();
    expect(text).not.toContain("@");
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(["admins", "version"]);
    expect(Number.isInteger(body.version)).toBe(true);
    const ours = new Set(Object.values(U).map((u) => u.id));
    const mine = (body.admins as { accountId: string }[]).filter((a) => ours.has(a.accountId));
    const expected = [
      [U.owner, "owner", ALL_POWERS], [U.env, "admin", ALL_POWERS], [U.env2, "admin", ALL_POWERS],
      [U.gaKick, "admin", { ...NO_POWERS, kick: true }], [U.gaBan, "admin", { ...NO_POWERS, ban: true }], [U.gaNone, "admin", NO_POWERS],
    ].map(([u, role, powers]) => ({ accountId: (u as User).id, displayName: displayName((u as User).id), role, powers: gamePowers(powers as typeof ALL_POWERS) }))
      .sort((a, b) => (a.accountId < b.accountId ? -1 : 1));
    expect(mine).toEqual(expected);
    for (const a of body.admins) {
      expect(Object.keys(a).sort()).toEqual(["accountId", "displayName", "powers", "role"]);
      expect(Object.keys(a.powers).sort()).toEqual(["ban", "godMode", "kick", "spawnItems", "teleport"]);
      expect(Object.values(a.powers).every((v) => typeof v === "boolean")).toBe(true);
    }
    const ids = body.admins.map((a: { accountId: string }) => a.accountId);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(U.site.id); // site admin outside ADMIN_EMAILS with no row
    expect(ids).not.toContain(U.unver.id); // unverified
    expect(ids).not.toContain(U.player.id);
  });

  it("answers If-None-Match with 304 (ETag kept, no body, still counted) and changes version and ETag with the roster", async () => {
    const first = await getRoster(A);
    const etag = first.headers.get("etag")!;
    const v0 = (await first.json()).version as number;
    const hit = await getRoster(A, { inm: etag });
    expect(hit.status).toBe(304);
    expect(hit.headers.get("etag")).toBe(etag);
    expect(await hit.text()).toBe("");
    expect((await getRoster(A, { inm: `W/${etag}` })).status).toBe(304);
    expect((await getRoster(A, { inm: '"other"' })).status).toBe(200);
    expect((await prisma.rateLimit.findUniqueOrThrow({ where: { key: `server-roster:${A.id}` } })).count).toBe(4);

    const t = await fresh("rosterchg");
    await web(adminsRoute, `${WEB}/admins`, U.owner.id, { email: t.email });
    const after = await getRoster(A, { inm: etag });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    const body = await after.json();
    expect(body.version).toBe(v0 + 1);
    expect(body.admins.find((a: { accountId: string }) => a.accountId === t.id)).toMatchObject({ role: "admin", powers: gamePowers(NO_POWERS) });
  });
});

describe("GET /api/servers/{id}/bans", () => {
  it("lists active bans only: global plus this server's, with the contract shape", async () => {
    const [g, s1, s2, ex, rv, tm] = await Promise.all(["g", "s1", "s2", "ex", "rv", "tm"].map((l) => fresh(`bl${l}`)));
    const global = (await banVia(g.id, { reason: "global one" })) as { ban: { id: string } };
    const onA = (await banVia(s1.id, { serverId: A.id })) as { ban: { id: string } };
    await banVia(s2.id, { serverId: B.id });
    await expiredBan(ex.id);
    const revoked = (await banVia(rv.id)) as { ban: { id: string } };
    await prisma.$transaction((tx) => mod.unban(tx, U.owner.id, revoked.ban.id));
    const timed = (await banVia(tm.id, { minutes: 90 })) as { ban: { expiresAt: Date } };

    const res = await getBans(A);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["bans", "version"]);
    const ours = new Map([g, s1, s2, ex, rv, tm].map((u) => [u.id, u]));
    const mine = (body.bans as { accountId: string }[]).filter((b) => ours.has(b.accountId));
    expect(mine.map((b) => b.accountId).sort()).toEqual([g.id, s1.id, tm.id].sort());
    expect(mine.find((b) => b.accountId === g.id)).toEqual({ id: global.ban.id, accountId: g.id, reason: "global one", expiresAt: null, scope: "global" });
    expect(mine.find((b) => b.accountId === s1.id)).toEqual({ id: onA.ban.id, accountId: s1.id, reason: null, expiresAt: null, scope: "server" });
    expect(mine.find((b) => b.accountId === tm.id)).toMatchObject({ scope: "global", expiresAt: timed.ban.expiresAt.toISOString() });
    for (const b of body.bans) expect(Object.keys(b).sort()).toEqual(["accountId", "expiresAt", "id", "reason", "scope"]);
    expect(JSON.stringify(body)).not.toContain("@");

    const onB = await (await getBans(B)).json();
    const mineB = (onB.bans as { accountId: string }[]).filter((b) => ours.has(b.accountId)).map((b) => b.accountId).sort();
    expect(mineB).toEqual([g.id, s2.id, tm.id].sort());
  });

  it("304s on a matching ETag and moves version and ETag when a ban is lifted", async () => {
    const t = await fresh("blv");
    const made = (await banVia(t.id)) as { ban: { id: string } };
    const first = await getBans(A);
    const etag = first.headers.get("etag")!;
    const v0 = (await first.json()).version as number;
    expect((await getBans(A, { inm: etag })).status).toBe(304);
    await prisma.$transaction((tx) => mod.unban(tx, U.owner.id, made.ban.id));
    const after = await getBans(A, { inm: etag });
    expect(after.status).toBe(200);
    const body = await after.json();
    expect(body.version).toBe(v0 + 1);
    expect(body.bans.map((b: { id: string }) => b.id)).not.toContain(made.ban.id);
  });
});

describe("GET /api/servers/{id}/commands and the ack lifecycle", () => {
  it("lists pending commands only (not acked, not expired, not another server's), oldest first, max 100", async () => {
    const S = await makeServer();
    const t = await fresh("cmd");
    const mk = (serverId: string, o: Record<string, unknown> = {}, ms = 300_000) =>
      prisma.serverCommand.create({ data: { serverId, type: "kick", userId: t.id, reason: null, expiresAt: new Date(Date.now() + ms), ...o } });
    const first = await mk(S.id, { reason: "first", createdAt: new Date(Date.now() - 5000) });
    await mk(S.id, { ackedAt: new Date(), result: "done" });
    await mk(S.id, {}, -1000);
    await mk(A.id);
    const second = await mk(S.id, { reason: "second" });

    const res = await getCommands(S);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["commands", "version"]);
    expect(body.commands).toEqual([
      { id: first.id, type: "kick", accountId: t.id, reason: "first", createdAt: first.createdAt.toISOString(), expiresAt: first.expiresAt.toISOString() },
      { id: second.id, type: "kick", accountId: t.id, reason: "second", createdAt: second.createdAt.toISOString(), expiresAt: second.expiresAt.toISOString() },
    ]);

    await prisma.serverCommand.createMany({ data: Array.from({ length: 110 }, () => ({ serverId: S.id, type: "kick", userId: t.id, expiresAt: new Date(Date.now() + 300_000) })) });
    expect((await (await getCommands(S, {}, S.id)).json()).commands).toHaveLength(100);
  });

  it("acks once: stores the first result, repeats are idempotent, audit and version move on the first ack only", async () => {
    const t = await fresh("ack");
    await web(kickRoute, `${WEB}/servers/${A.id}/kick`, U.gaKick.id, { userId: t.id, reason: "ack me" }, { id: A.id });
    const cmd = await prisma.serverCommand.findFirstOrThrow({ where: { serverId: A.id, userId: t.id } });
    const listed = await getCommands(A);
    const etag = listed.headers.get("etag")!;
    const v0 = (await listed.json()).version as number;
    expect((await getCommands(A, { inm: etag })).status).toBe(304);

    const res = await postAck(A, cmd.id, { result: "done" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const row = await prisma.serverCommand.findUniqueOrThrow({ where: { id: cmd.id } });
    expect(row).toMatchObject({ result: "done" });
    expect(await res.json()).toEqual({ ok: true, id: cmd.id, result: "done", ackedAt: row.ackedAt!.toISOString() });
    const audit = await auditsOf("COMMAND_ACKED", cmd.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: null, meta: { serverId: A.id, result: "done" } });
    expect((await ver(A.id)).commandsVersion).toBe(v0 + 1);
    const after = await getCommands(A, { inm: etag });
    expect(after.status).toBe(200);
    expect((await after.json()).commands.map((c: { id: string }) => c.id)).not.toContain(cmd.id);

    const again = await postAck(A, cmd.id, { result: "failed" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, id: cmd.id, result: "done", ackedAt: row.ackedAt!.toISOString() });
    expect(await auditsOf("COMMAND_ACKED", cmd.id)).toHaveLength(1);
    expect((await ver(A.id)).commandsVersion).toBe(v0 + 1);
    expect((await prisma.serverCommand.findUniqueOrThrow({ where: { id: cmd.id } })).result).toBe("done");
  });

  it("serializes concurrent acks: both 200 with the same stored result, one audit", async () => {
    const t = await fresh("ackrace");
    const cmd = await prisma.serverCommand.create({ data: { serverId: A.id, type: "kick", userId: t.id, expiresAt: new Date(Date.now() + 300_000) } });
    const [r1, r2] = await Promise.all([postAck(A, cmd.id, { result: "done" }), postAck(A, cmd.id, { result: "failed" })]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const [j1, j2] = [await r1.json(), await r2.json()];
    expect(j1.result).toBe(j2.result);
    expect(j1.ackedAt).toBe(j2.ackedAt);
    expect(await auditsOf("COMMAND_ACKED", cmd.id)).toHaveLength(1);
  });

  it("accepts every result value, an expired-but-unacked command, and 404s unknown or foreign commands", async () => {
    const t = await fresh("ackres");
    for (const result of ["done", "player_not_found", "failed"]) {
      const c = await prisma.serverCommand.create({ data: { serverId: A.id, type: "kick", userId: t.id, expiresAt: new Date(Date.now() + 300_000) } });
      expect(await (await postAck(A, c.id, { result })).json()).toMatchObject({ ok: true, result });
    }
    const old = await prisma.serverCommand.create({ data: { serverId: A.id, type: "kick", userId: t.id, expiresAt: new Date(Date.now() - 60_000) } });
    expect((await postAck(A, old.id, { result: "failed" })).status).toBe(200);
    expect((await prisma.serverCommand.findUniqueOrThrow({ where: { id: old.id } })).result).toBe("failed");

    const foreign = await prisma.serverCommand.create({ data: { serverId: A.id, type: "kick", userId: t.id, expiresAt: new Date(Date.now() + 300_000) } });
    await expectError(await postAck(B, foreign.id, { result: "done" }), 404, "not_found");
    await expectError(await postAck(A, "nosuchcommand", { result: "done" }), 404, "not_found");
    expect((await prisma.serverCommand.findUniqueOrThrow({ where: { id: foreign.id } })).ackedAt).toBeNull();
    expect(await auditsOf("COMMAND_ACKED", foreign.id)).toHaveLength(0);
  });

  it("422s a bad body without touching the command", async () => {
    const t = await fresh("ackbad");
    const c = await prisma.serverCommand.create({ data: { serverId: A.id, type: "kick", userId: t.id, expiresAt: new Date(Date.now() + 300_000) } });
    for (const body of [{ result: "ok" }, {}, { result: "done", extra: 1 }, { result: 1 }, [], null, "done"]) {
      await expectError(await postAck(A, c.id, body), 422, "invalid_request");
    }
    await expectError(await postAck(A, c.id, undefined, { raw: "{nope" }), 422, "invalid_request");
    expect((await prisma.serverCommand.findUniqueOrThrow({ where: { id: c.id } })).ackedAt).toBeNull();
    expect(await auditsOf("COMMAND_ACKED", c.id)).toHaveLength(0);
  });
});

describe("POST /api/servers/{id}/bans (in-game /ban write-back)", () => {
  const body = (accountId: string, by: string, o: Record<string, unknown> = {}) => ({ accountId, byAccountId: by, reason: "griefing", durationMinutes: 60, ...o });

  it("creates a global ban: 201 shape, ban row, version bump, kicks on every active server, PLAYER_BANNED audit with source game", async () => {
    const t = await fresh("gb");
    const b0 = (await ver(A.id)).bansVersion;
    const ca = (await ver(A.id)).commandsVersion;
    const cb = (await ver(B.id)).commandsVersion;
    const res = await postBan(A, body(t.id, U.gaBan.id));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const out = await res.json();
    const row = await prisma.playerBan.findFirstOrThrow({ where: { userId: t.id } });
    expect(out).toEqual({ ban: { id: row.id, accountId: t.id, reason: "griefing", expiresAt: row.expiresAt!.toISOString(), scope: "global", createdAt: row.createdAt.toISOString() } });
    expect(row).toMatchObject({ serverId: null, createdById: U.gaBan.id, revokedAt: null });
    expect(Math.abs(row.expiresAt!.getTime() - Date.now() - 3_600_000)).toBeLessThan(15_000);
    expect((await ver(A.id)).bansVersion).toBe(b0 + 1);
    const kicks = await prisma.serverCommand.findMany({ where: { userId: t.id } });
    expect(kicks.map((c) => c.serverId).sort()).toEqual([...serverIds.filter((id) => id !== C.id)].filter((id) => kicks.some((k) => k.serverId === id)).sort());
    expect(kicks).toHaveLength(await activeServers());
    expect(kicks.every((c) => c.banId === row.id && c.reason === "griefing")).toBe(true);
    expect((await ver(A.id)).commandsVersion).toBe(ca + 1);
    expect((await ver(B.id)).commandsVersion).toBe(cb + 1);
    const [a] = await auditsOf("PLAYER_BANNED", t.id);
    expect(a).toMatchObject({ actorId: U.gaBan.id });
    expect(a.meta).toMatchObject({ source: "game", serverId: A.id, reason: "griefing", durationMinutes: 60, queuedKicks: kicks.length, expiresAt: row.expiresAt!.toISOString(), banId: row.id });
    expect(JSON.stringify(a.meta)).not.toContain("@");

    // null reason + null duration = permanent, kick reason "banned"
    const t2 = await fresh("gb");
    const res2 = await postBan(B, body(t2.id, U.owner.id, { reason: null, durationMinutes: null }));
    expect(res2.status).toBe(201);
    expect((await res2.json()).ban).toMatchObject({ reason: null, expiresAt: null, scope: "global" });
    expect((await prisma.serverCommand.findFirstOrThrow({ where: { userId: t2.id } })).reason).toBe("banned");
  });

  it("enforces the actor and target rules with 403 forbidden and creates nothing", async () => {
    const t = await fresh("gbt");
    const ga = await fresh("gbadmin", { powers: {} });
    for (const [target, by] of [
      [t.id, U.player.id], // actor not an admin
      [t.id, U.unver.id], // unverified game admin
      [t.id, U.site.id], // site admin with no env entry and no row: not on the roster
      [t.id, U.gaKick.id], // admin without the ban power
      [t.id, U.gaNone.id],
      [U.owner.id, U.gaBan.id], // target is the owner
      [U.owner.id, U.env.id],
      [U.owner.id, U.owner.id],
      [ga.id, U.gaBan.id], // admin bans admin
      [ga.id, U.env.id],
      [U.gaBan.id, U.gaBan.id], // self
      [t.id, "nosuchactor"],
    ]) {
      await expectError(await postBan(A, body(target, by)), 403, "forbidden");
    }
    expect(await prisma.playerBan.count({ where: { userId: { in: [t.id, ga.id, U.owner.id, U.gaBan.id] } } })).toBe(0);
    expect(await prisma.serverCommand.count({ where: { userId: { in: [t.id, ga.id, U.owner.id] } } })).toBe(0);
    expect(await auditsOf("PLAYER_BANNED", t.id)).toHaveLength(0);
  });

  it("lets the owner ban an admin, and rejects an unknown target with 422 unknown_account", async () => {
    const ga = await fresh("gbadm2", { powers: { kick: true } });
    const res = await postBan(A, body(ga.id, U.owner.id));
    expect(res.status).toBe(201);
    expect(await prisma.playerBan.count({ where: { userId: ga.id } })).toBe(1);
    await expectError(await postBan(A, body("nosuchaccount", U.owner.id)), 422, "unknown_account");
  });

  it("422s a bad body: missing keys, extras, bad types and bounds", async () => {
    const t = await fresh("gbbad");
    const ok = body(t.id, U.owner.id);
    const noReason = Object.fromEntries(Object.entries(ok).filter(([k]) => k !== "reason"));
    const noDuration = Object.fromEntries(Object.entries(ok).filter(([k]) => k !== "durationMinutes"));
    for (const bad of [noReason, noDuration, { ...ok, extra: 1 }, { ...ok, durationMinutes: 0 }, { ...ok, durationMinutes: 525_601 }, { ...ok, durationMinutes: 1.5 }, { ...ok, durationMinutes: "60" },
      { ...ok, reason: "" }, { ...ok, reason: "x".repeat(201) }, { ...ok, accountId: "" }, { ...ok, byAccountId: 5 }, [], null, "x"]) {
      await expectError(await postBan(A, bad), 422, "invalid_request");
    }
    await expectError(await postBan(A, undefined, { raw: "{nope" }), 422, "invalid_request");
    expect((await postBan(A, body(t.id, U.owner.id, { durationMinutes: 525_600 }))).status).toBe(201);
    expect(await prisma.playerBan.count({ where: { userId: t.id } })).toBe(1);
  });
});

describe("heartbeat: playerAccountIds and versions", () => {
  const rawBeat = (s: Server, body: unknown) =>
    heartbeat.POST(new NextRequest(new URL("/api/servers/heartbeat", BASE), { method: "POST", headers: { authorization: authOf(s), "content-type": "application/json" }, body: JSON.stringify(body) }));
  const base = (extra: Record<string, unknown> = {}, nonce = NONCE) => ({
    game_build: "0.59.1-linux", build_family: family, protocol_version: 3, server_runtime: "linux-x64", instance_nonce: nonce, players: 1, maxPlayers: 16, ...extra,
  });

  it("answers the old shape unchanged plus the three integer versions, matching the counters", async () => {
    const S = await makeServer();
    const res = await rawBeat(S, base());
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(Object.keys(out).sort()).toEqual(["bansVersion", "checkedAt", "commandsVersion", "maxPlayers", "ok", "rosterVersion"]);
    expect(out).toMatchObject({ ok: true, maxPlayers: 64 });
    for (const k of ["rosterVersion", "bansVersion", "commandsVersion"]) expect(Number.isInteger(out[k])).toBe(true);
    expect(out).toMatchObject(await ver(S.id));
    const t = await fresh("hbv");
    await postBan(S, { accountId: t.id, byAccountId: U.owner.id, reason: null, durationMinutes: null });
    await prisma.rateLimit.deleteMany({ where: { key: heartbeatKey(S.id) } });
    const after = await (await rawBeat(S, base())).json();
    expect(after.bansVersion).toBe(out.bansVersion + 1);
    expect(after.commandsVersion).toBe(out.commandsVersion + 1);
    expect(after.rosterVersion).toBe(out.rosterVersion);
    expect(await prisma.serverCommand.count({ where: { serverId: S.id, userId: t.id } })).toBe(1);
  });

  it("stores the list, leaves it alone when absent, clears it on a restart without it, and replaces it on restart with one", async () => {
    const S = await makeServer();
    const ids = [U.player.id, U.owner.id];
    expect((await rawBeat(S, base({ playerAccountIds: ids }))).status).toBe(200);
    const stored = await prisma.officialServer.findUniqueOrThrow({ where: { id: S.id } });
    expect(stored.onlinePlayerIds).toEqual(ids);
    expect(Date.now() - stored.onlinePlayersAt!.getTime()).toBeLessThan(10_000);

    await sleep(20);
    expect((await rawBeat(S, base())).status).toBe(200); // old server: same process, no field
    const same = await prisma.officialServer.findUniqueOrThrow({ where: { id: S.id } });
    expect(same.onlinePlayerIds).toEqual(ids);
    expect(same.onlinePlayersAt!.getTime()).toBe(stored.onlinePlayersAt!.getTime());

    expect((await rawBeat(S, base({ playerAccountIds: [] }))).status).toBe(200); // empty list is a report: zero players
    expect((await prisma.officialServer.findUniqueOrThrow({ where: { id: S.id } })).onlinePlayerIds).toEqual([]);
    await rawBeat(S, base({ playerAccountIds: ids }));
    expect((await rawBeat(S, base({}, "r".repeat(20)))).status).toBe(200); // restart without the field
    expect(await prisma.officialServer.findUniqueOrThrow({ where: { id: S.id } })).toMatchObject({ onlinePlayerIds: [], onlinePlayersAt: null });
    await rawBeat(S, base({ playerAccountIds: ids }, "s".repeat(20)));
    expect((await prisma.officialServer.findUniqueOrThrow({ where: { id: S.id } })).onlinePlayerIds).toEqual(ids);
  });

  it("400s an invalid list (duplicates, >64, bad format, wrong type) and keeps the stored one", async () => {
    const S = await makeServer();
    await rawBeat(S, base({ playerAccountIds: [U.player.id] }));
    const many = Array.from({ length: 65 }, (_, i) => `acc${i}`);
    for (const playerAccountIds of [[U.player.id, U.player.id], many, ["BAD"], [""], ["a".repeat(65)], [1], "x", null]) {
      await prisma.rateLimit.deleteMany({ where: { key: heartbeatKey(S.id) } });
      await expectError(await rawBeat(S, base({ playerAccountIds })), 400, "invalid_request");
    }
    expect((await prisma.officialServer.findUniqueOrThrow({ where: { id: S.id } })).onlinePlayerIds).toEqual([U.player.id]);
    await prisma.rateLimit.deleteMany({ where: { key: heartbeatKey(S.id) } });
    expect((await rawBeat(S, base({ playerAccountIds: many.slice(0, 64) }))).status).toBe(200);
  });

  it("accepts up to 16384 bytes of body, 400s above, and rate-limits at 12 per minute", async () => {
    const S = await makeServer();
    const raw = (n: number) => heartbeat.POST(new NextRequest(new URL("/api/servers/heartbeat", BASE), {
      method: "POST", headers: { authorization: authOf(S), "content-type": "application/json" }, body: JSON.stringify(base()) + " ".repeat(n),
    }));
    const size = JSON.stringify(base()).length;
    expect((await raw(16384 - size)).status).toBe(200);
    await expectError(await raw(16385 - size), 400, "invalid_request");
    await prisma.rateLimit.deleteMany({ where: { key: heartbeatKey(S.id) } });
    for (let i = 0; i < 12; i++) expect((await rawBeat(S, base())).status).toBe(200);
    const limited = await rawBeat(S, base());
    await expectError(limited, 429, "rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("ban enforcement", () => {
  it("join-ticket: a global or this-server ban gives entitled:false/banned, another server's ban does not; permanent is null", async () => {
    const g = await fresh("jg");
    const s = await fresh("js");
    const o = await fresh("jo");
    const exp = ((await banVia(g.id, { minutes: 30 })) as { ban: { expiresAt: Date } }).ban.expiresAt;
    await banVia(s.id, { serverId: A.id });
    await banVia(o.id, { serverId: B.id });

    const res = await doJoin(g, A);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entitled: false, reason: "banned", banExpiresAt: exp.toISOString() });
    expect(await (await doJoin(s, A)).json()).toEqual({ entitled: false, reason: "banned", banExpiresAt: null });
    expect(await (await doJoin(s, B)).json()).toMatchObject({ ticket: expect.any(String) }); // scoped to A only
    expect(await (await doJoin(o, A)).json()).toMatchObject({ ticket: expect.any(String) });
    expect(await prisma.joinTicket.count({ where: { userId: { in: [g.id] } } })).toBe(0);

    // Entitlement denials keep precedence: a banned account without a key still learns no_key.
    const nokey = await fresh("jnk");
    await prisma.redemption.deleteMany({ where: { userId: nokey.id } });
    await banVia(nokey.id);
    expect(await (await doJoin(nokey, A)).json()).toEqual({ entitled: false, reason: "no_key" });
  });

  it("join-ticket: an expired ban does not block, and unban restores access", async () => {
    const e = await fresh("je");
    await expiredBan(e.id);
    expect(await (await doJoin(e, A)).json()).toMatchObject({ ticket: expect.any(String) });
    const b = await fresh("jb");
    const made = (await banVia(b.id)) as { ban: { id: string } };
    expect(await (await doJoin(b, A)).json()).toMatchObject({ reason: "banned" });
    await prisma.rateLimit.deleteMany({ where: { key: launcherJoinAccountKey(b.id) } });
    await prisma.$transaction((tx) => mod.unban(tx, U.owner.id, made.ban.id));
    expect(await (await doJoin(b, A)).json()).toMatchObject({ ticket: expect.any(String) });
  });

  it("join-ticket: a ban committed under a held lock is seen (the decision waits for it)", async () => {
    const t = await fresh("jr");
    const res = await raceWith((tx) => mod.createBan(tx, { actorId: U.owner.id, targetId: t.id, reason: null, durationMinutes: null, serverId: null, source: "web" }), () => doJoin(t, A));
    expect(await res.json()).toMatchObject({ entitled: false, reason: "banned" });
  });

  it("admit: a banned account is denied banned with ADMIT_DENY, the ticket stays consumed, no session", async () => {
    const t = await fresh("ad");
    const tk = await makeTicket(t, A);
    const exp = ((await banVia(t.id, { minutes: 45 })) as { ban: { expiresAt: Date } }).ban.expiresAt;
    const res = await doAdmit(A, tk.ticket);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ admitted: false, reason: "banned" });
    expect((await prisma.joinTicket.findUniqueOrThrow({ where: { id: tk.id } })).usedAt).not.toBeNull();
    expect(await prisma.serverSession.count({ where: { userId: t.id } })).toBe(0);
    const [d] = await prisma.auditLog.findMany({ where: { action: "ADMIT_DENY", targetId: tk.id } });
    expect(d).toMatchObject({ actorId: t.id, meta: { reason: "banned", serverId: A.id, banExpiresAt: exp.toISOString() } });
    expect(await (await doAdmit(A, tk.ticket)).json()).toEqual({ admitted: false, reason: "ticket_used" }); // replay is a reuse, as for any denial
  });

  it("admit: a scoped ban on another server and an expired ban do not block; success still returns accountId and displayName", async () => {
    const o = await fresh("ao");
    await banVia(o.id, { serverId: B.id });
    await expiredBan(o.id, A.id);
    const tk = await makeTicket(o, A);
    const out = await (await doAdmit(A, tk.ticket)).json();
    expect(out).toEqual({ admitted: true, accountId: o.id, displayName: displayName(o.id), serverSessionId: expect.any(String) });
    const s = await fresh("as");
    await banVia(s.id, { serverId: A.id });
    expect(await (await doAdmit(A, (await makeTicket(s, A)).ticket)).json()).toEqual({ admitted: false, reason: "banned" });
  });

  it("admit: a ban committed under a held lock is seen", async () => {
    const t = await fresh("ar");
    const tk = await makeTicket(t, A);
    const res = await raceWith((tx) => mod.createBan(tx, { actorId: U.owner.id, targetId: t.id, reason: null, durationMinutes: null, serverId: null, source: "web" }), () => doAdmit(A, tk.ticket));
    expect(await res.json()).toEqual({ admitted: false, reason: "banned" });
    expect(await prisma.serverSession.count({ where: { userId: t.id } })).toBe(0);
  });

  it("sessions/check: an open session of a banned account is revoked with reason banned and audited; others are untouched; unban stops it", async () => {
    const t = await fresh("cb");
    const other = await fresh("cok");
    const s1 = await admitted(A, t);
    const s2 = await admitted(A, other);
    expect(await (await doCheck(A, [s1.sessionId, s2.sessionId])).json()).toMatchObject({ revoke: [] });

    const made = (await banVia(t.id, { serverId: A.id })) as { ban: { id: string } };
    const out = await (await doCheck(A, [s1.sessionId, s2.sessionId])).json();
    expect(out.revoke).toEqual([{ serverSessionId: s1.sessionId, reason: "banned" }]);
    expect(await prisma.serverSession.findUniqueOrThrow({ where: { id: s1.sessionId } })).toMatchObject({ endReason: "banned" });
    expect((await prisma.serverSession.findUniqueOrThrow({ where: { id: s1.sessionId } })).endedAt).not.toBeNull();
    expect((await prisma.serverSession.findUniqueOrThrow({ where: { id: s2.sessionId } })).endedAt).toBeNull();
    const kicks = await prisma.auditLog.findMany({ where: { action: "PLAYER_KICK", targetId: s1.sessionId } });
    expect(kicks).toHaveLength(1);
    expect(kicks[0]).toMatchObject({ actorId: t.id, meta: { serverId: A.id, reason: "banned" } });
    // the session is gone: later polls see it as unknown, never as a new revoke
    expect((await (await doCheck(A, [s1.sessionId])).json()).revoke).toEqual([{ serverSessionId: s1.sessionId, reason: "unknown_session" }]);
    await prisma.$transaction((tx) => mod.unban(tx, U.owner.id, made.ban.id));
    expect((await (await doCheck(A, [s2.sessionId])).json()).revoke).toEqual([]);
  });

  it("sessions/check: a ban scoped to another server and an expired ban leave a session alone", async () => {
    const t = await fresh("cs");
    const s = await admitted(A, t);
    await banVia(t.id, { serverId: B.id });
    await expiredBan(t.id);
    expect((await (await doCheck(A, [s.sessionId])).json()).revoke).toEqual([]);
  });
});

describe("misc contract checks", () => {
  it("never puts secrets or emails in any server-facing body", async () => {
    const bodies = [await (await getRoster(A)).text(), await (await getBans(A)).text(), await (await getCommands(A)).text()];
    for (const text of bodies) {
      expect(text).not.toContain("@");
      expect(text).not.toContain(A.secret);
      expect(text).not.toContain(sha256(A.secret));
    }
  });

  it("keeps every roster version bump in the same transaction as the change (promote then demote moves it by exactly 2)", async () => {
    const t = await fresh("rv");
    const v0 = (await ver(A.id)).rosterVersion;
    await web(adminsRoute, `${WEB}/admins`, U.owner.id, { email: t.email });
    await web(demoteRoute, `${WEB}/admins/x/demote`, U.owner.id, {}, { userId: t.id });
    expect((await ver(A.id)).rosterVersion).toBe(v0 + 2);
    expect(await getRoster(A).then((r) => r.json()).then((j) => j.version)).toBe(v0 + 2);
  });
});
