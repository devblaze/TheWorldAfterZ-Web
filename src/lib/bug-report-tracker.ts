import { createHash } from "node:crypto";
import { displayName } from "@/lib/crypto";
import type { BugReportPayload } from "@/lib/bug-reports";

export const DEFAULT_SUPERTRACKER_URL = "https://tracker.ncatechsolutions.org";
export const DEFAULT_SUPERTRACKER_PROJECT = "TWAZ";
export const IN_GAME_REPORT_LABEL = "in-game-report";
export const ISSUE_TITLE_PREFIX = "[In-game] ";
export const TITLE_SOURCE_MAX = 80;
export const ISSUE_SUMMARY_MAX = 255;
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
export const SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const SYNC_MAX_ATTEMPTS = 16;
export const SYNC_FETCH_TIMEOUT_MS = 15_000;
export const SYNC_TICK_INTERVAL_MS = 15_000;
export const DEFAULT_SITE_BASE_URL = "https://theworldafterz.ncatechsolutions.org";

export const TRACKER_SYNC_STATUS = {
  pending: "pending",
  pendingComment: "pending_comment",
  synced: "synced",
  failed: "failed",
} as const;

export type TrackerSyncStatus = (typeof TRACKER_SYNC_STATUS)[keyof typeof TRACKER_SYNC_STATUS];

export type TrackerConfig = {
  enabled: boolean;
  token: string;
  url: string;
  project: string;
};

/** Read tracker env. The token is never logged; an empty token disables the feature. */
export function trackerConfig(env: Record<string, string | undefined> = process.env): TrackerConfig {
  const token = typeof env.SUPERTRACKER_TOKEN === "string" ? env.SUPERTRACKER_TOKEN.trim() : "";
  const rawUrl = typeof env.SUPERTRACKER_URL === "string" ? env.SUPERTRACKER_URL.trim() : "";
  const rawProject = typeof env.SUPERTRACKER_PROJECT === "string" ? env.SUPERTRACKER_PROJECT.trim() : "";
  const url = (rawUrl || DEFAULT_SUPERTRACKER_URL).replace(/\/+$/, "");
  const project = rawProject || DEFAULT_SUPERTRACKER_PROJECT;
  return { enabled: token.length > 0, token, url, project };
}

export function logTrackerConfigAtStartup(env: Record<string, string | undefined> = process.env, log: Pick<Console, "info"> = console) {
  const { enabled, url, project } = trackerConfig(env);
  if (!enabled) {
    log.info("bug-report tracker sync disabled: SUPERTRACKER_TOKEN is unset");
    return;
  }
  log.info("bug-report tracker sync enabled", `url=${url}`, `project=${project}`);
}

export function siteBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = typeof env.AUTH_URL === "string" ? env.AUTH_URL.trim() : "";
  if (raw) {
    try {
      return new URL(raw).origin;
    } catch {
      return raw.replace(/\/+$/, "");
    }
  }
  return DEFAULT_SITE_BASE_URL;
}

export function adminReportUrl(reportId: string, env: Record<string, string | undefined> = process.env): string {
  return `${siteBaseUrl(env)}/admin/bug-reports/${reportId}`;
}

export function clipAtWord(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max);
  const sp = slice.lastIndexOf(" ");
  const cut = sp >= Math.floor(max * 0.6) ? slice.slice(0, sp) : slice;
  return cut.trimEnd();
}

export function titleSourceFromDescription(description: string, max = TITLE_SOURCE_MAX): string {
  const first = description.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!first) return "Bug report";
  return first.length <= max ? first : clipAtWord(first, max);
}

/** Prefer an optional summary/title field; otherwise the first line or ~80 chars of description. */
export function issueTitleFromReport(input: {
  description: string;
  summary?: string | null;
  title?: string | null;
}): string {
  const explicit = (input.summary ?? "").trim() || (input.title ?? "").trim();
  const source = explicit || titleSourceFromDescription(input.description);
  const body = source.replace(/^\[In-game\]\s*/i, "").trim() || "Bug report";
  const title = `${ISSUE_TITLE_PREFIX}${body}`;
  if (title.length <= ISSUE_SUMMARY_MAX) return title;
  return clipAtWord(title, ISSUE_SUMMARY_MAX);
}

