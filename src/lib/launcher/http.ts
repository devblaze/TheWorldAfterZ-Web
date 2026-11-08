const NO_STORE = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
} as const;

const PAGE = {
  ...NO_STORE,
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "frame-ancestors 'none'",
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
