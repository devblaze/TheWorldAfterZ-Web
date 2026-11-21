// SuperTracker outbox for accepted bug reports, against the Postgres at DATABASE_URL.
// HTTP is always mocked. This file never reads a credentials file or calls the live tracker.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
delete process.env.SUPERTRACKER_TOKEN;
const storageDir = await mkdtemp(path.join("/var/tmp", "twaz-bug-tracker-test-"));
process.env.BUG_REPORT_STORAGE_DIR = storageDir;

const run = randomBytes(4).toString("hex");
let actor: string | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: { id: actor }, issuedPwdAt: 0 } : null) }));

const { prisma } = await import("@/lib/db");
const { sha256, displayName } = await import("@/lib/crypto");
const { signAccessToken } = await import("@/lib/launcher/jwt");
const { bugReportGrantAccountKey } = await import("@/lib/rate-limit");
const { issueTitleFromReport, trackerDedupeKey, TRACKER_SYNC_STATUS, SYNC_MAX_ATTEMPTS } = await import("@/lib/bug-report-tracker");
const { processBugReportTrackerOutbox, resetBugReportTrackerSyncGuard } = await import("@/lib/bug-report-tracker-sync");
const { resetTrackerFetch, setTrackerFetch } = await import("@/lib/bug-report-tracker-client");
const grants = await import("@/app/api/bug-reports/grants/route");
const uploads = await import("@/app/api/bug-reports/route");
const DetailPage = (await import("@/app/admin/bug-reports/[id]/page")).default;

const BASE = process.env.AUTH_URL!;
const batch = `trk-${run}`;
const emails: string[] = [];
const userIds: string[] = [];

type User = { id: string; email: string; token: string };

