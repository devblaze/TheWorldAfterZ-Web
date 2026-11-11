const NO_STORE = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
} as const;

const PAGE = {
  ...NO_STORE,
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "frame-ancestors 'none'; form-action 'self' http://127.0.0.1:*",
} as const;

export function launcherJson(body: unknown, status = 200, extra?: Record<string, string>) {
  return Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
}

export function launcherRedirect(location: string, status: 302 | 303) {
  return new Response(null, { status, headers: { Location: location, ...PAGE } });
}

export function launcherHtml(body: string, status = 200, extra?: Record<string, string>) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...PAGE, ...extra },
  });
}

/** 405 JSON for every method a launcher/server API route does not serve. */
export const methodNotAllowed = (allow: string) => () => launcherJson({ error: "method_not_allowed" }, 405, { Allow: allow });

/** Parses a JSON request body of at most `max` bytes; null on wrong content type, oversize or bad JSON. */
export async function readJsonBody(req: Request, max: number): Promise<{ value: unknown } | null> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return null;
  // Stop consuming oversized bodies instead of buffering an unbounded request.
  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}
