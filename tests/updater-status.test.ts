import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Heartbeat, sanitizeUpdaterReason, UPDATER_REASON_MAX, updaterColumns, updaterHalt } from "../src/lib/servers";
import { UpdaterHaltBanner } from "../src/components/updater-halt";

const beat = { game_build: "0.64.0-linux", build_family: "playtest-0.64", protocol_version: 3, server_runtime: "linux-x64", instance_nonce: "n".repeat(16), players: 0, maxPlayers: 16 };
const parse = (updater: unknown) => Heartbeat.safeParse({ ...beat, updater });

describe("heartbeat updater field (game PR #79 shape)", () => {
  it("is optional: an old-build heartbeat without it parses and has no updater", () => {
    const r = Heartbeat.safeParse(beat);
    expect(r.success).toBe(true);
    expect(r.data?.updater).toBeUndefined();
  });

  it("accepts ok, and drops any reason sent with ok", () => {
    expect(parse({ state: "ok" }).data?.updater).toEqual({ state: "ok", reason: null });
    expect(parse({ state: "ok", reason: "ignored" }).data?.updater).toEqual({ state: "ok", reason: null });
  });

  it("accepts halted with a reason, and halted without one (the game omits an empty reason)", () => {
    expect(parse({ state: "halted", reason: "rollback of playtest-0.64-abc1234 was not healthy" }).data?.updater)
      .toEqual({ state: "halted", reason: "rollback of playtest-0.64-abc1234 was not healthy" });
    expect(parse({ state: "halted" }).data?.updater).toEqual({ state: "halted", reason: null });
    expect(parse({ state: "halted", reason: "  \n\t " }).data?.updater).toEqual({ state: "halted", reason: null });
  });

  it("clamps an over-long reason to 200 and flattens multi-line / control characters to one line", () => {
    const long = parse({ state: "halted", reason: "x".repeat(900) }).data?.updater;
    expect(long?.reason).toHaveLength(UPDATER_REASON_MAX);
    expect(parse({ state: "halted", reason: " line one\r\nline two\u0000\u001b[31m\u2028three\u0085 " }).data?.updater?.reason)
      .toBe("line one line two[31m three");
  });

  it("400s (fails to parse) an unknown state, a wrong shape or an absurd reason", () => {
    for (const bad of [{ state: "weird" }, { state: "HALTED", reason: "x" }, {}, { reason: "x" }, { state: "halted", reason: 5 },
      { state: "halted", reason: null }, { state: "halted", reason: "x".repeat(1001) }, "ok", null, [], 1]) {
      expect(parse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("sanitizeUpdaterReason", () => {
  it("matches the game's sanitizer on its own examples and never splits a surrogate pair", () => {
    expect(sanitizeUpdaterReason("no previous build")).toBe("no previous build");
    expect(sanitizeUpdaterReason("a\n\n\nb")).toBe("a b");
    expect(sanitizeUpdaterReason("\u007fdel")).toBe("del");
    const emoji = "x".repeat(199) + "😀";
    expect(sanitizeUpdaterReason(emoji)).toBe("x".repeat(199));
  });
});

describe("updater columns and admin view", () => {
  const now = new Date("2026-11-17T08:00:00Z");
  it("stores the report with its time, and clears everything when the field is missing", () => {
    expect(updaterColumns({ state: "halted", reason: "r" }, now)).toEqual({ updaterState: "halted", updaterReason: "r", updaterReportedAt: now });
    expect(updaterColumns({ state: "ok", reason: null }, now)).toEqual({ updaterState: "ok", updaterReason: null, updaterReportedAt: now });
    expect(updaterColumns(undefined, now)).toEqual({ updaterState: null, updaterReason: null, updaterReportedAt: null });
  });
  it("only a halted state is a halt", () => {
    expect(updaterHalt({ updaterState: "halted", updaterReason: "r", updaterReportedAt: now })).toEqual({ reason: "r", reportedAt: now });
    expect(updaterHalt({ updaterState: "ok", updaterReason: null, updaterReportedAt: now })).toBeNull();
    expect(updaterHalt({ updaterState: null, updaterReason: null, updaterReportedAt: null })).toBeNull();
  });
});

describe("UpdaterHaltBanner", () => {
  const render = (s: { updaterState: string | null; updaterReason: string | null; updaterReportedAt: Date | null }) =>
    renderToStaticMarkup(createElement(UpdaterHaltBanner, { server: s }));
  it("renders nothing for ok or missing", () => {
    expect(render({ updaterState: "ok", updaterReason: null, updaterReportedAt: new Date() })).toBe("");
    expect(render({ updaterState: null, updaterReason: null, updaterReportedAt: null })).toBe("");
  });
  it("renders the reason as escaped text, never as HTML", () => {
    const html = render({ updaterState: "halted", updaterReason: `<img src=x onerror="alert(1)"><script>x</script>&`, updaterReportedAt: new Date("2026-11-17T06:00:00Z") });
    expect(html).toContain("Updater halted:");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;x&lt;/script&gt;&amp;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("17 Nov 2026, 08:00 (Athens)");
    expect(html).toContain("text-red-200");
  });
  it("says so when halted without a reason", () => {
    expect(render({ updaterState: "halted", updaterReason: null, updaterReportedAt: null })).toContain("no reason reported");
  });
});
