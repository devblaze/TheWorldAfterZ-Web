// Bug-report grants + upload + admin viewer against the Postgres at DATABASE_URL.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.AUTH_URL ??= "http://localhost:3000";
process.env.AUTH_SECRET ??= randomBytes(32).toString("hex");
process.env.AUTH_TRUST_HOST ??= "true";
if (!process.env.LAUNCHER_TOKEN_SECRET || Buffer.byteLength(process.env.LAUNCHER_TOKEN_SECRET) < 32) {
  process.env.LAUNCHER_TOKEN_SECRET = randomBytes(32).toString("base64url");
}
const storageDir = await mkdtemp(path.join("/var/tmp", "twaz-bug-reports-test-"));
process.env.BUG_REPORT_STORAGE_DIR = storageDir;

const run = randomBytes(4).toString("hex");
let actor: string | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: { id: actor }, issuedPwdAt: 0 } : null) }));

const { prisma } = await import("@/lib/db");
const { sha256, displayName } = await import("@/lib/crypto");
const { signAccessToken } = await import("@/lib/launcher/jwt");
const { bugReportGrantAccountKey } = await import("@/lib/rate-limit");
const { REPORTS_PER_HOUR } = await import("@/lib/bug-reports");
const { sweepExpiredBugReports } = await import("@/lib/bug-report-sweep");
const {
  STORAGE_CHECK_RETRY_AFTER_SEC, bugReportStorageBannerText, resetBugReportStorageCheck,
} = await import("@/lib/bug-report-storage");
const { register } = await import("@/instrumentation");
const grants = await import("@/app/api/bug-reports/grants/route");
const uploads = await import("@/app/api/bug-reports/route");
const replayRoute = await import("@/app/api/admin/bug-reports/[id]/replay/route");
const shotRoute = await import("@/app/api/admin/bug-reports/[id]/screenshots/[index]/route");
const ListPage = (await import("@/app/admin/bug-reports/page")).default;
const DetailPage = (await import("@/app/admin/bug-reports/[id]/page")).default;

const BASE = process.env.AUTH_URL!;
const batch = `bug-${run}`;
const emails: string[] = [];
const userIds: string[] = [];

type User = { id: string; email: string; token: string };

async function makeUser(opts: { role?: "ADMIN" | "PLAYER"; verified?: boolean; key?: "ACTIVE" | "REVOKED" | null; label?: string; bugReports?: boolean } = {}): Promise<User> {
  const email = `${opts.label ?? "p"}-${run}-${emails.length}@example.test`;
  emails.push(email);
  const user = await prisma.user.create({
    data: {
      email, passwordHash: "x", role: opts.role ?? "PLAYER", emailVerifiedAt: opts.verified === false ? null : new Date(),
      ...(opts.bugReports ? { gameAdmin: { create: { bugReports: true } } } : {}),
    },
  });
  userIds.push(user.id);
  if (opts.key !== null) {
    await prisma.accessKey.create({
      data: {
        codeHash: sha256(`${batch}-${email}`), codePrefix: "TEST", tier: "BETA",
        status: opts.key === "REVOKED" ? "REVOKED" : "REDEEMED",
        batchLabel: batch, redemption: { create: { userId: user.id } },
      },
    });
  }
  const now = Date.now();
  const s = await prisma.nativeSession.create({
    data: { userId: user.id, clientId: "twaz-launcher", lastUsedAt: new Date(now), idleExpiresAt: new Date(now + 3600e3), absoluteExpiresAt: new Date(now + 7200e3) },
  });
  return { id: user.id, email, token: signAccessToken({ sub: user.id, sid: s.id, pwdAt: 0 }) };
}

const resetLimits = () => prisma.rateLimit.deleteMany({ where: { key: { in: userIds.map(bugReportGrantAccountKey) } } });

const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
  0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
  0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
  0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x09, 0xff, 0xc4, 0x00, 0x14,
  0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x7f, 0x3f, 0xff, 0xd9,
]);

const replayBytes = gzipSync(Buffer.from('{"v":1,"k":"header","t0":1732170000000,"hz":10,"durationMs":1000,"build":"t","map":"World_Main"}\n'));

