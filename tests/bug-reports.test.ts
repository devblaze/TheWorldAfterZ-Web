import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  BugReportBody, GRANT_TTL_SEC_MAX, GrantRequest, REPORT_ID_RE, REQUEST_MAX_BYTES,
  findForbiddenReportContent, isGzip, isJpeg, newReportId, readBodyCapped, retryAfterFrom,
} from "../src/lib/bug-reports";
import { assertBugReportStorage, bugReportStorageDir, getBugReportBlob, isUnderTmp, putBugReportBlob, removeBugReportBlob } from "../src/lib/bug-report-storage";
import { resetBugReportSweepScheduler, runBugReportSweepGuarded, startBugReportSweepScheduler } from "../src/lib/bug-report-sweep-schedule";

const valid = {
  schemaVersion: 1 as const,
  category: "gameplay" as const,
  description: "The door on the barn never opens when I press interact.",
  includeReplay: true,
  clientSubmittedAt: "2026-11-21T10:00:00.000Z",
  build: { version: "playtest-0.73-abc1234", sha: "abc1234", family: "playtest-0.73", branch: "main", date: "2026-11-21" },
  platform: { os: "Windows", osVersion: "10.0.22631", arch: "x64", unity: "6000.4.1f1" },
  gpu: { name: "NVIDIA GeForce RTX 3070", api: "D3D11", vramMb: 8192 },
  perf: { fpsAvg: 61.2, fpsMin: 22.0, frameMsAvg: 16.4, frameMsMax: 45.1, windowSeconds: 60 },
  net: { mode: "official" as const, serverId: "eu1", serverName: "EU 1", pingMsAvg: 28, pingMsMax: 91, windowSeconds: 60, role: "client" },
  session: { map: "World_Main", playerCount: 6, inMenu: false },
  logTail: [{ t: 1732170000123, lv: "error" as const, m: "scrubbed line" }],
};

describe("bug report schema", () => {
  it("accepts a valid schemaVersion 1 payload and ignores unknown fields", () => {
    const parsed = BugReportBody.safeParse({ ...valid, extra: "ignored" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect("extra" in parsed.data).toBe(false);
  });

  it("rejects short descriptions, bad categories, bad versions, and oversize log tails", () => {
    expect(BugReportBody.safeParse({ ...valid, description: "too short" }).success).toBe(false);
    expect(BugReportBody.safeParse({ ...valid, category: "physics" }).success).toBe(false);
    expect(BugReportBody.safeParse({ ...valid, schemaVersion: 2 }).success).toBe(false);
    expect(BugReportBody.safeParse({ ...valid, logTail: Array.from({ length: 201 }, (_, i) => ({ t: i, lv: "info", m: "x" })) }).success).toBe(false);
  });

  it("accepts a grant ttl in range and rejects 0 or over the cap", () => {
    expect(GrantRequest.parse({})).toEqual({});
    expect(GrantRequest.parse({ ttlSec: 120 })).toEqual({ ttlSec: 120 });
    expect(GrantRequest.safeParse({ ttlSec: 0 }).success).toBe(false);
    expect(GrantRequest.safeParse({ ttlSec: GRANT_TTL_SEC_MAX + 1 }).success).toBe(false);
  });
});

describe("forbidden report content", () => {
  it("flags secret keys and secret-shaped values, but not free-text description or log lines", () => {
    expect(findForbiddenReportContent({ ...valid, accountId: "clx1" })).toBe("accountId");
    expect(findForbiddenReportContent({ ...valid, email: "a@b.c" })).toBe("email");
    expect(findForbiddenReportContent({ ...valid, accessToken: "x" })).toBe("accessToken");
    expect(findForbiddenReportContent({ ...valid, net: { ...valid.net, ticket: "abc" } })).toBe("net.ticket");
    expect(findForbiddenReportContent({ ...valid, build: { ...valid.build, sha: "user@example.com" } })).toBe("build.sha");
    expect(findForbiddenReportContent({ ...valid, gpu: { ...valid.gpu, name: "Bearer abc.def" } })).toBe("gpu.name");
    expect(findForbiddenReportContent({ ...valid, description: "I typed user@example.com in the box" })).toBeNull();
    expect(findForbiddenReportContent({ ...valid, logTail: [{ t: 1, lv: "error", m: "token=abc" }] })).toBeNull();
    expect(findForbiddenReportContent(valid)).toBeNull();
  });
});

describe("ids and magic bytes", () => {
  it("mints br_ ids in the contract alphabet", () => {
    const id = newReportId();
    expect(id).toMatch(REPORT_ID_RE);
    expect(id.startsWith("br_")).toBe(true);
  });

  it("detects jpeg and gzip magic, and rejects other bytes", () => {
    expect(isJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBe(true);
    expect(isJpeg(Buffer.from("not-a-jpeg"))).toBe(false);
    expect(isGzip(gzipSync(Buffer.from("hello")))).toBe(true);
    expect(isGzip(Buffer.from("hello"))).toBe(false);
  });

  it("computes a positive Retry-After from the oldest row in a window", () => {
    const oldest = new Date(1_700_000_000_000);
    expect(retryAfterFrom(oldest, 3_600_000, 1_700_000_000_000 + 10_000)).toBe(3590);
    expect(retryAfterFrom(oldest, 3_600_000, 1_700_003_600_000)).toBe(1);
  });
});

describe("request body cap", () => {
  it("returns tooLarge as soon as the stream crosses the cap, without needing a content-length", async () => {
    const over = REQUEST_MAX_BYTES + 1;
    const req = new Request("http://localhost/api/bug-reports", { method: "POST", body: Buffer.alloc(over, 1) });
    await expect(readBodyCapped(req, REQUEST_MAX_BYTES)).resolves.toEqual({ ok: false, tooLarge: true });
  });

  it("accepts a body at the cap and rejects a content-length over the cap without reading", async () => {
    const ok = await readBodyCapped(new Request("http://localhost/x", { method: "POST", body: Buffer.from("abc") }), 3);
    expect(ok).toEqual({ ok: true, buf: Buffer.from("abc") });
    const early = await readBodyCapped(new Request("http://localhost/x", { method: "POST", headers: { "content-length": "10" }, body: "ignored" }), 3);
    expect(early).toEqual({ ok: false, tooLarge: true });
  });
});

describe("filesystem storage", () => {
  const prev = process.env.BUG_REPORT_STORAGE_DIR;
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.BUG_REPORT_STORAGE_DIR;
    else process.env.BUG_REPORT_STORAGE_DIR = prev;
  });

  it("writes a random name inside the root and records sha256, and refuses path escape", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "twaz-br-"));
    process.env.BUG_REPORT_STORAGE_DIR = dir;
    const put = await putBugReportBlob(Buffer.from("replay-bytes"), "gz");
    expect(put.key).toMatch(/^[a-f0-9]{48}\.gz$/);
    expect(put.bytes).toBe(12);
    expect(put.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await getBugReportBlob(put.key)).toEqual(Buffer.from("replay-bytes"));
    await expect(getBugReportBlob("../passwd.txt")).rejects.toThrow(/invalid storage key/);
    await expect(getBugReportBlob("nope/../escape.bin")).rejects.toThrow(/invalid storage key/);
    const sneak = path.join(dir, "..", "outside.bin");
    await writeFile(path.join(dir, "placeholder"), "x");
    await mkdir(path.dirname(sneak), { recursive: true }).catch(() => undefined);
    await expect(getBugReportBlob(path.relative(dir, sneak))).rejects.toThrow(/invalid storage key/);
    await removeBugReportBlob(put.key);
    expect(await getBugReportBlob(put.key)).toBeNull();
    const leftover = await readFile(path.join(dir, put.key)).catch((e: NodeJS.ErrnoException) => e.code);
    expect(leftover).toBe("ENOENT");
  });
});

