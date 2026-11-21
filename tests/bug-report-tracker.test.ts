import { afterEach, describe, expect, it, vi } from "vitest";
import { displayName } from "../src/lib/crypto";
import {
  DEDUPE_WINDOW_MS, DEFAULT_SUPERTRACKER_PROJECT, DEFAULT_SUPERTRACKER_URL, IN_GAME_REPORT_LABEL,
  ISSUE_TITLE_PREFIX, SYNC_MAX_AGE_MS, SYNC_MAX_ATTEMPTS, adminReportUrl,
  clipAtWord, formatAthensAndUtc, issueDescriptionFromReport, issueRefFromMcp, issueTitleFromReport,
  logTrackerConfigAtStartup, mcpRequestBody, nextAttemptAt, parseMcpResponse, plainText,
  shouldGiveUp, siteBaseUrl, titleSourceFromDescription, trackerConfig, trackerDedupeKey,
} from "../src/lib/bug-report-tracker";
import { callTrackerTool, createTrackerIssue, resetTrackerFetch, setTrackerFetch } from "../src/lib/bug-report-tracker-client";

afterEach(() => {
  resetTrackerFetch();
  vi.unstubAllEnvs();
});

const baseInput = {
  reportId: "br_abc12345",
  userId: "cluser0001",
  createdAt: new Date("2026-11-21T22:28:00.000Z"),
  category: "gameplay",
  description: "The door on the barn never opens when I press interact.",
  buildVersion: "playtest-0.73-abc1234",
  buildSha: "abc1234",
  buildBranch: "main",
  netMode: "official",
  serverId: "eu1",
  serverName: "EU 1",
  platform: { os: "Windows", osVersion: "10.0.22631", arch: "x64", unity: "6000.4.1f1" },
  gpu: { name: "NVIDIA GeForce RTX 3070", api: "D3D11", vramMb: 8192 },
  session: { map: "World_Main", playerCount: 6, inMenu: false },
};

describe("tracker config", () => {
  it("is disabled when the token is unset or blank, with documented defaults", () => {
    expect(trackerConfig({}).enabled).toBe(false);
    expect(trackerConfig({ SUPERTRACKER_TOKEN: "  " }).enabled).toBe(false);
    const cfg = trackerConfig({ SUPERTRACKER_TOKEN: " test-token " });
    expect(cfg).toEqual({
      enabled: true,
      token: "test-token",
      url: DEFAULT_SUPERTRACKER_URL,
      project: DEFAULT_SUPERTRACKER_PROJECT,
    });
    const custom = trackerConfig({
      SUPERTRACKER_TOKEN: "t",
      SUPERTRACKER_URL: "https://tracker.example.test/",
      SUPERTRACKER_PROJECT: "DEMO",
    });
    expect(custom.url).toBe("https://tracker.example.test");
    expect(custom.project).toBe("DEMO");
  });

  it("logs that the feature is disabled without mentioning a token value", () => {
    const lines: string[] = [];
    logTrackerConfigAtStartup({ AUTH_URL: "http://localhost:3000" }, { info: (...a: unknown[]) => lines.push(a.join(" ")) });
    expect(lines.join("\n")).toMatch(/SUPERTRACKER_TOKEN is unset/);
    expect(lines.join("\n")).not.toMatch(/test-token|Bearer|bug-reporter/);
  });

  it("logs that the feature is enabled with url and project only", () => {
    const lines: string[] = [];
    logTrackerConfigAtStartup({ SUPERTRACKER_TOKEN: "secret-value-should-not-appear" }, { info: (...a: unknown[]) => lines.push(a.join(" ")) });
    expect(lines.join("\n")).toMatch(/enabled/);
    expect(lines.join("\n")).toContain(DEFAULT_SUPERTRACKER_URL);
    expect(lines.join("\n")).toContain("TWAZ");
    expect(lines.join("\n")).not.toContain("secret-value-should-not-appear");
  });
});