function reportPayload(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    category: "gameplay",
    description: "The barn door never opens when I press interact.",
    includeReplay: true,
    clientSubmittedAt: "2026-11-21T10:00:00.000Z",
    build: { version: "playtest-0.73-abc1234", sha: "abc1234", family: "playtest-0.73", branch: "main", date: "2026-11-21" },
    platform: { os: "Windows", osVersion: "10.0.22631", arch: "x64", unity: "6000.4.1f1" },
    gpu: { name: "NVIDIA", api: "D3D11", vramMb: 8192 },
    perf: { fpsAvg: 61.2, fpsMin: 22.0, frameMsAvg: 16.4, frameMsMax: 45.1, windowSeconds: 60 },
    net: { mode: "official", serverId: `eu1-${run}`, serverName: "EU 1", pingMsAvg: 28, pingMsMax: 91, windowSeconds: 60, role: "client" },
    session: { map: "World_Main", playerCount: 6, inMenu: false },
    logTail: [{ t: 1732170000123, lv: "error", m: "scrubbed line" }],
    ...extra,
  };
}

function formFrom(payload: unknown, opts: { replay?: Buffer | null; shots?: Buffer[] } = {}) {
  const fd = new FormData();
  fd.set("report", new Blob([JSON.stringify(payload)], { type: "application/json" }));
  if (opts.replay !== null && opts.replay !== undefined) {
    fd.set("replay", new Blob([new Uint8Array(opts.replay)], { type: "application/gzip" }), "replay.ndjson.gz");
  } else if (opts.replay === undefined && (payload as { includeReplay?: boolean }).includeReplay) {
    fd.set("replay", new Blob([new Uint8Array(replayBytes)], { type: "application/gzip" }), "replay.ndjson.gz");
  }
  for (const shot of opts.shots ?? [JPEG]) {
    fd.append("screenshots[]", new Blob([new Uint8Array(shot)], { type: "image/jpeg" }), "shot.jpg");
  }
  return fd;
}

function grantReq(token: string | null, body: unknown = { ttlSec: 120 }, headers: Record<string, string> = {}) {
  const h = new Headers({ "content-type": "application/json", "x-real-ip": "13.0.0.1", ...headers });
  if (token) h.set("authorization", `Bearer ${token}`);
  return grants.POST(new NextRequest(new URL("/api/bug-reports/grants", BASE), { method: "POST", headers: h, body: JSON.stringify(body) }));
}

function uploadReq(token: string | null, form: FormData, headers: Record<string, string> = {}) {
  const h = new Headers({ "x-real-ip": "13.0.0.1", ...headers });
  if (token) h.set("authorization", `Bearer ${token}`);
  return uploads.POST(new NextRequest(new URL("/api/bug-reports", BASE), { method: "POST", headers: h, body: form }));
}

async function mint(user: User) {
  const res = await grantReq(user.token);
  expect(res.status).toBe(200);
  return res.json() as Promise<{ uploadToken: string; expiresAt: string; accountId: string }>;
}

let player: User;
let admin: User;
let site: User;
let owner: User;
let gaViewer: User;

beforeAll(async () => {
  player = await makeUser({ label: "player" });
  admin = await makeUser({ label: "admin", role: "ADMIN", bugReports: true });
  site = await makeUser({ label: "site", role: "ADMIN" });
  owner = await makeUser({ label: "owner", role: "ADMIN" });
  gaViewer = await makeUser({ label: "gaviewer", bugReports: true });
  process.env.ADMIN_EMAILS = owner.email;
  process.env.OWNER_EMAILS = owner.email;
});
beforeEach(async () => {
  await resetLimits();
  actor = null;
});

afterAll(async () => {
  await prisma.bugReport.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.bugReportGrant.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.accessKey.deleteMany({ where: { batchLabel: batch } });
  await resetLimits();
  await prisma.$disconnect();
  await rm(storageDir, { recursive: true, force: true });
});

