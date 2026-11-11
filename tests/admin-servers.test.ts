import { beforeEach, describe, expect, it, vi } from "vitest";

const { guard } = vi.hoisted(() => ({ guard: vi.fn() }));
vi.mock("@/lib/session", () => ({
  adminOrNull: guard,
  json: (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } }),
}));
vi.mock("@/lib/db", () => ({ prisma: { $transaction: async () => { throw new Error("db unavailable"); } } }));

import { POST as create } from "../src/app/api/admin/servers/route";
import { POST as rotate } from "../src/app/api/admin/servers/[id]/rotate/route";
import { POST as disable } from "../src/app/api/admin/servers/[id]/disable/route";
import { POST as compat } from "../src/app/api/admin/servers/[id]/compat/route";

const input = {
  name: "EU 1", region: "eu", host: "play.example.org", port: 7777,
  gameBuild: "0.59.1", buildFamily: "playtest-0.59", protocolVersion: 3, clientPlatforms: ["win-x64"],
};
const request = () => new Request("http://localhost:3000/api/admin/servers", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
});
const calls = () => [create(request()), rotate(request(), { params: Promise.resolve({ id: "abc123" }) }),
  disable(request(), { params: Promise.resolve({ id: "abc123" }) }), compat(request(), { params: Promise.resolve({ id: "abc123" }) })];

beforeEach(() => { guard.mockReset(); });

describe("admin server failure handling", () => {
  it("denies database failures with no-store JSON on every action", async () => {
    guard.mockResolvedValue({ id: "admin" });
    for (const res of await Promise.all(calls())) {
      expect(res.status).toBe(500);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("location")).toBeNull();
      expect(await res.json()).toEqual({ error: "server_error" });
    }
  });
  it("denies an authentication subsystem failure on every action", async () => {
    guard.mockRejectedValue(new Error("auth unavailable"));
    for (const res of await Promise.all(calls())) {
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "server_error" });
    }
  });
});
