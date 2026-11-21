import {
  IN_GAME_REPORT_LABEL, SYNC_FETCH_TIMEOUT_MS, issueRefFromMcp, mcpRequestBody, parseMcpResponse,
  type TrackerConfig,
} from "@/lib/bug-report-tracker";

export type TrackerFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let injectedFetch: TrackerFetch | undefined;

/** Test-only: inject a mock HTTP function. Never used in production. */
export function setTrackerFetch(fn: TrackerFetch | undefined) {
  injectedFetch = fn;
}

export function resetTrackerFetch() {
  injectedFetch = undefined;
}

export function hasInjectedTrackerFetch() {
  return typeof injectedFetch === "function";
}

async function doFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const fn = injectedFetch ?? fetch;
  return fn(input, init);
}

export type TrackerCallResult =
  | { ok: true; value: unknown }
  | { ok: false; retryable: boolean; error: string };

export async function callTrackerTool(
  cfg: TrackerConfig,
  tool: string,
  args: Record<string, unknown>,
  fetchImpl: TrackerFetch = doFetch,
): Promise<TrackerCallResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.url}/api/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(mcpRequestBody(tool, args)),
      signal: AbortSignal.timeout(SYNC_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "error";
    const retryable = name === "TimeoutError" || name === "AbortError" || name === "TypeError";
    return { ok: false, retryable: retryable || name !== "SyntaxError", error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
  }

  let body: unknown = null;
  try {
    const text = await res.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    if (res.status >= 500 || res.status === 429 || res.status === 0) {
      return { ok: false, retryable: true, error: `http_${res.status || 0}` };
    }
    return { ok: false, retryable: false, error: `http_${res.status}_invalid_json` };
  }
  return parseMcpResponse(res.status, body);
}

export async function createTrackerIssue(
  cfg: TrackerConfig,
  input: { summary: string; description: string },
  fetchImpl?: TrackerFetch,
): Promise<TrackerCallResult & { issue?: { key: string; url?: string } }> {
  const result = await callTrackerTool(cfg, "create_issue", {
    project: cfg.project,
    summary: input.summary,
    description: input.description,
    type: "BUG",
    labels: [IN_GAME_REPORT_LABEL],
  }, fetchImpl ?? doFetch);
  if (!result.ok) return result;
  const issue = issueRefFromMcp(result.value);
  if (!issue) return { ok: false, retryable: true, error: "missing_issue_key" };
  return { ok: true, value: result.value, issue };
}

export async function commentOnTrackerIssue(
  cfg: TrackerConfig,
  input: { key: string; body: string },
  fetchImpl?: TrackerFetch,
): Promise<TrackerCallResult> {
  return callTrackerTool(cfg, "add_comment", { key: input.key, body: input.body }, fetchImpl ?? doFetch);
}