async function makeUser(opts: { role?: "ADMIN" | "PLAYER"; label?: string; bugReports?: boolean } = {}): Promise<User> {
  const email = `${opts.label ?? "p"}-${run}-${emails.length}@example.test`;
  emails.push(email);
  const user = await prisma.user.create({
    data: {
      email, passwordHash: "x", role: opts.role ?? "PLAYER", emailVerifiedAt: new Date(),
      ...(opts.bugReports ? { gameAdmin: { create: { bugReports: true } } } : {}),
    },
  });
  userIds.push(user.id);
  await prisma.accessKey.create({
    data: {
      codeHash: sha256(`${batch}-${email}`), codePrefix: "TEST", tier: "BETA",
      status: "REDEEMED", batchLabel: batch, redemption: { create: { userId: user.id } },
    },
  });
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
const replayBytes = gzipSync(Buffer.from('{"v":1}\n'));

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

function formFrom(payload: unknown) {
  const fd = new FormData();
  fd.set("report", new Blob([JSON.stringify(payload)], { type: "application/json" }));
  fd.set("replay", new Blob([new Uint8Array(replayBytes)], { type: "application/gzip" }), "replay.ndjson.gz");
  fd.append("screenshots[]", new Blob([new Uint8Array(JPEG)], { type: "image/jpeg" }), "shot.jpg");
  return fd;
}

function grantReq(token: string) {
  const h = new Headers({ "content-type": "application/json", "x-real-ip": "13.0.0.2" });
  h.set("authorization", `Bearer ${token}`);
  return grants.POST(new NextRequest(new URL("/api/bug-reports/grants", BASE), { method: "POST", headers: h, body: JSON.stringify({ ttlSec: 120 }) }));
}

function uploadReq(token: string, form: FormData) {
  const h = new Headers({ "x-real-ip": "13.0.0.2" });
  h.set("authorization", `Bearer ${token}`);
  return uploads.POST(new NextRequest(new URL("/api/bug-reports", BASE), { method: "POST", headers: h, body: form }));
}

async function mint(user: User) {
  const res = await grantReq(user.token);
  expect(res.status).toBe(200);
  return res.json() as Promise<{ uploadToken: string }>;
}

async function upload(user: User, extra: Record<string, unknown> = {}) {
  const { uploadToken } = await mint(user);
  const res = await uploadReq(uploadToken, formFrom(reportPayload(extra)));
  expect(res.status).toBe(201);
  return res.json() as Promise<{ id: string; createdAt: string }>;
}

function mcpCreate(key: string) {
  return new Response(JSON.stringify({
    jsonrpc: "2.0", id: 1,
    result: { structuredContent: { issue: { key, url: `https://tracker.ncatechsolutions.org/browse/${key}` } } },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function mcpComment() {
  return new Response(JSON.stringify({
    jsonrpc: "2.0", id: 1,
    result: { structuredContent: { comment: { id: "c1" } } },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function toolName(init?: RequestInit) {
  return (JSON.parse(String(init?.body)) as { params: { name: string; arguments: Record<string, unknown> } }).params;
}

function expectRan(run: Awaited<ReturnType<typeof processBugReportTrackerOutbox>>) {
  expect(run.ran).toBe(true);
  if (!run.ran) throw new Error("expected run");
  return run;
}

let player: User;
let admin: User;

beforeAll(async () => {
  player = await makeUser({ label: "trkplayer" });
  admin = await makeUser({ label: "trkadmin", role: "ADMIN", bugReports: true });
});
beforeEach(async () => {
  await resetLimits();
  actor = null;
  resetTrackerFetch();
  resetBugReportTrackerSyncGuard();
  delete process.env.SUPERTRACKER_TOKEN;
});
afterEach(() => {
  resetTrackerFetch();
  resetBugReportTrackerSyncGuard();
  delete process.env.SUPERTRACKER_TOKEN;
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

describe("tracker sync disabled", () => {
  it("accepts a report with no outbox row and no HTTP when the token is unset", async () => {
    const fetchMock = vi.fn();
    setTrackerFetch(fetchMock);
    const { id } = await upload(player);
    expect(await prisma.bugReportTrackerLink.findUnique({ where: { reportId: id } })).toBeNull();
    const ran = await processBugReportTrackerOutbox();
    expect(ran).toMatchObject({ ran: true, processed: 0, skipped: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();

    actor = admin.id;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const detail = renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id }) }));
    expect(detail).toContain("Not queued");
    expect(detail).not.toContain(player.email + "tracker");
  });
});

describe("tracker sync create and dedupe", () => {
  it("creates a SuperTracker issue after accept and shows the key on the admin page, never the email", async () => {
    process.env.SUPERTRACKER_TOKEN = "test-token";
    const fetchMock = vi.fn(async () => mcpCreate("TWAZ-99"));
    setTrackerFetch(fetchMock);
    const payload = reportPayload({ description: "The barn door never opens when I press interact." });
    const { id } = await upload(player, payload);
    const pending = await prisma.bugReportTrackerLink.findUnique({ where: { reportId: id } });
    expect(pending?.status).toBe(TRACKER_SYNC_STATUS.pending);
    expect(pending?.title).toBe(issueTitleFromReport(payload));
    expect(pending?.dedupeKey).toBe(trackerDedupeKey(player.id, payload.build.version, pending!.title));

    const ran = await processBugReportTrackerOutbox();
    expect(ran).toMatchObject({ ran: true, processed: 1, synced: 1, failed: 0 });
    const row = await prisma.bugReportTrackerLink.findUnique({ where: { reportId: id } });
    expect(row?.status).toBe("synced");
    expect(row?.issueKey).toBe("TWAZ-99");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(String(url)).toBe("https://tracker.ncatechsolutions.org/api/mcp");
    const args = toolName(init);
    expect(args.name).toBe("create_issue");
    expect(args.arguments).toMatchObject({ project: "TWAZ", type: "BUG", labels: ["in-game-report"] });
    expect(String(args.arguments.summary)).toBe(issueTitleFromReport(payload));
    const description = String(args.arguments.description);
    expect(description).toContain(displayName(player.id));
    expect(description).not.toContain(player.email);
    expect(description).toContain(`/admin/bug-reports/${id}`);
    expect(description).toContain("playtest-0.73-abc1234");

    actor = admin.id;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const detail = renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id }) }));
    expect(detail).toContain("TWAZ-99");
    expect(detail).toContain("Synced to");
    expect(detail).toContain("https://tracker.ncatechsolutions.org/browse/TWAZ-99");
  });

  it("comments on the existing issue for the same player, build, and title within 10 minutes", async () => {
    process.env.SUPERTRACKER_TOKEN = "test-token";
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const name = toolName(init).name;
      return name === "add_comment" ? mcpComment() : mcpCreate("TWAZ-100");
    });
    setTrackerFetch(fetchMock);
    await upload(player, { description: "Flashlight flickers in the farmhouse hallway." });
    expect(expectRan(await processBugReportTrackerOutbox()).synced).toBe(1);
    const second = await upload(player, { description: "Flashlight flickers in the farmhouse hallway." });
    expect(expectRan(await processBugReportTrackerOutbox()).synced).toBe(1);
    const link = await prisma.bugReportTrackerLink.findUnique({ where: { reportId: second.id } });
    expect(link?.issueKey).toBe("TWAZ-100");
    expect(link?.status).toBe("synced");
    const commentCalls = fetchMock.mock.calls.filter((c) => toolName(c[1] as RequestInit).name === "add_comment");
    expect(commentCalls).toHaveLength(1);
    const args = toolName(commentCalls[0][1] as RequestInit).arguments;
    expect(args.key).toBe("TWAZ-100");
    expect(String(args.body)).toContain(`/admin/bug-reports/${second.id}`);
    expect(fetchMock.mock.calls.filter((c) => toolName(c[1] as RequestInit).name === "create_issue")).toHaveLength(1);
  });
});

describe("tracker sync retries", () => {
  it("leaves the row pending with backoff after a 503, and does not create a second issue on retry", async () => {
    process.env.SUPERTRACKER_TOKEN = "test-token";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(mcpCreate("TWAZ-101"));
    setTrackerFetch(fetchMock);
    const { id } = await upload(player, { description: "Zombies clip through the barn wall after reload." });
    const first = expectRan(await processBugReportTrackerOutbox());
    expect(first.synced).toBe(0);
    const pending = await prisma.bugReportTrackerLink.findUnique({ where: { reportId: id } });
    expect(pending?.status).toBe("pending");
    expect(pending?.issueKey).toBeNull();
    expect(pending?.attemptCount).toBe(1);
    expect(pending?.lastError).toBe("http_503");
    expect(pending!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // Due again.
    await prisma.bugReportTrackerLink.update({ where: { reportId: id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const second = expectRan(await processBugReportTrackerOutbox());
    expect(second.synced).toBe(1);
    const row = await prisma.bugReportTrackerLink.findUnique({ where: { reportId: id } });
    expect(row?.issueKey).toBe("TWAZ-101");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("marks the row failed after the attempt budget and does not call the tracker again", async () => {
    process.env.SUPERTRACKER_TOKEN = "test-token";
    const fetchMock = vi.fn(async () => new Response("down", { status: 503 }));
    setTrackerFetch(fetchMock);
    const user = await makeUser({ label: "failbudget" });
    const { id } = await upload(user, { description: "The inventory grid loses items when swapping a bandage." });
    await prisma.bugReportTrackerLink.update({
      where: { reportId: id },
      data: { attemptCount: SYNC_MAX_ATTEMPTS - 1, nextAttemptAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 1000) },
    });
    const ran = expectRan(await processBugReportTrackerOutbox());
    expect(ran.failed).toBe(1);
    const row = await prisma.bugReportTrackerLink.findUnique({ where: { reportId: id } });
    expect(row?.status).toBe("failed");
    expect(row?.issueKey).toBeNull();

    fetchMock.mockClear();
    await prisma.bugReportTrackerLink.update({ where: { reportId: id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const again = expectRan(await processBugReportTrackerOutbox());
    expect(again.processed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    actor = admin.id;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const detail = renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id }) }));
    expect(detail).toContain("Failed after");
  });

  it("is idempotent when the issue key is already stored", async () => {
    process.env.SUPERTRACKER_TOKEN = "test-token";
    const fetchMock = vi.fn(async () => mcpCreate("TWAZ-102"));
    setTrackerFetch(fetchMock);
    const user = await makeUser({ label: "idempotent" });
    const { id } = await upload(user, { description: "A deer ragdolls through the floor of the cabin." });
    await prisma.bugReportTrackerLink.update({
      where: { reportId: id },
      data: { issueKey: "TWAZ-102", issueUrl: "https://tracker.ncatechsolutions.org/browse/TWAZ-102", status: "synced", syncedAt: new Date() },
    });
    const ran = expectRan(await processBugReportTrackerOutbox());
    expect(ran.processed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not open a second issue when a previous create already stored the key", async () => {
    process.env.SUPERTRACKER_TOKEN = "test-token";
    const fetchMock = vi.fn(async () => mcpCreate("TWAZ-103"));
    setTrackerFetch(fetchMock);
    const user = await makeUser({ label: "storedkey" });
    const { id } = await upload(user, { description: "Night flashlight beam stutters when turning quickly." });
    await prisma.bugReportTrackerLink.update({
      where: { reportId: id },
      data: { issueKey: "TWAZ-103", issueUrl: "https://tracker.ncatechsolutions.org/browse/TWAZ-103", status: "pending", nextAttemptAt: new Date(Date.now() - 1000) },
    });
    const ran = expectRan(await processBugReportTrackerOutbox());
    expect(ran.synced).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    const row = await prisma.bugReportTrackerLink.findUnique({ where: { reportId: id } });
    expect(row?.status).toBe("synced");
    expect(row?.issueKey).toBe("TWAZ-103");
  });
});
