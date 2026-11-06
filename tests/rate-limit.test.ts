import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", () => ({ prisma: {} }));
const { ipFrom, rateLimit, windowStart } = await import("../src/lib/rate-limit");

// In-memory stand-in with the same semantics as the Postgres upsert.
function memoryHit() {
  const rows = new Map<string, { windowStart: number; count: number }>();
  return async (key: string, ws: Date) => {
    const r = rows.get(key);
    const count = r && r.windowStart === ws.getTime() ? r.count + 1 : 1;
    rows.set(key, { windowStart: ws.getTime(), count });
    return count;
  };
}

describe("fixed-window rate limiter", () => {
  const W = 60_000;
  const t0 = 1_700_000_040_000;

  it("aligns windows to fixed boundaries", () => {
    expect(windowStart(t0, W).getTime() % W).toBe(0);
    expect(windowStart(t0 + 1, W)).toEqual(windowStart(t0, W));
  });

  it("allows up to the limit, then blocks until the next window", async () => {
    const hit = memoryHit();
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await rateLimit("k", 3, W, t0, hit));
    expect(results).toEqual([true, true, true, false]);
    expect(await rateLimit("other", 3, W, t0, hit)).toBe(true);
    const next = windowStart(t0, W).getTime() + W;
    expect(await rateLimit("k", 3, W, next, hit)).toBe(true);
  });

  it("takes the proxy-appended IP, not client-supplied hops", () => {
    expect(ipFrom(new Headers({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }))).toBe("1.2.3.4");
    expect(ipFrom(new Headers({ "x-real-ip": "5.5.5.5", "x-forwarded-for": "6.6.6.6" }))).toBe("5.5.5.5");
    expect(ipFrom(new Headers())).toBe("unknown");
  });
});