describe("issue title", () => {
  it("uses the first line, or ~80 chars at a word boundary, prefixed with [In-game]", () => {
    expect(issueTitleFromReport({ description: "The barn door never opens.\nMore detail." }))
      .toBe(`${ISSUE_TITLE_PREFIX}The barn door never opens.`);
    const long = "alpha " + "word ".repeat(30);
    const title = issueTitleFromReport({ description: long });
    expect(title.startsWith(ISSUE_TITLE_PREFIX)).toBe(true);
    expect(title.length).toBeLessThanOrEqual(ISSUE_TITLE_PREFIX.length + 80);
    expect(title.endsWith(" ")).toBe(false);
    expect(titleSourceFromDescription("   ")).toBe("Bug report");
  });

  it("prefers summary, then title, and does not double the prefix", () => {
    expect(issueTitleFromReport({ description: "The barn door never opens when I press interact.", summary: "Barn door stuck" }))
      .toBe(`${ISSUE_TITLE_PREFIX}Barn door stuck`);
    expect(issueTitleFromReport({ description: "The barn door never opens when I press interact.", title: "Door jam" }))
      .toBe(`${ISSUE_TITLE_PREFIX}Door jam`);
    expect(issueTitleFromReport({ description: "x".repeat(20), summary: "[In-game] Already prefixed" }))
      .toBe(`${ISSUE_TITLE_PREFIX}Already prefixed`);
  });

  it("clips at a word boundary under the 255 cap", () => {
    const t = clipAtWord("one two three four", 10);
    expect(t.length).toBeLessThanOrEqual(10);
    expect(t).toBe("one two");
  });
});

describe("issue body and admin URL", () => {
  it("uses AUTH_URL for the admin link and falls back to the production origin", () => {
    expect(adminReportUrl("br_abc12345", { AUTH_URL: "https://theworldafterz.ncatechsolutions.org/" }))
      .toBe("https://theworldafterz.ncatechsolutions.org/admin/bug-reports/br_abc12345");
    expect(siteBaseUrl({})).toBe("https://theworldafterz.ncatechsolutions.org");
  });

  it("includes build, server, player display name, platform, GPU, category, admin link, and Athens + UTC times, never the email", () => {
    const body = issueDescriptionFromReport(baseInput, { AUTH_URL: "https://theworldafterz.ncatechsolutions.org" });
    expect(body).toContain("Category: gameplay");
    expect(body).toContain("playtest-0.73-abc1234");
    expect(body).toContain("sha abc1234");
    expect(body).toContain("branch main");
    expect(body).toContain("official — EU 1 (eu1)");
    expect(body).toContain(`Player: ${displayName("cluser0001")}`);
    expect(body).not.toMatch(/@|email/i);
    expect(body).toContain("Windows 10.0.22631, x64, Unity 6000.4.1f1");
    expect(body).toContain("NVIDIA GeForce RTX 3070 (D3D11, 8192 MB)");
    expect(body).toContain("https://theworldafterz.ncatechsolutions.org/admin/bug-reports/br_abc12345");
    const { athens, utc } = formatAthensAndUtc(baseInput.createdAt);
    expect(body).toContain(athens);
    expect(body).toContain(utc);
    expect(athens).toContain("Europe/Athens");
    expect(utc).toBe("2026-11-21T22:28:00.000Z");
    expect(body).not.toContain("Character:");
  });

  it("includes a character when the session has one, and escapes untrusted text", () => {
    const body = issueDescriptionFromReport({
      ...baseInput,
      description: "See <script>alert(1)</script> and ``` rm -rf /",
      session: { map: "World_Main", playerCount: 1, inMenu: false, character: "Hero <x>" },
    }, { AUTH_URL: "http://localhost:3000" });
    expect(body).toContain("Character: Hero &lt;x&gt;");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("''' rm -rf /");
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(plainText("a```b<c>")).toBe("a'''b&lt;c&gt;");
  });

  it("builds a stable dedupe key from player, build version, and title", () => {
    const a = trackerDedupeKey("u1", "v1", "[In-game] Door");
    const b = trackerDedupeKey("u1", "v1", "[In-game] Door");
    const c = trackerDedupeKey("u2", "v1", "[In-game] Door");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(DEDUPE_WINDOW_MS).toBe(10 * 60 * 1000);
  });
});