describe("POST /api/bug-reports/grants", () => {
  it("401s a missing, foreign or malformed bearer and ignores cookies", async () => {
    await expect((await grantReq(null)).json()).resolves.toEqual({ error: "invalid_token" });
    expect((await grantReq(null)).status).toBe(401);
    expect((await grantReq("not-a-jwt")).status).toBe(401);
    const res = await grantReq(null, { ttlSec: 120 }, { cookie: `authjs.session-token=${player.token}` });
    expect(res.status).toBe(401);
  });

  it("403s unverified and no_key accounts", async () => {
    const unverified = await makeUser({ label: "unverified", verified: false });
    const noKey = await makeUser({ label: "nokey", key: null });
    expect(await (await grantReq(unverified.token)).json()).toEqual({ error: "unverified" });
    expect((await grantReq(unverified.token)).status).toBe(403);
    expect(await (await grantReq(noKey.token)).json()).toEqual({ error: "no_key" });
    expect((await grantReq(noKey.token)).status).toBe(403);
  });

  it("returns a one-time token bound to the account and stores only a hash", async () => {
    const body = await mint(player);
    expect(body.accountId).toBe(player.id);
    expect(body.uploadToken.length).toBeGreaterThan(20);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const row = await prisma.bugReportGrant.findUnique({ where: { tokenHash: sha256(body.uploadToken) } });
    expect(row?.userId).toBe(player.id);
    expect(row?.usedAt).toBeNull();
    const raw = JSON.stringify(row);
    expect(raw).not.toContain(body.uploadToken);
  });

  it("429s after 10 grants in an hour with a positive Retry-After", async () => {
    for (let i = 0; i < 10; i++) expect((await grantReq(player.token)).status, String(i)).toBe(200);
    const res = await grantReq(player.token);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("405s other methods", async () => {
    expect((await grants.GET()).status).toBe(405);
  });
});

describe("POST /api/bug-reports", () => {
  it("401s a missing or already-used or expired grant", async () => {
    const form = formFrom(reportPayload());
    expect((await uploadReq(null, form)).status).toBe(401);
    expect(await (await uploadReq(null, form)).json()).toEqual({ error: "unauthorized" });
    const { uploadToken } = await mint(player);
    const first = await uploadReq(uploadToken, formFrom(reportPayload()));
    expect(first.status).toBe(201);
    const again = await uploadReq(uploadToken, formFrom(reportPayload()));
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: "unauthorized" });

    const stale = await mint(player);
    await prisma.bugReportGrant.update({ where: { tokenHash: sha256(stale.uploadToken) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await uploadReq(stale.uploadToken, formFrom(reportPayload()))).status).toBe(401);
  });

  it("creates a report with a replay and returns a br_ id; admin can download the bytes", async () => {
    const { uploadToken } = await mint(player);
    const payload = reportPayload({ description: "The barn door never opens when I press interact." });
    const res = await uploadReq(uploadToken, formFrom(payload, { replay: replayBytes, shots: [JPEG] }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json() as { id: string; createdAt: string };
    expect(body.id).toMatch(/^br_[A-Za-z0-9_]{8,61}$/);
    const row = await prisma.bugReport.findUnique({ where: { id: body.id }, include: { screenshots: true } });
    expect(row?.userId).toBe(player.id);
    expect(row?.netMode).toBe("official");
    expect(row?.replaySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.screenshots).toHaveLength(1);

    actor = admin.id;
    const dl = await replayRoute.GET(new NextRequest(new URL(`/api/admin/bug-reports/${body.id}/replay`, BASE)), { params: Promise.resolve({ id: body.id }) });
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer())).toEqual(replayBytes);
    const shot = await shotRoute.GET(new NextRequest(new URL(`/api/admin/bug-reports/${body.id}/screenshots/0`, BASE)), { params: Promise.resolve({ id: body.id, index: "0" }) });
    expect(shot.status).toBe(200);
    expect(Buffer.from(await shot.arrayBuffer())).toEqual(JPEG);

    actor = player.id;
    const denied = await replayRoute.GET(new NextRequest(new URL(`/api/admin/bug-reports/${body.id}/replay`, BASE)), { params: Promise.resolve({ id: body.id }) });
    expect(denied.status).toBe(403);
    actor = null;
    expect((await replayRoute.GET(new NextRequest(new URL(`/api/admin/bug-reports/${body.id}/replay`, BASE)), { params: Promise.resolve({ id: body.id }) })).status).toBe(403);
  });

  it("allows a metadata-only report without a replay and at most one screenshot", async () => {
    const { uploadToken } = await mint(player);
    const res = await uploadReq(uploadToken, formFrom({ ...reportPayload(), includeReplay: false }, { replay: null, shots: [JPEG] }));
    expect(res.status).toBe(201);
    const { id } = await res.json() as { id: string };
    const row = await prisma.bugReport.findUnique({ where: { id } });
    expect(row?.includeReplay).toBe(false);
    expect(row?.replayKey).toBeNull();

    const again = await mint(player);
    const tooMany = await uploadReq(again.uploadToken, formFrom({ ...reportPayload(), includeReplay: false }, { replay: null, shots: [JPEG, JPEG] }));
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json() as { error: string }).error).toBe("invalid_report");
  });

  it("422-equivalent 400s bad json, forbidden keys, and a missing replay, without consuming the grant", async () => {
    const { uploadToken } = await mint(player);
    const badJson = new FormData();
    badJson.set("report", "{not-json");
    expect((await uploadReq(uploadToken, badJson)).status).toBe(400);

    const forbidden = await uploadReq(uploadToken, formFrom({ ...reportPayload(), accountId: player.id }));
    expect(forbidden.status).toBe(400);
    const forbiddenBody = await forbidden.json() as { error: string; fields: Record<string, string> };
    expect(forbiddenBody.error).toBe("invalid_report");
    expect(forbiddenBody.fields.accountId).toBe("forbidden");

    const missing = await uploadReq(uploadToken, formFrom(reportPayload(), { replay: null, shots: [] }));
    expect(missing.status).toBe(400);

    const still = await uploadReq(uploadToken, formFrom(reportPayload()));
    expect(still.status).toBe(201);
  });

  it("413s an oversized request, replay, or screenshot", async () => {
    const { uploadToken } = await mint(player);
    const hugeReplay = Buffer.concat([replayBytes, Buffer.alloc(1.5 * 1024 * 1024)]);
    hugeReplay[0] = 0x1f; hugeReplay[1] = 0x8b;
    const overReplay = await uploadReq(uploadToken, formFrom(reportPayload(), { replay: hugeReplay, shots: [] }));
    expect(overReplay.status).toBe(413);
    expect(await overReplay.json()).toEqual({ error: "too_large" });

    const { uploadToken: t2 } = await mint(player);
    const hugeShot = Buffer.concat([JPEG, Buffer.alloc(250 * 1024)]);
    hugeShot[0] = 0xff; hugeShot[1] = 0xd8; hugeShot[2] = 0xff;
    expect((await uploadReq(t2, formFrom(reportPayload(), { shots: [hugeShot] }))).status).toBe(413);

    const { uploadToken: t3 } = await mint(player);
    const raw = new NextRequest(new URL("/api/bug-reports", BASE), {
      method: "POST",
      headers: { authorization: `Bearer ${t3}`, "content-type": "multipart/form-data; boundary=----x", "content-length": String(3 * 1024 * 1024 + 10) },
      body: "nope",
    });
    const overBody = await uploads.POST(raw);
    expect(overBody.status).toBe(413);
  });

  it("429s after 5 successful reports in an hour with a positive Retry-After", async () => {
    const limited = await makeUser({ label: "rate" });
    for (let i = 0; i < REPORTS_PER_HOUR; i++) {
      const { uploadToken } = await mint(limited);
      expect((await uploadReq(uploadToken, formFrom(reportPayload()))).status, String(i)).toBe(201);
    }
    const { uploadToken } = await mint(limited);
    const res = await uploadReq(uploadToken, formFrom(reportPayload()));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    // grant was not consumed
    const grant = await prisma.bugReportGrant.findUnique({ where: { tokenHash: sha256(uploadToken) } });
    expect(grant?.usedAt).toBeNull();
  });

  it("405s other methods", async () => {
    expect((await uploads.GET()).status).toBe(405);
  });
});

