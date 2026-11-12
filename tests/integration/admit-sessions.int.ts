// Admit + sessions/check + sessions/end through the real route handlers against the Postgres at DATABASE_URL.
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.AUTH_URL ??= "http://localhost:3000";
process.env.AUTH_SECRET ??= randomBytes(32).toString("hex");
process.env.AUTH_TRUST_HOST ??= "true";

const { prisma } = await import("@/lib/db");
const { sha256 } = await import("@/lib/crypto");
const { SERVER_LIMITS, heartbeatKey } = await import("@/lib/servers");
const { windowStart } = await import("@/lib/rate-limit");
const heartbeat = await import("@/app/api/servers/heartbeat/route");
const admit = await import("@/app/api/servers/admit/route");
const check = await import("@/app/api/servers/sessions/check/route");
const end = await import("@/app/api/servers/sessions/end/route");

const BASE = process.env.AUTH_URL!;
const run = randomBytes(4).toString("hex");
const family = `fam-${run}`;
const batch = `admit-${run}`;
const emails: string[] = [];
const serverIds: string[] = [];
const userIds: string[] = [];
const NONCE = "n".repeat(20);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type User = { id: string; sessionId: string; email: string };
type Server = { id: string; secret: string };

async function makeUser(opts: { verified?: boolean; keys?: ("ACTIVE" | "REVOKED" | "ALPHA")[] } = {}): Promise<User> {
  const email = `ad-${run}-${emails.length}@example.test`;
  emails.push(email);
  const user = await prisma.user.create({ data: { email, passwordHash: "x", emailVerifiedAt: opts.verified === false ? null : new Date(Date.now() - 1000) } });
  userIds.push(user.id);
  let i = 0;
  for (const k of opts.keys ?? ["ACTIVE"]) {
    await prisma.accessKey.create({
      data: {
        codeHash: sha256(`${batch}-${email}-${i++}`), codePrefix: "TEST", tier: k === "ALPHA" ? "ALPHA" : "BETA", status: k === "REVOKED" ? "REVOKED" : "REDEEMED",
        batchLabel: batch, redemption: { create: { userId: user.id } },
      },
    });
  }
  const now = Date.now();
  const s = await prisma.nativeSession.create({
    data: { userId: user.id, clientId: "twaz-launcher", createdAt: new Date(now - 500), lastUsedAt: new Date(now), idleExpiresAt: new Date(now + 3600e3), absoluteExpiresAt: new Date(now + 7200e3) },
  });
  return { id: user.id, sessionId: s.id, email };
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

let conn = 1000;
async function makeTicket(u: User, s: Server, extra: Record<string, unknown> = {}) {
  const ticket = randomBytes(32).toString("base64url");
  const row = await prisma.joinTicket.create({
    data: {
      ticketHash: sha256(ticket), userId: u.id, nativeSessionId: u.sessionId, serverId: s.id, gameBuild: "0.59-win", buildFamily: family, protocolVersion: 3,
      clientPlatform: "win-x64", expiresAt: new Date(Date.now() + 60e3), ...extra,
    },
  });
  return { ticket, id: row.id };
}

type Route = { POST: (r: NextRequest) => Promise<Response> };
function post(route: Route, path: string, s: Server | null, body: unknown, opts: { raw?: string; auth?: string; type?: string } = {}) {
  const h = new Headers({ "content-type": opts.type ?? "application/json" });
  const auth = opts.auth ?? (s ? `TwazServer ${s.id}.${s.secret}` : null);
  if (auth) h.set("authorization", auth);
  return route.POST(new NextRequest(new URL(path, BASE), { method: "POST", headers: h, body: opts.raw ?? JSON.stringify(body) }));
}
const admitBody = (ticket: string, extra: Record<string, unknown> = {}) => ({
  ticket, instance_nonce: NONCE, connection_id: String(conn++), build_family: family, protocol_version: 3, game_build: "0.59-win", ...extra,
});
const doAdmit = (s: Server | null, body: unknown, o?: Parameters<typeof post>[4]) => post(admit, "/api/servers/admit", s, body, o);
const doCheck = (s: Server | null, ids: unknown, o?: Parameters<typeof post>[4]) => post(check, "/api/servers/sessions/check", s, { serverSessionIds: ids }, o);
const doEnd = (s: Server | null, id: string, reason = "client_left", o?: Parameters<typeof post>[4]) => post(end, "/api/servers/sessions/end", s, { serverSessionId: id, reason }, o);

async function admitted(s: Server, u: User) {
  const t = await makeTicket(u, s);
  const j = await (await doAdmit(s, admitBody(t.ticket))).json();
  expect(j.admitted).toBe(true);
  return { ...t, sessionId: j.serverSessionId as string };
}
async function denied(s: Server, body: unknown, reason: string) {
  const res = await doAdmit(s, body);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ admitted: false, reason });
}
async function expectError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("location")).toBeNull();
  expect(await res.json()).toEqual({ error });
}
const audits = (action: string, userId?: string) => prisma.auditLog.findMany({ where: { action, ...(userId ? { actorId: userId } : {}) }, orderBy: { at: "asc" } });
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