describe("backoff", () => {
  it("doubles from 15s and caps at one hour, and gives up after 16 attempts or 24h", () => {
    const t0 = new Date("2026-11-22T00:00:00.000Z");
    expect(nextAttemptAt(1, t0).toISOString()).toBe("2026-11-22T00:00:15.000Z");
    expect(nextAttemptAt(2, t0).toISOString()).toBe("2026-11-22T00:00:30.000Z");
    expect(nextAttemptAt(20, t0).getTime() - t0.getTime()).toBe(3600_000);
    expect(shouldGiveUp({ attemptCount: SYNC_MAX_ATTEMPTS, createdAt: t0 }, t0)).toBe(true);
    expect(shouldGiveUp({ attemptCount: 1, createdAt: t0 }, new Date(t0.getTime() + SYNC_MAX_AGE_MS))).toBe(true);
    expect(shouldGiveUp({ attemptCount: 1, createdAt: t0 }, new Date(t0.getTime() + 60_000))).toBe(false);
  });
});

describe("MCP client", () => {
  it("builds the documented JSON-RPC body and parses a create_issue result", () => {
    expect(mcpRequestBody("create_issue", { project: "TWAZ", summary: "x" })).toEqual({
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_issue", arguments: { project: "TWAZ", summary: "x" } },
    });
    const parsed = parseMcpResponse(200, {
      jsonrpc: "2.0", id: 1,
      result: { structuredContent: { issue: { key: "TWAZ-99", url: "https://tracker.ncatechsolutions.org/browse/TWAZ-99" } } },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(issueRefFromMcp(parsed.value)).toEqual({
      key: "TWAZ-99", url: "https://tracker.ncatechsolutions.org/browse/TWAZ-99",
    });
    const s503 = parseMcpResponse(503, {});
    expect(s503.ok).toBe(false);
    if (!s503.ok) expect(s503.retryable).toBe(true);
    const s400 = parseMcpResponse(400, {});
    expect(s400.ok).toBe(false);
    if (!s400.ok) expect(s400.retryable).toBe(false);
  });

  it("POSTs to /api/mcp with Bearer auth and create_issue arguments, without logging the token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: 1,
        result: { structuredContent: { issue: { key: "TWAZ-99", url: "https://tracker.ncatechsolutions.org/browse/TWAZ-99" } } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    setTrackerFetch(fetchMock);
    const result = await createTrackerIssue({
      enabled: true, token: "test-token", url: DEFAULT_SUPERTRACKER_URL, project: "TWAZ",
    }, { summary: "[In-game] Barn door stuck", description: "body" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.issue).toEqual({ key: "TWAZ-99", url: "https://tracker.ncatechsolutions.org/browse/TWAZ-99" });
    expect(calls[0].url).toBe(`${DEFAULT_SUPERTRACKER_URL}/api/mcp`);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    const body = JSON.parse(String(calls[0].init.body)) as { params: { name: string; arguments: Record<string, unknown> } };
    expect(body.params.name).toBe("create_issue");
    expect(body.params.arguments).toMatchObject({
      project: "TWAZ", type: "BUG", labels: [IN_GAME_REPORT_LABEL], summary: "[In-game] Barn door stuck",
    });
  });

  it("treats 5xx as retryable and 4xx as not (except 401/403/429)", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 503 }));
    const result = await callTrackerTool(
      { enabled: true, token: "test-token", url: DEFAULT_SUPERTRACKER_URL, project: "TWAZ" },
      "create_issue", { project: "TWAZ", summary: "x" }, fetchMock,
    );
    expect(result).toEqual({ ok: false, retryable: true, error: "http_503" });
  });
});