describe("admin panel", () => {
  it("lists and shows reports for the owner and bugReports holders, filters by category, and escapes player text", async () => {
    const xss = `<script>alert(1)</script> door bug ${run}`;
    const { uploadToken } = await mint(player);
    const created = await uploadReq(uploadToken, formFrom(reportPayload({ category: "crash", description: xss, net: { ...reportPayload().net, mode: "listen", serverId: "", serverName: "" } })));
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };

    const { renderToStaticMarkup } = await import("react-dom/server");
    const emptySp = { searchParams: Promise.resolve({}) };
    const replayReq = () => replayRoute.GET(new NextRequest(new URL(`/api/admin/bug-reports/${id}/replay`, BASE)), { params: Promise.resolve({ id }) });

    actor = player.id;
    await expect(ListPage(emptySp)).rejects.toThrow();
    expect((await replayReq()).status).toBe(403);

    actor = site.id; // site admin, no bugReports power
    await expect(ListPage(emptySp)).rejects.toThrow();
    expect((await replayReq()).status).toBe(403);

    actor = admin.id;
    const list = renderToStaticMarkup(await ListPage(emptySp));
    expect(list).toContain(id);
    expect(list).toContain("crash");
    expect(list).toContain("listen");
    expect(list).toContain(displayName(player.id));
    expect(list).toContain(player.email);
    expect(list).not.toMatch(/<script>alert\(1\)<\/script>/);
    expect((await replayReq()).status).toBe(200);

    const filtered = renderToStaticMarkup(await ListPage({ searchParams: Promise.resolve({ category: "ui" }) }));
    expect(filtered).not.toContain(id);

    const detail = renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id }) }));
    expect(detail).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(detail).not.toMatch(/<script>alert\(1\)<\/script>/);
    expect(detail).toContain("listen");
    expect(detail).toContain(player.email);

    actor = owner.id;
    expect(renderToStaticMarkup(await ListPage(emptySp))).toContain(id);
    expect(renderToStaticMarkup(await ListPage(emptySp))).toContain(player.email);
    expect((await replayReq()).status).toBe(200);

    actor = gaViewer.id;
    const gaList = renderToStaticMarkup(await ListPage(emptySp));
    expect(gaList).toContain(id);
    expect(gaList).toContain(displayName(player.id));
    expect(gaList).not.toContain(player.email);
    expect(gaList).toContain(`${player.email[0]}***${player.email.slice(player.email.indexOf("@"))}`);
    expect((await replayReq()).status).toBe(200);
  });
});