export function trackerDedupeKey(userId: string, buildVersion: string, title: string): string {
  return createHash("sha256").update(`${userId}\0${buildVersion}\0${title}`, "utf8").digest("hex");
}

/** Neutralise markdown / HTML in untrusted player text so it stays plain in the issue body. */
export function plainText(value: unknown): string {
  if (value == null) return "";
  return String(value)
    .replace(/\r\n/g, "\n")
    .replace(/```/g, "'''")
    .replace(/[<>]/g, (ch) => (ch === "<" ? "&lt;" : "&gt;"));
}

export function formatAthensAndUtc(date: Date): { athens: string; utc: string } {
  const athens = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Athens",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date) + " (Europe/Athens)";
  return { athens, utc: date.toISOString() };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function characterFromSession(session: unknown): string | undefined {
  const rec = asRecord(session);
  for (const key of ["character", "characterName", "character_name"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export type TrackerIssueInput = {
  reportId: string;
  userId: string;
  createdAt: Date;
  category: string;
  description: string;
  summary?: string | null;
  title?: string | null;
  buildVersion: string;
  buildSha: string;
  buildBranch: string;
  netMode: string;
  serverId?: string | null;
  serverName?: string | null;
  platform: unknown;
  gpu: unknown;
  session: unknown;
};

export function trackerIssueInputFromPayload(
  reportId: string,
  userId: string,
  createdAt: Date,
  p: BugReportPayload,
): TrackerIssueInput {
  return {
    reportId,
    userId,
    createdAt,
    category: p.category,
    description: p.description,
    summary: p.summary,
    title: p.title,
    buildVersion: p.build.version,
    buildSha: p.build.sha,
    buildBranch: p.build.branch,
    netMode: p.net.mode,
    serverId: p.net.serverId,
    serverName: p.net.serverName,
    platform: p.platform,
    gpu: p.gpu,
    session: p.session,
  };
}

function formatServer(input: TrackerIssueInput): string {
  const mode = plainText(input.netMode) || "unknown";
  const name = (input.serverName ?? "").trim();
  const id = (input.serverId ?? "").trim();
  if (name && id) return `${mode} — ${plainText(name)} (${plainText(id)})`;
  if (name) return `${mode} — ${plainText(name)}`;
  if (id) return `${mode} — ${plainText(id)}`;
  return mode;
}

function formatPlatform(platform: unknown): string {
  const p = asRecord(platform);
  const parts = [
    [p.os, p.osVersion].filter((v) => typeof v === "string" && v.trim()).join(" "),
    typeof p.arch === "string" && p.arch.trim() ? p.arch.trim() : "",
    typeof p.unity === "string" && p.unity.trim() ? `Unity ${p.unity.trim()}` : "",
    typeof p.deviceModel === "string" && p.deviceModel.trim() ? p.deviceModel.trim() : "",
  ].filter(Boolean);
  return parts.length ? plainText(parts.join(", ")) : "unknown";
}

function formatGpu(gpu: unknown): string {
  const g = asRecord(gpu);
  const name = typeof g.name === "string" && g.name.trim() ? g.name.trim() : "unknown";
  const bits: string[] = [];
  if (typeof g.api === "string" && g.api.trim()) bits.push(g.api.trim());
  if (typeof g.vramMb === "number" && Number.isFinite(g.vramMb)) bits.push(`${g.vramMb} MB`);
  return bits.length ? `${plainText(name)} (${plainText(bits.join(", "))})` : plainText(name);
}

export function issueDescriptionFromReport(input: TrackerIssueInput, env: Record<string, string | undefined> = process.env): string {
  const times = formatAthensAndUtc(input.createdAt);
  const player = displayName(input.userId);
  const character = characterFromSession(input.session);
  const buildBits = [
    plainText(input.buildVersion) || "unknown",
    input.buildSha ? `sha ${plainText(input.buildSha)}` : "",
    input.buildBranch ? `branch ${plainText(input.buildBranch)}` : "",
  ].filter(Boolean);
  const lines = [
    "An in-game bug report was accepted.",
    "",
    `Category: ${plainText(input.category)}`,
    `Build: ${buildBits.join(", ")}`,
    `Server: ${formatServer(input)}`,
    `Player: ${plainText(player)}`,
  ];
  if (character) lines.push(`Character: ${plainText(character)}`);
  lines.push(
    `Platform: ${formatPlatform(input.platform)}`,
    `GPU: ${formatGpu(input.gpu)}`,
    `Submitted: ${times.athens}`,
    `Timestamp (UTC): ${times.utc}`,
    "",
    "Admin report (logs and optional replay):",
    adminReportUrl(input.reportId, env),
    "",
    "Player description:",
    "```",
    plainText(input.description) || "(empty)",
    "```",
  );
  return lines.join("\n");
}

