import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "../src/lib/crypto";
import { CreateServer, Heartbeat, newServerSecret, parseServerAuth, secretMatches } from "../src/lib/servers";

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