describe("production storage dir", () => {
  it("treats /tmp and its children as forbidden, but not /var/tmp or a similarly prefixed path", () => {
    expect(isUnderTmp("/tmp")).toBe(true);
    expect(isUnderTmp("/tmp/twaz-bug-reports")).toBe(true);
    expect(isUnderTmp("/tmp/foo/../foo")).toBe(true);
    expect(isUnderTmp("/var/lib/twaz/bug-reports")).toBe(false);
    expect(isUnderTmp("/var/tmp/bugs")).toBe(false);
    expect(isUnderTmp("/tmpfoo")).toBe(false);
  });

  it("fails production startup when the dir is missing or under /tmp, and allows a durable path", () => {
    expect(() => assertBugReportStorage({ NODE_ENV: "production" })).toThrow(/BUG_REPORT_STORAGE_DIR/);
    expect(() => assertBugReportStorage({ NODE_ENV: "production", BUG_REPORT_STORAGE_DIR: " " })).toThrow(/BUG_REPORT_STORAGE_DIR/);
    expect(() => assertBugReportStorage({ NODE_ENV: "production", BUG_REPORT_STORAGE_DIR: "/tmp" })).toThrow(/under \/tmp/);
    expect(() => assertBugReportStorage({ NODE_ENV: "production", BUG_REPORT_STORAGE_DIR: "/tmp/bugs" })).toThrow(/under \/tmp/);
    expect(() => assertBugReportStorage({ NODE_ENV: "production", BUG_REPORT_STORAGE_DIR: "/var/lib/twaz/bug-reports" })).not.toThrow();
    expect(() => assertBugReportStorage({ NODE_ENV: "test" })).not.toThrow();
  });

  it("does not fall back to /tmp when the variable is unset", () => {
    const prev = process.env.BUG_REPORT_STORAGE_DIR;
    delete process.env.BUG_REPORT_STORAGE_DIR;
    expect(() => bugReportStorageDir()).toThrow(/BUG_REPORT_STORAGE_DIR is not set/);
    if (prev === undefined) delete process.env.BUG_REPORT_STORAGE_DIR;
    else process.env.BUG_REPORT_STORAGE_DIR = prev;
  });
});

describe("in-process daily sweep guard", () => {
  const result = { deleted: 1, removedBlobs: 2, expiredGrants: 3 };

  afterEach(() => {
    resetBugReportSweepScheduler();
  });

  it("runs once when two calls overlap, then allows a later run", async () => {
    let started = 0;
    let release!: (value: typeof result) => void;
    const sweep = () => {
      started += 1;
      return new Promise<typeof result>((resolve) => { release = resolve; });
    };
    const first = runBugReportSweepGuarded(sweep);
    const second = runBugReportSweepGuarded(sweep);
    expect(started).toBe(1);
    release(result);
    await expect(first).resolves.toEqual({ ran: true, result });
    await expect(second).resolves.toEqual({ ran: false });
    await expect(runBugReportSweepGuarded(async () => result)).resolves.toEqual({ ran: true, result });
  });

  it("starts the scheduler only once per process", async () => {
    let n = 0;
    const sweep = async () => {
      n += 1;
      return result;
    };
    startBugReportSweepScheduler({ sweep, intervalMs: 60_000, startNow: true });
    startBugReportSweepScheduler({ sweep, intervalMs: 60_000, startNow: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(n).toBe(1);
  });
});
