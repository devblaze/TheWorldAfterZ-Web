import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "../src/lib/crypto";
import {
  Capacity, CreateServer, Endpoint, decideHeartbeatBuild, effectiveCapacity, Heartbeat, LauncherCreateServer, newServerSecret, parseServerAuth,
  secretMatches, serverStatus,
} from "../src/lib/servers";

// Any DB access throws, to prove the heartbeat fails closed.
vi.mock("@/lib/db", () => ({
  prisma: new Proxy({}, { get: () => new Proxy(() => {}, { get: () => () => Promise.reject(new Error("db down")), apply: () => Promise.reject(new Error("db down")) }) }),
}));

const secret = "A".repeat(43);
const beat = { game_build: "0.59.1-win", build_family: "playtest-0.59", protocol_version: 3, server_runtime: "linux-x64", instance_nonce: "n".repeat(16), players: 0, maxPlayers: 16 };
const server = { name: "EU 1", region: "eu", host: "play.example.org", port: 7777, gameBuild: "0.59.1", buildFamily: "playtest-0.59", protocolVersion: 3, clientPlatforms: ["win-x64", "linux-x64"] };

describe("server credential", () => {
  it("mints 32-byte base64url secrets", () => {
    const s = newServerSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(s, "base64url")).toHaveLength(32);
    expect(newServerSecret()).not.toBe(s);
  });

  it("parses only the exact TwazServer scheme", () => {
    expect(parseServerAuth(`TwazServer abc123.${secret}`)).toEqual({ serverId: "abc123", secret });
    for (const bad of [null, "", `Bearer abc.${secret}`, `twazserver abc.${secret}`, `TwazServer abc${secret}`, `TwazServer .${secret}`,
      `TwazServer abc.${secret}x`, `TwazServer abc.${secret.slice(1)}`, `TwazServer ABC.${secret}`, `TwazServer a.b.${secret}`, `TwazServer abc.${"A".repeat(42)}=`]) {
      expect(parseServerAuth(bad)).toBeNull();
    }
  });

  it("compares hashes, never the plaintext, and rejects a missing or malformed hash", () => {
    expect(secretMatches(secret, sha256(secret))).toBe(true);
    expect(secretMatches(secret, sha256("B".repeat(43)))).toBe(false);
    expect(secretMatches(secret, secret)).toBe(false);
    expect(secretMatches(secret, null)).toBe(false);
    expect(secretMatches(secret, undefined)).toBe(false);
    expect(secretMatches(secret, "zz")).toBe(false);
    expect(secretMatches("no-such-server", "malformed")).toBe(false);
  });
});