export function dedupeCommentBody(input: { reportId: string; createdAt: Date }, env: Record<string, string | undefined> = process.env): string {
  const times = formatAthensAndUtc(input.createdAt);
  return [
    "Another in-game report matched this issue (same player, build, and title within 10 minutes).",
    "",
    `Submitted: ${times.athens}`,
    `Timestamp (UTC): ${times.utc}`,
    `Admin report: ${adminReportUrl(input.reportId, env)}`,
  ].join("\n");
}

export function nextAttemptAt(attemptCount: number, now = new Date()): Date {
  const exp = Math.max(0, attemptCount - 1);
  const seconds = Math.min(15 * 2 ** exp, 3600);
  return new Date(now.getTime() + seconds * 1000);
}

export function shouldGiveUp(input: { attemptCount: number; createdAt: Date }, now = new Date()): boolean {
  if (input.attemptCount >= SYNC_MAX_ATTEMPTS) return true;
  return now.getTime() - input.createdAt.getTime() >= SYNC_MAX_AGE_MS;
}

export type McpToolResult = { ok: true; value: unknown } | { ok: false; retryable: boolean; error: string };

export function parseMcpResponse(status: number, body: unknown): McpToolResult {
  if (status === 429 || status >= 500) return { ok: false, retryable: true, error: `http_${status}` };
  if (status === 408) return { ok: false, retryable: true, error: `http_${status}` };
  if (status < 200 || status >= 300) {
    return { ok: false, retryable: status === 401 || status === 403, error: `http_${status}` };
  }
  if (!body || typeof body !== "object") return { ok: false, retryable: true, error: "invalid_rpc" };
  const rec = body as Record<string, unknown>;
  if (rec.error) {
    const err = rec.error as Record<string, unknown>;
    const code = typeof err.code === "number" ? err.code : 0;
    return { ok: false, retryable: code === -32000 || code === -32603, error: "rpc_error" };
  }
  const result = rec.result;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (r.isError) return { ok: false, retryable: true, error: "rpc_tool_error" };
    return { ok: true, value: r.structuredContent ?? r.content ?? r };
  }
  return { ok: false, retryable: true, error: "invalid_rpc" };
}

export function issueRefFromMcp(value: unknown): { key: string; url?: string } | null {
  const rec = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!rec) return null;
  const issue = rec.issue && typeof rec.issue === "object" && !Array.isArray(rec.issue)
    ? rec.issue as Record<string, unknown>
    : rec;
  const key = typeof issue.key === "string" ? issue.key.trim() : "";
  if (!key) return null;
  const url = typeof issue.url === "string" && issue.url.trim() ? issue.url.trim() : undefined;
  return { key, url };
}

export function mcpRequestBody(tool: string, args: Record<string, unknown>, id = 1) {
  return { jsonrpc: "2.0" as const, id, method: "tools/call", params: { name: tool, arguments: args } };
}
