import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

process.env.AUTH_URL ??= "http://localhost:3000";
if (!process.env.LAUNCHER_TOKEN_SECRET || Buffer.byteLength(process.env.LAUNCHER_TOKEN_SECRET) < 32) {
  process.env.LAUNCHER_TOKEN_SECRET = randomBytes(32).toString("base64url");
}

// Any DB access throws, to prove both routes fail closed.
vi.mock("@/lib/db", () => ({
  prisma: new Proxy({}, { get: () => new Proxy(() => {}, { get: () => () => Promise.reject(new Error("db down")), apply: () => Promise.reject(new Error("db down")) }) }),
}));

vi.mock("@/lib/session", () => ({ activeRedemption: () => Promise.reject(new Error("db down")) }));

const { JoinTicketRequest, parseDirectoryQuery } = await import("@/lib/servers");
const { bearerToken } = await import("@/lib/launcher/store");
const { readJsonBody } = await import("@/lib/launcher/http");
const { signAccessToken } = await import("@/lib/launcher/jwt");
const directory = await import("@/app/api/launcher/servers/route");
const join = await import("@/app/api/launcher/join-ticket/route");

const body = { serverId: "abc123", build_family: "playtest-0.59", protocol_version: 3, client_platform: "win-x64", game_build: "0.59-abc1234", nonce: "n".repeat(16) };
const query = "build_family=playtest-0.59&protocol_version=3&client_platform=win-x64&game_build=0.59-abc1234";

describe("launcher directory query", () => {
  it("accepts the four params and rejects missing, repeated or malformed ones", () => {
    expect(parseDirectoryQuery(new URLSearchParams(query))).toMatchObject({ success: true, data: { protocol_version: 3 } });
    expect(parseDirectoryQuery(new URLSearchParams(query.replace("protocol_version=3", "protocol_version=1000000"))).success).toBe(true);
    for (const bad of [
      "", "build_family=a&protocol_version=1&client_platform=win-x64",
      query.replace("protocol_version=3", "protocol_version=03"), query.replace("protocol_version=3", "protocol_version=0"),
      query.replace("protocol_version=3", "protocol_version=1.0"), query.replace("protocol_version=3", "protocol_version=1000001"),
      query.replace("protocol_version=3", "protocol_version=+3"), query.replace("win-x64", "osx-x64"), query.replace("win-x64", "WIN-X64"),
      query.replace("build_family=playtest-0.59", "build_family="), query.replace("build_family=playtest-0.59", `build_family=${"f".repeat(65)}`),
      query.replace("game_build=0.59-abc1234", `game_build=${"g".repeat(129)}`), `${query}&client_platform=linux-x64`,
    ]) {
      expect(parseDirectoryQuery(new URLSearchParams(bad)).success, bad).toBe(false);
    }
  });
});

describe("join-ticket body", () => {
  it("accepts the frozen shapes and rejects every bound", () => {
    expect(JoinTicketRequest.safeParse(body).success).toBe(true);
    expect(JoinTicketRequest.safeParse({ ...body, nonce: "A-z_9".repeat(25).slice(0, 128), serverId: "s".repeat(128), game_build: "g".repeat(128) }).success).toBe(true);
    for (const patch of [
      { nonce: "n".repeat(15) }, { nonce: "n".repeat(129) }, { nonce: `${"n".repeat(16)}=` }, { nonce: `${"n".repeat(16)} ` }, { nonce: `${"n".repeat(16)}é` },
      { protocol_version: 0 }, { protocol_version: 1_000_001 }, { protocol_version: 1.5 }, { protocol_version: "3" },
      { client_platform: "linux" }, { client_platform: "osx-x64" }, { build_family: "" }, { build_family: "f".repeat(65) },
      { game_build: "" }, { game_build: "g".repeat(129) }, { game_build: 1 }, { serverId: "" }, { serverId: "s".repeat(129) }, { serverId: "a.b" },
      { serverId: undefined }, { nonce: undefined },
    ]) {
      expect(JoinTicketRequest.safeParse({ ...body, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
  });
});

describe("bounded JSON reader", () => {
  it("rejects invalid UTF-8 instead of silently repairing it", async () => {
    const bytes = Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    const req = new Request("http://localhost:3000", { method: "POST", headers: { "content-type": "application/json" }, body: bytes });
    expect(await readJsonBody(req, 8192)).toBeNull();
  });
});

describe("bearer header", () => {
  it("takes only a single Bearer token of bounded length", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
    for (const bad of [null, "", "Bearer", "Bearer a b", "Basic abc", `Bearer ${"a".repeat(4097)}`]) expect(bearerToken(bad)).toBeNull();
  });
});

const get = (h: Record<string, string> = {}) => directory.GET(new NextRequest(`http://localhost:3000/api/launcher/servers?${query}`, { headers: h }));
const post = (h: Record<string, string> = {}) =>
  join.POST(new NextRequest("http://localhost:3000/api/launcher/join-ticket", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) }));

async function expectJson(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("location")).toBeNull();
  expect(await res.json()).toEqual({ error });
}

describe("launcher directory and join-ticket routes", () => {
  it("401 without a usable bearer, never reading cookies", async () => {
    for (const h of [{}, { cookie: "authjs.session-token=x" }, { authorization: "Bearer not-a-token" }, { authorization: "Basic abc" }] as Record<string, string>[]) {
      await expectJson(await get(h), 401, "invalid_token");
      await expectJson(await post(h), 401, "invalid_token");
    }
  });

  it("fails closed with 500 JSON when the database errors, without logging the token", async () => {
    const token = signAccessToken({ sub: "user_1", sid: "sess_1", pwdAt: 0 });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expectJson(await get({ authorization: `Bearer ${token}` }), 500, "server_error");
    await expectJson(await post({ authorization: `Bearer ${token}` }), 500, "server_error");
    expect(err.mock.calls.flat().join(" ")).not.toContain(token);
    err.mockRestore();
  });

  it("returns JSON 405 no-store on unsupported methods", async () => {
    for (const [route, allow, methods] of [
      [directory, "GET", ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]],
      [join, "POST", ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"]],
    ] as const) {
      for (const m of methods) {
        const res = (route as unknown as Record<string, () => Response>)[m]();
        await expectJson(res, 405, "method_not_allowed");
        expect(res.headers.get("allow")).toBe(allow);
      }
    }
  });
});