describe("input validation", () => {
  it("accepts a well-formed heartbeat and rejects every bound", () => {
    expect(Heartbeat.safeParse(beat).success).toBe(true);
    expect(Heartbeat.safeParse({ ...beat, players: 16 }).success).toBe(true);
    // Stamp length matches the contract $defs/stamp and admit/join (1–128), not the 64-char family cap.
    expect(Heartbeat.safeParse({ ...beat, game_build: "a".repeat(128) }).success).toBe(true);
    expect(Heartbeat.safeParse({ ...beat, game_build: "a".repeat(65) }).success).toBe(true);
    for (const patch of [
      { players: 17 }, { players: -1 }, { players: 1.5 }, { maxPlayers: 10_001 }, { players: "1" },
      { instance_nonce: "n".repeat(15) }, { instance_nonce: "n".repeat(129) }, { protocol_version: -1 }, { protocol_version: 1.2 },
      { build_family: "" }, { game_build: undefined }, { game_build: "a".repeat(129) }, { server_runtime: "linux x64" },
    ]) {
      expect(Heartbeat.safeParse({ ...beat, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
  });

  it("validates server registration", () => {
    expect(CreateServer.safeParse(server).success).toBe(true);
    expect(CreateServer.safeParse({ ...server, host: "2001:db8::1" }).success).toBe(true);
    for (const patch of [
      { port: 0 }, { port: 65536 }, { port: "7777" }, { host: "evil.example/path" }, { host: "http://x.org" }, { host: "" },
      { clientPlatforms: [] }, { clientPlatforms: ["mac"] }, { clientPlatforms: ["win-x64", "win-x64"] },
      { name: "<script>" }, { buildFamily: "a b" }, { protocolVersion: -1 }, { gameBuild: "" },
    ]) {
      expect(CreateServer.safeParse({ ...server, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
  });

  it("validates endpoint updates with the same host and port rules as create", () => {
    expect(Endpoint.safeParse({ host: "play.example.org", port: 7777 }).success).toBe(true);
    expect(Endpoint.safeParse({ host: "192.168.4.34", port: 7777 }).success).toBe(true);
    expect(Endpoint.safeParse({ host: "2001:db8::1", port: 1 }).success).toBe(true);
    expect(Endpoint.safeParse({ host: "Play.Example.ORG", port: 65535 }).data).toEqual({ host: "play.example.org", port: 65535 });
    expect(Endpoint.safeParse({ host: "play.example.org" }).success).toBe(false);
    expect(Endpoint.safeParse({ port: 7777 }).success).toBe(false);
    for (const patch of [
      { port: 0 }, { port: 65536 }, { port: "7777" }, { host: "evil.example/path" }, { host: "http://x.org" }, { host: "" },
      { host: "x.org:7777" },
    ]) {
      expect(Endpoint.safeParse({ host: "play.example.org", port: 7777, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
  });
});

describe("heartbeat build adoption", () => {
  const stored = { instanceNonce: "old-nonce-16chars", buildFamily: "playtest-0.59", protocolVersion: 3 };
  const reported = { instance_nonce: stored.instanceNonce, build_family: stored.buildFamily, protocol_version: stored.protocolVersion };

  it("adopts family and protocol when the nonce belongs to a new process", () => {
    expect(decideHeartbeatBuild(stored, { ...reported, instance_nonce: "new-nonce-16chars", build_family: "playtest-0.60", protocol_version: 4 })).toEqual({
      kind: "adopt",
      oldBuildFamily: "playtest-0.59",
      newBuildFamily: "playtest-0.60",
      oldProtocolVersion: 3,
      newProtocolVersion: 4,
    });
    expect(decideHeartbeatBuild({ ...stored, instanceNonce: null }, { ...reported, build_family: "playtest-0.60" })).toMatchObject({
      kind: "adopt",
      newBuildFamily: "playtest-0.60",
    });
  });

  it("returns 409-equivalent mismatch when the same process reports a different family or protocol", () => {
    expect(decideHeartbeatBuild(stored, { ...reported, build_family: "playtest-0.60" })).toEqual({ kind: "mismatch" });
    expect(decideHeartbeatBuild(stored, { ...reported, protocol_version: 4 })).toEqual({ kind: "mismatch" });
  });

  it("leaves family and protocol alone when a new or same process reports the registered values", () => {
    expect(decideHeartbeatBuild(stored, reported)).toEqual({ kind: "ok" });
    expect(decideHeartbeatBuild(stored, { ...reported, instance_nonce: "new-nonce-16chars" })).toEqual({ kind: "ok" });
  });
});

describe("heartbeat route", () => {
  it("fails closed with 500 JSON, no-store, when the database errors", async () => {
    const { POST } = await import("../src/app/api/servers/heartbeat/route");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(new NextRequest("http://localhost:3000/api/servers/heartbeat", {
      method: "POST",
      headers: { authorization: `TwazServer abc.${secret}`, "content-type": "application/json" },
      body: JSON.stringify(beat),
    }));
    expect(err.mock.calls.flat().join(" ")).not.toContain(secret);
    err.mockRestore();
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "server_error" });
  });

  it("returns JSON no-store on unsupported methods, including OPTIONS", async () => {
    const { GET, PUT, PATCH, DELETE, OPTIONS } = await import("../src/app/api/servers/heartbeat/route");
    for (const method of [GET, PUT, PATCH, DELETE, OPTIONS]) {
      const res = method();
      expect(res.status).toBe(405);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("allow")).toBe("POST");
      expect(await res.json()).toEqual({ error: "method_not_allowed" });
    }
  });

  it("401s a missing or malformed credential without touching the DB", async () => {
    const { POST } = await import("../src/app/api/servers/heartbeat/route");
    const res = await POST(new NextRequest("http://localhost:3000/api/servers/heartbeat", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_server" });
  });
});

describe("capacity", () => {
  it("accepts integers 1-64 only, strictly", () => {
    for (const n of [1, 16, 64]) expect(Capacity.safeParse({ maxPlayers: n }).success).toBe(true);
    for (const b of [{ maxPlayers: 0 }, { maxPlayers: 65 }, { maxPlayers: 1.5 }, { maxPlayers: "8" }, {}, { maxPlayers: 8, x: 1 }]) {
      expect(Capacity.safeParse(b).success).toBe(false);
    }
  });
  it("defaults web create to 64 and bounds it", () => {
    expect(CreateServer.parse(server).maxPlayers).toBe(64);
    expect(CreateServer.parse({ ...server, maxPlayers: 10 }).maxPlayers).toBe(10);
    expect(CreateServer.safeParse({ ...server, maxPlayers: 65 }).success).toBe(false);
  });
  it("in-game create requires a capacity and rejects unknown or build fields", () => {
    const base = { name: "EU 2", region: "eu", host: "192.168.4.34", port: 7777, maxPlayers: 32 };
    expect(LauncherCreateServer.parse(base)).toEqual(base);
    const noCap: Record<string, unknown> = { ...base };
    delete noCap.maxPlayers;
    for (const b of [noCap, { ...base, secretHash: "x" }, { ...base, buildFamily: "x" }, { ...base, maxPlayers: 0 }, { ...base, port: 0 }]) {
      expect(LauncherCreateServer.safeParse(b).success).toBe(false);
    }
  });
  it("effective capacity is the admin cap, tightened by a reported cap", () => {
    expect(effectiveCapacity({ adminMaxPlayers: 64, maxPlayers: 0 })).toBe(64);
    expect(effectiveCapacity({ adminMaxPlayers: 64, maxPlayers: 8 })).toBe(8);
    expect(effectiveCapacity({ adminMaxPlayers: 16, maxPlayers: 100 })).toBe(16);
  });
  it("status is pending until a secret exists and a heartbeat arrived", () => {
    const at = new Date();
    expect(serverStatus({ status: "ACTIVE", secretHash: null, lastHeartbeatAt: null })).toBe("pending");
    expect(serverStatus({ status: "ACTIVE", secretHash: "h", lastHeartbeatAt: null })).toBe("pending");
    expect(serverStatus({ status: "ACTIVE", secretHash: "h", lastHeartbeatAt: at })).toBe("active");
    expect(serverStatus({ status: "DISABLED", secretHash: "h", lastHeartbeatAt: at })).toBe("disabled");
  });
  it("a null stored hash never matches", () => {
    expect(secretMatches("A".repeat(43), null)).toBe(false);
  });
});
