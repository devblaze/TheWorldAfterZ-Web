import { NextResponse, type NextRequest } from "next/server";
import { originAllowed } from "@/lib/origin";

// The launcher and dedicated servers call these without a browser origin and never read cookies. Consent POST stays on the check.
const LAUNCHER_CSRF_EXEMPT = new Set([
  "/api/launcher/token",
  "/api/launcher/revoke",
  "/api/launcher/play-check",
  "/api/launcher/servers",
  "/api/launcher/join-ticket",
  "/api/launcher/admin/servers",
]);
// In-game admin routes: bearer token plus a server-side role check; they never read cookies.
const LAUNCHER_ADMIN_SERVER = /^\/api\/launcher\/admin\/servers\/[a-z0-9]{1,64}$/;
const csrfExempt = (pathname: string) =>
  LAUNCHER_CSRF_EXEMPT.has(pathname) || LAUNCHER_ADMIN_SERVER.test(pathname) || pathname.startsWith("/api/servers/");
const noStorePath = (pathname: string) =>
  pathname === "/launcher/authorize" || pathname.startsWith("/api/launcher/") || pathname.startsWith("/api/servers/");

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const mutating = request.method !== "GET" && request.method !== "HEAD";
  const api = pathname.startsWith("/api/") && !pathname.startsWith("/api/auth/");
  const consent = pathname === "/launcher/authorize";
  if (mutating && (consent || (api && !csrfExempt(pathname))) && !originAllowed(request.headers, request.nextUrl.origin)) {
    const headers = new Headers();
    if (noStorePath(pathname)) {
      headers.set("Cache-Control", "no-store");
      headers.set("Pragma", "no-cache");
    }
    return new NextResponse("Forbidden", { status: 403, headers });
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    // CSP form-action also covers the redirect after a form POST. Approve sends
    // the browser to the launcher's loopback callback, so this path must allow it.
    pathname === "/launcher/authorize" ? "form-action 'self' http://127.0.0.1:*" : "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  if (noStorePath(pathname)) {
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Pragma", "no-cache");
  }
  if (pathname === "/launcher/authorize") response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
