// End-to-end flow through the real route handlers against the Postgres at DATABASE_URL.
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// auth() reads the request cookies via next/headers, which only works inside Next's request scope.
// Feed it the headers of the request the test is currently making instead.
let ambient = new Headers();
vi.mock("next/headers", () => ({ headers: async () => ambient }));

const { prisma } = await import("@/lib/db");
const { sha256 } = await import("@/lib/crypto");
const authRoute = await import("@/app/api/auth/[...nextauth]/route");
const register = await import("@/app/api/register/route");
const verify = await import("@/app/api/verify/route");
const redeem = await import("@/app/api/redeem/route");
const download = await import("@/app/api/download/route");
const downloadFile = await import("@/app/api/download/file/route");
const mint = await import("@/app/api/admin/keys/mint/route");
const revoke = await import("@/app/api/admin/keys/[id]/revoke/route");

const BASE = process.env.AUTH_URL!;
const run = randomBytes(4).toString("hex"); // unique per run, so the DB need not be empty
const ip = `10.${randomBytes(3).join(".")}`; // own rate-limit buckets per run
const player = { email: `player-${run}@example.test`, password: "correct horse battery" };
const admin = { email: `admin-${run}@example.test`, password: "admin password 123" };

type Jar = Map<string, string>;
const cookieHeader = (jar: Jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
function absorb(jar: Jar, res: Response) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
}

function req(urlPath: string, init: { method?: string; jar?: Jar; body?: BodyInit; json?: unknown } = {}) {
  const h = new Headers({ "x-real-ip": ip, origin: new URL(BASE).origin });
  if (init.jar) h.set("cookie", cookieHeader(init.jar));
  let body = init.body;
  if (init.json !== undefined) {
    h.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  ambient = h;
  return new NextRequest(new URL(urlPath, BASE), { method: init.method ?? (body ? "POST" : "GET"), headers: h, body });
}

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** Signs in through the Auth.js credentials callback. Returns the jar on success, null when refused. */
async function login(email: string, password: string): Promise<Jar | null> {
  const jar: Jar = new Map();
  const csrfRes = await authRoute.GET(req("/api/auth/csrf", { jar }));
  absorb(jar, csrfRes);
  const { csrfToken } = await csrfRes.json();
  const res = await authRoute.POST(
    // Auth.js only parses urlencoded bodies, like the browser form posts.
    req("/api/auth/callback/credentials", { jar, body: new URLSearchParams({ csrfToken, email, password, callbackUrl: `${BASE}/account` }) }),
  );
  absorb(jar, res);
  return [...jar.keys()].some((k) => k.endsWith("authjs.session-token")) ? jar : null;
}

const location = (res: Response) => res.headers.get("location") ?? "";

let playerJar: Jar;
let adminJar: Jar;
let codes: string[];

beforeAll(async () => {
  await prisma.user.create({
    data: {
      email: admin.email,
      role: "ADMIN",
      emailVerifiedAt: new Date(),
      passwordHash: await argon2.hash(admin.password, { type: argon2.argon2id }),
    },
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: [player.email, admin.email] } } });
  await prisma.$disconnect();
});

describe("player flow", () => {
  let token = "";

  it("registers and emails a verification link", async () => {
    // With SMTP_HOST unset the mailer logs the link to the console; capture it from there.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await register.POST(req("/api/register", { body: form(player) }));
    expect(res.status).toBe(303);
    expect(location(res)).toBe("/login?registered=1");
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes(player.email));
    log.mockRestore();
    token = new URL(line!.split(": ").pop()!).searchParams.get("token")!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("refuses login before the email is verified", async () => {
    expect(await login(player.email, player.password)).toBeNull();
  });

  it("verifies with the emailed token, once", async () => {
    const ok = await verify.GET(req(`/api/verify?token=${token}`));
    expect(location(ok)).toBe("/login?verified=1");
    const again = await verify.GET(req(`/api/verify?token=${token}`));
    expect(location(again)).toBe("/login?error=verify");
  });

  it("logs in once verified", async () => {
    playerJar = (await login(player.email, player.password))!;
    expect(playerJar).toBeTruthy();
  });

  it("refuses the download before a key is redeemed", async () => {
    const res = await download.GET(req("/api/download", { jar: playerJar }));
    expect(res.status).toBe(403);
  });

  it("lets an admin mint keys", async () => {
    adminJar = (await login(admin.email, admin.password))!;
    expect(adminJar).toBeTruthy();
    const res = await mint.POST(req("/api/admin/keys/mint", { jar: adminJar, json: { count: 2, tier: "ALPHA", batchLabel: `ci ${run}` } }));
    expect(res.status).toBe(200);
    ({ codes } = await res.json());
    expect(codes).toHaveLength(2);
    for (const c of codes) expect(c).toMatch(/^TWAZ-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });

  it("does not let a player mint", async () => {
    const res = await mint.POST(req("/api/admin/keys/mint", { jar: playerJar, json: { count: 1, tier: "ALPHA", batchLabel: "x" } }));
    expect(res.status).toBe(403);
  });

  it("rejects a wrong key", async () => {
    const res = await redeem.POST(req("/api/redeem", { jar: playerJar, body: form({ code: "TWAZ-0000-0000-0000" }) }));
    expect(location(res)).toBe("/redeem?error=invalid");
  });

  it("redeems a valid key typed in lowercase", async () => {
    const res = await redeem.POST(req("/api/redeem", { jar: playerJar, body: form({ code: codes[0].toLowerCase() }) }));
    expect(location(res)).toBe("/account?redeemed=1");
  });

  let fileUrl = "";

  it("issues a signed redirect and streams the manifest file", async () => {
    const res = await download.GET(req("/api/download", { jar: playerJar }));
    expect(res.status).toBe(302);
    fileUrl = location(res);
    expect(fileUrl).toMatch(/^\/api\/download\/file\?exp=\d+&sig=[0-9a-f]{64}$/);

    const file = await downloadFile.GET(req(fileUrl));
    expect(file.status).toBe(200);
    const dir = process.env.LAUNCHER_DIR!;
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(bytes.length).toBe(manifest.size);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest.sha256);
    expect(file.headers.get("content-disposition")).toContain(manifest.filename);
  });

  it("refuses a tampered signature", async () => {
    const tampered = fileUrl.replace(/sig=(.)/, (_, c) => `sig=${c === "0" ? "1" : "0"}`);
    expect(tampered).not.toBe(fileUrl);
    expect((await downloadFile.GET(req(tampered))).status).toBe(403);
  });

  it("cuts off access when the key is revoked", async () => {
    const key = await prisma.accessKey.findUniqueOrThrow({ where: { codeHash: sha256(codes[0]) } });
    const res = await revoke.POST(req(`/api/admin/keys/${key.id}/revoke`, { jar: adminJar, body: form({ reason: "ci test" }) }), {
      params: Promise.resolve({ id: key.id }),
    });
    expect(location(res)).toBe("/admin/keys?revoked=1");
    expect((await download.GET(req("/api/download", { jar: playerJar }))).status).toBe(403);
  });

  it("rate limits login per account", async () => {
    // Two attempts so far for this account (unverified + verified); the limit is 5 per 15 minutes.
    for (let i = 0; i < 3; i++) expect(await login(player.email, "wrong password")).toBeNull();
    // Sixth attempt: refused even with the right password.
    expect(await login(player.email, player.password)).toBeNull();
    const row = await prisma.rateLimit.findUniqueOrThrow({ where: { key: `login:acct:${player.email}` } });
    expect(row.count).toBeGreaterThan(5);
  });
});