beforeEach(() => prisma.rateLimit.deleteMany({ where: { key: { in: serverIds.flatMap((id) => [`server-admit:${id}`, `server-check:${id}`, `server-end:${id}`]) } } }));

afterAll(async () => {
  await prisma.officialServer.deleteMany({ where: { id: { in: serverIds } } });
  await prisma.auditLog.deleteMany({ where: { OR: [
    { actorId: { in: userIds } },
    { targetId: { in: serverIds } },
    ...serverIds.map((serverId) => ({ meta: { path: ["serverId"], equals: serverId } })),
  ] } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.accessKey.deleteMany({ where: { batchLabel: batch } });
  await prisma.rateLimit.deleteMany({ where: { key: { in: serverIds.flatMap((id) => [`server-admit:${id}`, `server-check:${id}`, `server-end:${id}`, heartbeatKey(id)]) } } });
  await prisma.$disconnect();
});

describe("server credential on all three routes", () => {
  it("401s missing, wrong, cookie-only, rotated and disabled credentials and never reads cookies", async () => {
    const s = await makeServer();
    const u = await makeUser();
    const t = await makeTicket(u, s);
    const calls = (srv: Server | null, o: Parameters<typeof post>[4] = {}) => [
      doAdmit(srv, admitBody(t.ticket), o), doCheck(srv, ["x"], o), doEnd(srv, "x", "client_left", o),
    ];
    for (const res of await Promise.all([...calls(null), ...calls({ id: s.id, secret: "A".repeat(43) }), ...calls(null, { auth: `Bearer ${s.secret}` })])) {
      await expectError(res, 401, "invalid_server");
    }
    const h = new Headers({ "content-type": "application/json", cookie: "authjs.session-token=x" });
    await expectError(await admit.POST(new NextRequest(new URL("/api/servers/admit", BASE), { method: "POST", headers: h, body: "{}" })), 401, "invalid_server");

    const old = { ...s };
    await prisma.officialServer.update({ where: { id: s.id }, data: { secretHash: sha256(randomBytes(32).toString("base64url")) } });
    for (const res of await Promise.all(calls(old))) await expectError(res, 401, "invalid_server");
    await prisma.officialServer.update({ where: { id: s.id }, data: { secretHash: sha256(s.secret), status: "DISABLED" } });
    for (const res of await Promise.all(calls(s))) await expectError(res, 401, "invalid_server");
    // 401s consumed nothing.
    expect((await prisma.joinTicket.findUnique({ where: { id: t.id } }))!.usedAt).toBeNull();
    expect(await prisma.rateLimit.count({ where: { key: { startsWith: `server-admit:${s.id}` } } })).toBe(0);
  });

  it("rechecks credentials after waiting for rotation on all three routes", async () => {
    for (const kind of ["admit", "check", "end"] as const) {
      const srv = await makeServer();
      const u = await makeUser();
      const a = await admitted(srv, u);
      const spare = await makeTicket(u, srv);
      const call = () => kind === "admit" ? doAdmit(srv, admitBody(spare.ticket)) : kind === "check" ? doCheck(srv, [a.sessionId]) : doEnd(srv, a.sessionId);
      const res = await raceWith((tx) => tx.officialServer.update({ where: { id: srv.id }, data: { secretHash: sha256(randomBytes(32).toString("base64url")) } }), call);
      await expectError(res, 401, "invalid_server");
      expect((await prisma.serverSession.findUniqueOrThrow({ where: { id: a.sessionId } })).endedAt).toBeNull();
      expect((await prisma.joinTicket.findUniqueOrThrow({ where: { id: spare.id } })).usedAt).toBeNull();
    }
  });

  it("rate limits after the credential check with a positive Retry-After", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      const s = await makeServer();
      for (const [kind, call] of [["admit", () => doAdmit(s, admitBody("t"))], ["check", () => doCheck(s, [])], ["end", () => doEnd(s, "x")]] as const) {
        const { limit, windowMs } = SERVER_LIMITS[kind];
        await prisma.rateLimit.create({ data: { key: `server-${kind}:${s.id}`, windowStart: windowStart(Date.now(), windowMs), count: limit } });
        const res = await call();
        await expectError(res.clone(), 429, "rate_limited");
        expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      }
      // A bad credential is rejected before it can burn the real server's budget.
      const before = await prisma.rateLimit.findUnique({ where: { key: `server-admit:${s.id}` } });
      await doAdmit({ id: s.id, secret: "B".repeat(43) }, admitBody("t"));
      expect((await prisma.rateLimit.findUnique({ where: { key: `server-admit:${s.id}` } }))!.count).toBe(before!.count);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("request shape", () => {
  it("rejects bad content type, oversize, bad JSON, extra/missing/ill-typed fields; 405 elsewhere", async () => {
    const s = await makeServer();
    const ok = admitBody("t");
    const bads: [Promise<Response>][] = [
      [doAdmit(s, ok, { type: "text/plain" })], [doAdmit(s, null, { raw: "{" })], [doAdmit(s, null, { raw: " ".repeat(3000) + JSON.stringify(ok) })],
      [doAdmit(s, { ...ok, extra: 1 })], [doAdmit(s, { ...ok, connection_id: 7 })], [doAdmit(s, { ...ok, connection_id: "-1" })],
      [doAdmit(s, { ...ok, connection_id: "18446744073709551616" })], [doAdmit(s, { ...ok, connection_id: "1".repeat(21) })],
      [doAdmit(s, { ...ok, instance_nonce: "short" })], [doAdmit(s, { ...ok, protocol_version: "3" })], [doAdmit(s, { ...ok, ticket: "t".repeat(257) })],
      [doAdmit(s, { ...ok, ticket: undefined })], [doAdmit(s, [ok])],
      [doCheck(s, "x")], [doCheck(s, Array.from({ length: 257 }, (_, i) => `id${i}`))], [doCheck(s, ["bad id"])], [doCheck(s, [1])],
      [post(check, "/api/servers/sessions/check", s, { serverSessionIds: [], more: 1 })],
      [doEnd(s, "x", "has space")], [doEnd(s, "x", "")], [doEnd(s, "x", "r".repeat(65))], [doEnd(s, "")], [post(end, "/api/servers/sessions/end", s, { serverSessionId: "x" })],
    ];
    for (const [p] of bads) await expectError(await p, 400, "invalid_request");
    expect((await doCheck(s, Array.from({ length: 256 }, (_, i) => `id${i}`))).status).toBe(200);
    for (const route of [admit, check, end]) {
      for (const m of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
        const res = await (route as unknown as Record<string, () => Response>)[m]();
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("POST");
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.json()).toEqual({ error: "method_not_allowed" });
      }
    }
  });
});

describe("admit", () => {
  it("admits an entitled account (any active key, ALPHA or BETA) once and records everything", async () => {
    const s = await makeServer();
    for (const keys of [["ACTIVE"], ["ALPHA"], ["REVOKED", "ACTIVE"]] as const) {
      const u = await makeUser({ keys: [...keys] });
      const t = await makeTicket(u, s);
      const body = admitBody(t.ticket);
      const res = await doAdmit(s, body);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const j = await res.json();
      expect(j).toEqual({ admitted: true, accountId: u.id, displayName: expect.stringMatching(/^Player-[0-9a-f]{8}$/), serverSessionId: expect.any(String) });
      expect(JSON.stringify(j)).not.toContain(u.email);
      const ss = await prisma.serverSession.findUniqueOrThrow({ where: { id: j.serverSessionId } });
      expect(ss).toMatchObject({ serverId: s.id, userId: u.id, ticketId: t.id, instanceNonce: NONCE, connectionId: body.connection_id, endedAt: null });
      expect((await prisma.joinTicket.findUniqueOrThrow({ where: { id: t.id } })).usedByConnection).toBe(`${NONCE}:${body.connection_id}`);
      const [ok] = await audits("ADMIT_OK", u.id);
      expect(ok).toMatchObject({ targetId: j.serverSessionId });
      expect(JSON.stringify(ok.meta)).not.toContain(t.ticket);
    }
  });

  it("denies no_key, unverified, session_revoked (revoked, idle-expired, absolute-expired, password changed) and audits each; the ticket is spent", async () => {
    const s = await makeServer();
    const cases: [string, User, () => Promise<unknown>][] = [];
    const add = async (reason: string, u: User, mutate: () => Promise<unknown> = async () => {}) => cases.push([reason, u, mutate]);
    await add("no_key", await makeUser({ keys: ["REVOKED", "REVOKED"] }));
    await add("no_key", await makeUser({ keys: [] }));
    await add("unverified", await makeUser({ verified: false }));
    await add("unverified", await makeUser({ verified: false, keys: [] }));
    const r = await makeUser();
    await add("session_revoked", r, () => prisma.nativeSession.update({ where: { id: r.sessionId }, data: { revokedAt: new Date(), revokeReason: "logout" } }));
    const i = await makeUser();
    await add("session_revoked", i, () => prisma.nativeSession.update({ where: { id: i.sessionId }, data: { idleExpiresAt: new Date(Date.now() - 1000) } }));
    const a = await makeUser();
    await add("session_revoked", a, () => prisma.nativeSession.update({ where: { id: a.sessionId }, data: { absoluteExpiresAt: new Date(Date.now() - 1000) } }));
    const p = await makeUser();
    await add("session_revoked", p, () => prisma.user.update({ where: { id: p.id }, data: { passwordChangedAt: new Date() } }));
    for (const [reason, u, mutate] of cases) {
      const t = await makeTicket(u, s);
      await mutate();
      await denied(s, admitBody(t.ticket), reason);
      expect((await prisma.joinTicket.findUniqueOrThrow({ where: { id: t.id } })).usedAt).not.toBeNull();
      expect(await prisma.serverSession.count({ where: { ticketId: t.id } })).toBe(0);
      const logs = await audits("ADMIT_DENY", u.id);
      expect(logs.at(-1)!.meta).toMatchObject({ reason, serverId: s.id });
      expect(JSON.stringify(logs.at(-1)!.meta)).not.toContain(t.ticket);
    }
  });

  it("accepts a password changed BEFORE the session was created", async () => {
    const s = await makeServer();
    const u = await makeUser();
    await prisma.user.update({ where: { id: u.id }, data: { passwordChangedAt: new Date(Date.now() - 60e3) } });
    await admitted(s, u);
  });

  it("handles forged, unknown-server, expired and reused tickets", async () => {
    const s = await makeServer();
    const other = await makeServer();
    const u = await makeUser();
    await denied(s, admitBody(randomBytes(32).toString("base64url")), "ticket_invalid");
    await denied(s, admitBody("not-a-ticket"), "ticket_invalid");

    const foreign = await makeTicket(u, other);
    await denied(s, admitBody(foreign.ticket), "wrong_server");
    expect((await prisma.joinTicket.findUniqueOrThrow({ where: { id: foreign.id } })).usedAt).toBeNull(); // not burned by the wrong server

    const old = await makeTicket(u, s, { expiresAt: new Date(Date.now() - 1000) });
    await denied(s, admitBody(old.ticket), "ticket_expired");
    expect((await prisma.joinTicket.findUniqueOrThrow({ where: { id: old.id } })).usedAt).toBeNull();

    const t = await makeTicket(u, s);
    const first = await doAdmit(s, admitBody(t.ticket));
    expect((await first.json()).admitted).toBe(true);
    await denied(s, admitBody(t.ticket), "ticket_used");
    const reuse = await audits("TICKET_REUSE", u.id);
    expect(reuse).toHaveLength(1);
    expect(reuse[0]).toMatchObject({ targetId: t.id });
    expect((await audits("ADMIT_DENY", u.id)).map((a) => (a.meta as { reason: string }).reason)).toEqual(expect.arrayContaining(["ticket_expired", "wrong_server", "ticket_used"]));
    // A reused ticket is spent even if it has since expired; reuse takes precedence even for a foreign server or stale/mismatched call.
    await prisma.joinTicket.update({ where: { id: t.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await denied(s, admitBody(t.ticket), "ticket_used");
    await denied(other, admitBody(t.ticket), "ticket_used");
    await denied(s, admitBody(t.ticket, { instance_nonce: "z".repeat(20), protocol_version: 4 }), "ticket_used");
  });

  it("spends a stale-instance ticket and denies a reused connection id", async () => {
    const s = await makeServer();
    const u = await makeUser();
    const t = await makeTicket(u, s);
    await denied(s, admitBody(t.ticket, { instance_nonce: "z".repeat(20) }), "stale_instance");
    expect((await prisma.joinTicket.findUniqueOrThrow({ where: { id: t.id } })).usedAt).not.toBeNull();
    await denied(s, admitBody(t.ticket), "ticket_used");
    const fresh = await makeTicket(u, s);
    const b = admitBody(fresh.ticket);
    expect((await (await doAdmit(s, b)).json()).admitted).toBe(true);
    const t2 = await makeTicket(u, s);
    await denied(s, admitBody(t2.ticket, { connection_id: b.connection_id }), "ticket_invalid");
    // Same connection id under a new instance is fine.
    await prisma.officialServer.update({ where: { id: s.id }, data: { instanceNonce: "q".repeat(20) } });
    const t3 = await makeTicket(u, s);
    expect((await (await doAdmit(s, admitBody(t3.ticket, { instance_nonce: "q".repeat(20), connection_id: b.connection_id }))).json()).admitted).toBe(true);
  });

  it("denies and spends current/ticket-bound build mismatches; game_build is informational", async () => {
    const s = await makeServer();
    const u = await makeUser();
    const t = await makeTicket(u, s);
    await denied(s, admitBody(t.ticket, { build_family: "other" }), "build_mismatch");
    expect((await prisma.joinTicket.findUniqueOrThrow({ where: { id: t.id } })).usedAt).not.toBeNull();
    const proto = await makeTicket(u, s);
    await denied(s, admitBody(proto.ticket, { protocol_version: 4 }), "build_mismatch");
    const info = await makeTicket(u, s);
    expect((await (await doAdmit(s, admitBody(info.ticket, { game_build: "totally-different-os-build" }))).json()).admitted).toBe(true);

    const bound = await makeTicket(u, s, { buildFamily: "old-family" });
    await denied(s, admitBody(bound.ticket), "build_mismatch");
    expect((await prisma.joinTicket.findUniqueOrThrow({ where: { id: bound.id } })).usedAt).not.toBeNull();
    const boundProto = await makeTicket(u, s, { protocolVersion: 2 });
    await denied(s, admitBody(boundProto.ticket), "build_mismatch");
    // Server redeploy changes registered values: stale tickets die.
    await prisma.officialServer.update({ where: { id: s.id }, data: { protocolVersion: 4 } });
    const stale = await makeTicket(u, s);
    await denied(s, admitBody(stale.ticket, { protocol_version: 4 }), "build_mismatch");
  });

  it("admits against family and protocol adopted by a new-process heartbeat", async () => {
    const s = await makeServer();
    const u = await makeUser();
    const newFamily = `${family}-next`;
    const newNonce = "m".repeat(20);
    const hb = await heartbeat.POST(new NextRequest(new URL("/api/servers/heartbeat", BASE), {
      method: "POST",
      headers: new Headers({ authorization: `TwazServer ${s.id}.${s.secret}`, "content-type": "application/json" }),
      body: JSON.stringify({
        game_build: "0.60-linux", build_family: newFamily, protocol_version: 4, server_runtime: "linux-x64",
        instance_nonce: newNonce, players: 0, maxPlayers: 16,
      }),
    }));
    expect(hb.status).toBe(200);
    expect(await prisma.officialServer.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({
      buildFamily: newFamily, protocolVersion: 4, instanceNonce: newNonce,
    });

    const stale = await makeTicket(u, s);
    await denied(s, admitBody(stale.ticket, { instance_nonce: newNonce, build_family: newFamily, protocol_version: 4 }), "build_mismatch");
    const t = await makeTicket(u, s, { buildFamily: newFamily, protocolVersion: 4 });
    const res = await doAdmit(s, admitBody(t.ticket, { instance_nonce: newNonce, build_family: newFamily, protocol_version: 4 }));
    expect(res.status).toBe(200);
    expect((await res.json()).admitted).toBe(true);
  });

  it("rejects a ticket that expires while waiting for the server lock", async () => {
    const srv = await makeServer();
    const u = await makeUser();
    const t = await makeTicket(u, srv, { expiresAt: new Date(Date.now() + 200) });
    await denied(srv, admitBody((await makeTicket(u, srv, { expiresAt: new Date(Date.now() - 1) })).ticket), "ticket_expired");
    const res = await raceWith((tx) => tx.$queryRaw`SELECT 1 FROM "OfficialServer" WHERE "id" = ${srv.id} FOR UPDATE`, () => doAdmit(srv, admitBody(t.ticket)));
    expect(await res.json()).toEqual({ admitted: false, reason: "ticket_expired" });
    expect((await prisma.joinTicket.findUniqueOrThrow({ where: { id: t.id } })).usedAt).toBeNull();
  });

  it("lets exactly one of many concurrent admits of the same ticket win", async () => {
    const s = await makeServer();
    const u = await makeUser();
    const t = await makeTicket(u, s);
    const results = await Promise.all(Array.from({ length: 8 }, () => doAdmit(s, admitBody(t.ticket)).then((r) => r.json())));
    expect(results.filter((r) => r.admitted)).toHaveLength(1);
    expect(results.filter((r) => !r.admitted && r.reason === "ticket_used")).toHaveLength(7);
    expect(await prisma.serverSession.count({ where: { ticketId: t.id } })).toBe(1);
    expect(await audits("ADMIT_OK", u.id)).toHaveLength(1);
    expect(await audits("TICKET_REUSE", u.id)).toHaveLength(7);
    expect(await audits("ADMIT_DENY", u.id)).toHaveLength(7);
  });

  it("rolls the whole admit back (ticket unspent, no session) if its audit write fails, and logs nothing sensitive", async () => {
    const s = await makeServer();
    const u = await makeUser();
    const t = await makeTicket(u, s);
    const orig = prisma.$transaction.bind(prisma);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce(((fn: (tx: object) => Promise<unknown>, o: unknown) =>
      orig((tx) => fn(new Proxy(tx, { get: (x, p) => (p === "auditLog" ? { create: () => Promise.reject(new Error(`audit down ${t.ticket}`)) } : Reflect.get(x, p)) })), o as never)) as never);
    const res = await doAdmit(s, admitBody(t.ticket));
    spy.mockRestore();
    await expectError(res, 500, "server_error");
    const logged = JSON.stringify(err.mock.calls);
    err.mockRestore();
    expect(logged).not.toContain(t.ticket);
    expect(logged).not.toContain(s.secret);
    expect((await prisma.joinTicket.findUniqueOrThrow({ where: { id: t.id } })).usedAt).toBeNull();
    expect(await prisma.serverSession.count({ where: { ticketId: t.id } })).toBe(0);
    expect((await (await doAdmit(s, admitBody(t.ticket))).json()).admitted).toBe(true);
  });

  it("serializes with revocations that committed first: key revoke, native revoke, password change, disable, heartbeat restart", async () => {
    const s = await makeServer();
    const lockKey = (u: User) => (t: Parameters<Parameters<typeof raceWith>[0]>[0]) =>
      t.$queryRaw`SELECT 1 FROM "AccessKey" k JOIN "Redemption" r ON r."keyId" = k."id" WHERE r."userId" = ${u.id} FOR UPDATE OF k`.then(() =>
        t.accessKey.updateMany({ where: { redemption: { userId: u.id } }, data: { status: "REVOKED" } }));

    const k = await makeUser(); const kt = await makeTicket(k, s);
    expect(await (await raceWith(lockKey(k), () => doAdmit(s, admitBody(kt.ticket)))).json()).toEqual({ admitted: false, reason: "no_key" });

    const n = await makeUser(); const nt = await makeTicket(n, s);
    expect(await (await raceWith((t) => t.$queryRaw`SELECT 1 FROM "NativeSession" WHERE "id" = ${n.sessionId} FOR UPDATE`.then(() =>
      t.nativeSession.update({ where: { id: n.sessionId }, data: { revokedAt: new Date() } })), () => doAdmit(s, admitBody(nt.ticket)))).json()).toEqual({ admitted: false, reason: "session_revoked" });

    const p = await makeUser(); const pt = await makeTicket(p, s);
    expect(await (await raceWith(async (t) => {
      await t.user.update({ where: { id: p.id }, data: { passwordChangedAt: new Date() } });
      await t.nativeSession.update({ where: { id: p.sessionId }, data: { revokedAt: new Date(), revokeReason: "password_changed" } });
    }, () => doAdmit(s, admitBody(pt.ticket)))).json())
      .toEqual({ admitted: false, reason: "session_revoked" });

    const hb = await makeUser(); const hbt = await makeTicket(hb, s);
    expect(await (await raceWith((t) => t.officialServer.update({ where: { id: s.id }, data: { instanceNonce: "r".repeat(20) } }), () => doAdmit(s, admitBody(hbt.ticket)))).json())
      .toEqual({ admitted: false, reason: "stale_instance" });
    expect((await prisma.joinTicket.findUniqueOrThrow({ where: { id: hbt.id } })).usedAt).not.toBeNull();

    const d = await makeServer(); const du = await makeUser(); const dt = await makeTicket(du, d);
    await expectError(await raceWith((t) => t.officialServer.update({ where: { id: d.id }, data: { status: "DISABLED" } }), () => doAdmit(d, admitBody(dt.ticket))), 401, "invalid_server");
    expect((await prisma.joinTicket.findUniqueOrThrow({ where: { id: dt.id } })).usedAt).toBeNull();
  });
});

describe("sessions/check", () => {
  it("confirms live sessions and answers unknown, foreign and ended ids identically without mutating", async () => {
    const s = await makeServer();
    const other = await makeServer();
    const u = await makeUser();
    const mine = await admitted(s, u);
    const theirs = await admitted(other, await makeUser());
    const ended = await admitted(s, await makeUser());
    await doEnd(s, ended.sessionId);

    const res = await doCheck(s, [mine.sessionId, theirs.sessionId, ended.sessionId, "doesnotexist"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const j = await res.json();
    expect(j.revoke).toEqual([theirs.sessionId, ended.sessionId, "doesnotexist"].map((serverSessionId) => ({ serverSessionId, reason: "unknown_session" })));
    expect(new Date(j.checkedAt).toISOString()).toBe(j.checkedAt);
    expect((await prisma.serverSession.findUniqueOrThrow({ where: { id: theirs.sessionId } })).endedAt).toBeNull();
    expect((await prisma.serverSession.findUniqueOrThrow({ where: { id: mine.sessionId } })).endedAt).toBeNull();
    expect(await (await doCheck(s, [])).json()).toMatchObject({ revoke: [] });
  });

  it("dedupes ids: each requested id appears at most once, only requested ids appear", async () => {
    const s = await makeServer();
    const u = await makeUser({ keys: ["ACTIVE"] });
    const a = await admitted(s, u);
    await prisma.accessKey.updateMany({ where: { redemption: { userId: u.id } }, data: { status: "REVOKED" } });
    const j = await (await doCheck(s, [a.sessionId, "zz", a.sessionId, "zz"])).json();
    expect(j.revoke).toEqual([{ serverSessionId: a.sessionId, reason: "key_revoked" }, { serverSessionId: "zz", reason: "unknown_session" }]);
  });

  it("ends and audits sessions that lost access with the right reason, idempotently", async () => {
    const s = await makeServer();
    const mk = async (u: User, mutate: () => Promise<unknown>, reason: string) => ({ u, a: await admitted(s, u), mutate, reason });
    const k = await makeUser(); const n = await makeUser(); const p = await makeUser(); const v = await makeUser(); const both = await makeUser();
    const rows = [
      await mk(k, () => prisma.accessKey.updateMany({ where: { redemption: { userId: k.id } }, data: { status: "REVOKED" } }), "key_revoked"),
      await mk(n, () => prisma.nativeSession.update({ where: { id: n.sessionId }, data: { revokedAt: new Date(), revokeReason: "logout" } }), "session_revoked"),
      await mk(p, () => prisma.user.update({ where: { id: p.id }, data: { passwordChangedAt: new Date() } }), "password_changed"),
      await mk(v, () => prisma.user.update({ where: { id: v.id }, data: { emailVerifiedAt: null } }), "unverified"),
      // Precedence: password_changed > session_revoked > unverified > key_revoked; a real reset revokes the session AND changes the password.
      await mk(both, () => Promise.all([
        prisma.user.update({ where: { id: both.id }, data: { passwordChangedAt: new Date(), emailVerifiedAt: null } }),
        prisma.nativeSession.update({ where: { id: both.sessionId }, data: { revokedAt: new Date() } }),
        prisma.accessKey.updateMany({ where: { redemption: { userId: both.id } }, data: { status: "REVOKED" } }),
      ]), "password_changed"),
    ];
    const keep = await admitted(s, await makeUser());
    for (const r of rows) await r.mutate();
    const ids = [...rows.map((r) => r.a.sessionId), keep.sessionId];
    const j = await (await doCheck(s, ids)).json();
    expect(j.revoke).toEqual(rows.map((r) => ({ serverSessionId: r.a.sessionId, reason: r.reason })));
    for (const r of rows) {
      expect(await prisma.serverSession.findUniqueOrThrow({ where: { id: r.a.sessionId } })).toMatchObject({ endReason: r.reason });
      expect((await prisma.serverSession.findUniqueOrThrow({ where: { id: r.a.sessionId } })).endedAt).not.toBeNull();
      const kick = (await audits("PLAYER_KICK", r.u.id)).filter((x) => x.targetId === r.a.sessionId);
      expect(kick).toHaveLength(1);
      expect(kick[0].meta).toMatchObject({ reason: r.reason, serverId: s.id });
    }
    expect((await prisma.serverSession.findUniqueOrThrow({ where: { id: keep.sessionId } })).endedAt).toBeNull();
    // Idempotent: the sessions are ended, so now unknown_session, with no new audit rows.
    const again = await (await doCheck(s, ids)).json();
    expect(again.revoke).toEqual(rows.map((r) => ({ serverSessionId: r.a.sessionId, reason: "unknown_session" })));
    expect(await prisma.auditLog.count({ where: { action: "PLAYER_KICK", targetId: { in: ids } } })).toBe(rows.length);
  });

  it("keeps a player with any remaining active key, and honors a revoke that committed first", async () => {
    const s = await makeServer();
    const u = await makeUser({ keys: ["ACTIVE", "ACTIVE"] });
    const a = await admitted(s, u);
    const [first] = await prisma.redemption.findMany({ where: { userId: u.id } });
    await prisma.accessKey.update({ where: { id: first.keyId }, data: { status: "REVOKED" } });
    expect((await (await doCheck(s, [a.sessionId])).json()).revoke).toEqual([]);

    const r = await makeUser(); const ra = await admitted(s, r);
    const j = await (await raceWith((t) => t.$queryRaw`SELECT 1 FROM "AccessKey" k JOIN "Redemption" x ON x."keyId" = k."id" WHERE x."userId" = ${r.id} FOR UPDATE OF k`.then(() =>
      t.accessKey.updateMany({ where: { redemption: { userId: r.id } }, data: { status: "REVOKED" } })), () => doCheck(s, [ra.sessionId]))).json();
    expect(j.revoke).toEqual([{ serverSessionId: ra.sessionId, reason: "key_revoked" }]);
  });

  it("does not deadlock with native refresh's session-then-user lock order", async () => {
    const srv = await makeServer();
    const u = await makeUser();
    const a = await admitted(srv, u);
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    let proceed!: () => void;
    const continueRefresh = new Promise<void>((resolve) => { proceed = resolve; });
    const refresh = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "NativeSession" WHERE "id" = ${u.sessionId} FOR UPDATE`;
      locked();
      await continueRefresh;
      await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${u.id} FOR UPDATE`;
      await tx.nativeSession.update({ where: { id: u.sessionId }, data: { lastUsedAt: new Date() } });
    }, { timeout: 5_000 });
    await ready;
    const pending = doCheck(srv, [a.sessionId]);
    await sleep(300);
    proceed();
    await refresh;
    const res = await pending;
    expect(res.status).toBe(200);
    expect((await res.json()).revoke).toEqual([]);
  });

  it("sees a real password-reset transaction committed while a check waits", async () => {
    const srv = await makeServer();
    const u = await makeUser();
    const a = await admitted(srv, u);
    const res = await raceWith(async (tx) => {
      await tx.user.update({ where: { id: u.id }, data: { passwordChangedAt: new Date() } });
      await tx.nativeSession.update({ where: { id: u.sessionId }, data: { revokedAt: new Date(), revokeReason: "password_changed" } });
    }, () => doCheck(srv, [a.sessionId]));
    expect((await res.json()).revoke).toEqual([{ serverSessionId: a.sessionId, reason: "password_changed" }]);
    expect((await prisma.serverSession.findUniqueOrThrow({ where: { id: a.sessionId } })).endReason).toBe("password_changed");
  });

  it("rolls session endings back if the kick audit write fails", async () => {
    const srv = await makeServer();
    const u = await makeUser();
    const a = await admitted(srv, u);
    await prisma.accessKey.updateMany({ where: { redemption: { userId: u.id } }, data: { status: "REVOKED" } });
    const real = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce(((fn: (tx: object) => Promise<unknown>, opts: unknown) =>
      real((tx) => fn(new Proxy(tx, { get: (target, key) => key === "auditLog" ? { createMany: () => Promise.reject(new Error("audit unavailable")) } : Reflect.get(target, key) })), opts as never)) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await doCheck(srv, [a.sessionId]);
    spy.mockRestore();
    error.mockRestore();
    await expectError(res, 500, "server_error");
    expect((await prisma.serverSession.findUniqueOrThrow({ where: { id: a.sessionId } })).endedAt).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "PLAYER_KICK", targetId: a.sessionId } })).toBe(0);
    expect((await (await doCheck(srv, [a.sessionId])).json()).revoke).toEqual([{ serverSessionId: a.sessionId, reason: "key_revoked" }]);
  });

  it("does not resurrect sessions ended by a heartbeat restart", async () => {
    const s = await makeServer();
    const a = await admitted(s, await makeUser());
    await prisma.serverSession.updateMany({ where: { id: a.sessionId }, data: { endedAt: new Date(), endReason: "server_restart" } });
    expect((await (await doCheck(s, [a.sessionId])).json()).revoke).toEqual([{ serverSessionId: a.sessionId, reason: "unknown_session" }]);
    expect((await prisma.serverSession.findUniqueOrThrow({ where: { id: a.sessionId } })).endReason).toBe("server_restart");
  });
});

describe("sessions/end", () => {
  it("ends only the caller's open sessions, idempotently, without foreign mutation or disclosure", async () => {
    const s = await makeServer();
    const other = await makeServer();
    const mine = await admitted(s, await makeUser());
    const theirs = await admitted(other, await makeUser());
    const res = await doEnd(s, mine.sessionId, "server_shutdown");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
    const row = await prisma.serverSession.findUniqueOrThrow({ where: { id: mine.sessionId } });
    expect(row.endReason).toBe("server_shutdown");
    // Second end (even with another reason) and unknown ids are the same {ok:true} and keep the first reason.
    expect(await (await doEnd(s, mine.sessionId, "client_left")).json()).toEqual({ ok: true });
    expect(await (await doEnd(s, "doesnotexist")).json()).toEqual({ ok: true });
    expect((await prisma.serverSession.findUniqueOrThrow({ where: { id: mine.sessionId } })).endedAt).toEqual(row.endedAt);
    expect((await prisma.serverSession.findUniqueOrThrow({ where: { id: mine.sessionId } })).endReason).toBe("server_shutdown");
    expect(await (await doEnd(s, theirs.sessionId)).json()).toEqual({ ok: true });
    expect(await prisma.serverSession.findUniqueOrThrow({ where: { id: theirs.sessionId } })).toMatchObject({ endedAt: null, endReason: null });
  });
});

describe("failure handling", () => {
  it("returns JSON 500 and logs only the error name when the database fails", async () => {
    const s = await makeServer();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValue(new Error(`boom ${s.secret}`));
    const res = [await doAdmit(s, admitBody("t")), await doCheck(s, ["a"]), await doEnd(s, "a")];
    spy.mockRestore();
    const logged = JSON.stringify(err.mock.calls);
    err.mockRestore();
    for (const r of res) await expectError(r, 500, "server_error");
    expect(logged).not.toContain(s.secret);
  });
});