describe("retention sweep", () => {
  it("deletes reports older than 90 days and their blobs, and leaves fresh rows", async () => {
    const owner = await makeUser({ label: "sweep" });
    const { uploadToken } = await mint(owner);
    const res = await uploadReq(uploadToken, formFrom(reportPayload()));
    expect(res.status).toBe(201);
    const { id } = await res.json() as { id: string };
    await prisma.bugReport.update({ where: { id }, data: { createdAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) } });
    const freshGrant = await mint(owner);
    const freshRes = await uploadReq(freshGrant.uploadToken, formFrom(reportPayload()));
    expect(freshRes.status).toBe(201);
    const fresh = await freshRes.json() as { id: string };

    const result = await sweepExpiredBugReports();
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.bugReport.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.bugReport.findUnique({ where: { id: fresh.id } })).not.toBeNull();
  });
});

describe("storage availability fail-safe", () => {
  const blocked = path.join("/var/tmp", `twaz-br-int-blocked-${run}`);
  let failUser: User;
  let reportId: string;
  let unusedToken: string;
  const prevSecret = process.env.LAUNCHER_TOKEN_SECRET;

  beforeAll(async () => {
    await writeFile(blocked, "not-a-dir");
    failUser = await makeUser({ label: "failsafe" });
    const minted = await mint(failUser);
    const created = await uploadReq(minted.uploadToken, formFrom(reportPayload()));
    expect(created.status).toBe(201);
    reportId = (await created.json() as { id: string }).id;
    unusedToken = (await mint(failUser)).uploadToken;
  });

  afterEach(() => {
    resetBugReportStorageCheck();
    process.env.BUG_REPORT_STORAGE_DIR = storageDir;
    if (prevSecret && Buffer.byteLength(prevSecret) >= 32) process.env.LAUNCHER_TOKEN_SECRET = prevSecret;
  });

  afterAll(async () => {
    await rm(blocked, { force: true });
  });

  async function setStorage(kind: "ok" | "unset" | "under_tmp" | "not_writable") {
    resetBugReportStorageCheck();
    if (kind === "ok") process.env.BUG_REPORT_STORAGE_DIR = storageDir;
    else if (kind === "unset") delete process.env.BUG_REPORT_STORAGE_DIR;
    else if (kind === "under_tmp") process.env.BUG_REPORT_STORAGE_DIR = `/tmp/twaz-br-int-${run}`;
    else process.env.BUG_REPORT_STORAGE_DIR = blocked;
  }

  async function expect503(res: Response) {
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe(String(STORAGE_CHECK_RETRY_AFTER_SEC));
    await expect(res.json()).resolves.toEqual({ error: "bug_reports_unavailable" });
  }

  it("boots and serves grants when the dir is writable, with no admin banner", async () => {
    process.env.LAUNCHER_TOKEN_SECRET = process.env.LAUNCHER_TOKEN_SECRET && Buffer.byteLength(process.env.LAUNCHER_TOKEN_SECRET) >= 32
      ? process.env.LAUNCHER_TOKEN_SECRET
      : "a".repeat(32);
    await setStorage("ok");
    await expect(register()).resolves.toBeUndefined();
    const res = await grantReq(failUser.token);
    expect(res.status).toBe(200);
    const body = await res.json() as { uploadToken: string };
    expect(body.uploadToken.length).toBeGreaterThan(20);
    const row = await prisma.bugReportGrant.findUnique({ where: { tokenHash: sha256(body.uploadToken) } });
    expect(row?.userId).toBe(failUser.id);
    actor = admin.id;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const list = renderToStaticMarkup(await ListPage({ searchParams: Promise.resolve({}) }));
    expect(list).not.toContain("isn't configured");
  });

  it.each([
    ["unset", "unset"],
    ["under_tmp", "under_tmp"],
    ["not_writable", "not_writable"],
  ] as const)("%s: boots, returns 503 without minting or consuming, and shows the admin banner", async (kind, reason) => {
    process.env.LAUNCHER_TOKEN_SECRET = process.env.LAUNCHER_TOKEN_SECRET && Buffer.byteLength(process.env.LAUNCHER_TOKEN_SECRET) >= 32
      ? process.env.LAUNCHER_TOKEN_SECRET
      : "a".repeat(32);
    await setStorage(kind);
    await expect(register()).resolves.toBeUndefined();

    const before = await prisma.bugReportGrant.count({ where: { userId: failUser.id } });
    await expect503(await grantReq(failUser.token));
    expect(await prisma.bugReportGrant.count({ where: { userId: failUser.id } })).toBe(before);

    await expect503(await uploadReq(unusedToken, formFrom(reportPayload())));
    const unused = await prisma.bugReportGrant.findUnique({ where: { tokenHash: sha256(unusedToken) } });
    expect(unused?.usedAt).toBeNull();

    actor = admin.id;
    const replay = await replayRoute.GET(new NextRequest(new URL(`/api/admin/bug-reports/${reportId}/replay`, BASE)), { params: Promise.resolve({ id: reportId }) });
    await expect503(replay);
    const shot = await shotRoute.GET(new NextRequest(new URL(`/api/admin/bug-reports/${reportId}/screenshots/0`, BASE)), { params: Promise.resolve({ id: reportId, index: "0" }) });
    await expect503(shot);

    const { renderToStaticMarkup } = await import("react-dom/server");
    const banner = bugReportStorageBannerText(reason).replaceAll("'", "&#x27;");
    const list = renderToStaticMarkup(await ListPage({ searchParams: Promise.resolve({}) }));
    expect(list).toContain(banner);
    expect(list).toContain("role=\"alert\"");
    const detail = renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id: reportId }) }));
    expect(detail).toContain(banner);
    expect(detail).toContain(reportId);

    const swept = await sweepExpiredBugReports();
    expect(swept).toMatchObject({ deleted: 0, skipped: true });
  });
});
