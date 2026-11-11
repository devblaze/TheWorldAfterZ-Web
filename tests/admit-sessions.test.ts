import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { AdmitRequest, CHECK_MAX_IDS, CheckRequest, EndRequest, SERVER_LIMITS } from "../src/lib/servers";

// Any DB access throws, to prove every route fails closed.
vi.mock("@/lib/db", () => ({
  prisma: new Proxy({}, { get: () => new Proxy(() => {}, { get: () => () => Promise.reject(new Error("db down")), apply: () => Promise.reject(new Error("db down")) }) }),
}));

const secret = "A".repeat(43);
const admit = { ticket: "t".repeat(43), instance_nonce: "n".repeat(16), connection_id: "7", build_family: "playtest-0.59", protocol_version: 3, game_build: "0.59.1-win" };
const routes = {
  admit: { path: "/api/servers/admit", mod: () => import("../src/app/api/servers/admit/route"), body: admit },
  check: { path: "/api/servers/sessions/check", mod: () => import("../src/app/api/servers/sessions/check/route"), body: { serverSessionIds: ["a"] } },
  end: { path: "/api/servers/sessions/end", mod: () => import("../src/app/api/servers/sessions/end/route"), body: { serverSessionId: "a", reason: "client_left" } },
};

describe("admit/check/end schemas", () => {
  it("accepts a well-formed admit and rejects every bound", () => {
    expect(AdmitRequest.safeParse(admit).success).toBe(true);
    expect(AdmitRequest.safeParse({ ...admit, connection_id: "18446744073709551615" }).success).toBe(true);
    for (const patch of [
      { ticket: "" }, { ticket: "t".repeat(257) }, { instance_nonce: "n".repeat(15) }, { instance_nonce: "n".repeat(129) },
      { connection_id: "01" }, { connection_id: "00" }, { connection_id: 7 }, { connection_id: "-1" }, { connection_id: "" }, { connection_id: "1.5" }, { connection_id: "18446744073709551616" },
      { connection_id: "9".repeat(21) }, { build_family: "" }, { protocol_version: "3" }, { protocol_version: -1 }, { game_build: "" },
      { game_build: "a b" }, { game_build: undefined }, { extra: 1 },
    ]) {
      expect(AdmitRequest.safeParse({ ...admit, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
  });

  it("caps and shapes the check list", () => {
    expect(CheckRequest.safeParse({ serverSessionIds: [] }).success).toBe(true);
    expect(CheckRequest.safeParse({ serverSessionIds: Array.from({ length: CHECK_MAX_IDS }, (_, i) => `s${i}`) }).success).toBe(true);
    for (const body of [
      { serverSessionIds: Array.from({ length: CHECK_MAX_IDS + 1 }, (_, i) => `s${i}`) }, { serverSessionIds: [""] }, { serverSessionIds: ["a b"] },
      { serverSessionIds: ["x".repeat(65)] }, { serverSessionIds: [1] }, { serverSessionIds: "a" }, {}, { serverSessionIds: [], extra: 1 },
    ]) {
      expect(CheckRequest.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it("shapes the end request", () => {
    expect(EndRequest.safeParse({ serverSessionId: "abc", reason: "server_shutdown" }).success).toBe(true);
    for (const body of [{ serverSessionId: "", reason: "x" }, { serverSessionId: "a", reason: "" }, { serverSessionId: "a", reason: "a b" }, { serverSessionId: "a", reason: "x".repeat(65) }, { serverSessionId: "a" }, { serverSessionId: "a", reason: "x", extra: 1 }]) {
      expect(EndRequest.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it("documents the limits", () => {
    expect(SERVER_LIMITS.admit.limit).toBe(60);
    expect(SERVER_LIMITS.check.limit).toBe(120);
    expect(SERVER_LIMITS.end.limit).toBe(600);
  });
});

describe.each(Object.entries(routes))("%s route", (_name, r) => {
  const req = (headers: Record<string, string>) =>
    new NextRequest(`http://localhost:3000${r.path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(r.body) });

  it("401s a missing or malformed credential without touching the DB", async () => {
    const { POST } = await r.mod();
    for (const headers of <Record<string, string>[]>[{}, { authorization: `Bearer abc.${secret}` }, { cookie: "session=x" }]) {
      const res = await POST(req(headers));
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "invalid_server" });
    }
  });

  it("fails closed with 500 JSON, no-store, when the database errors", async () => {
    const { POST } = await r.mod();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(req({ authorization: `TwazServer abc.${secret}` }));
    expect(err.mock.calls.flat().join(" ")).not.toContain(secret);
    err.mockRestore();
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "server_error" });
  });

  it("returns JSON no-store 405 on unsupported methods, including OPTIONS", async () => {
    const { GET, PUT, PATCH, DELETE, OPTIONS } = await r.mod();
    for (const method of [GET, PUT, PATCH, DELETE, OPTIONS]) {
      const res = method();
      expect(res.status).toBe(405);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("allow")).toBe("POST");
      expect(await res.json()).toEqual({ error: "method_not_allowed" });
    }
  });
});
