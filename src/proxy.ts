import { NextResponse, type NextRequest } from "next/server";
import { originAllowed } from "@/lib/origin";

// The launcher calls these without a browser origin. Consent POST stays on the check.
const LAUNCHER_CSRF_EXEMPT = new Set(["/api/launcher/token", "/api/launcher/revoke", "/api/launcher/play-check"]);

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const mutating = request.method !== "GET" && request.method !== "HEAD";
  const api = pathname.startsWith("/api/") && !pathname.startsWith("/api/auth/");
  const consent = pathname === "/launcher/authorize";
  if (mutating && (consent || (api && !LAUNCHER_CSRF_EXEMPT.has(pathname))) && !originAllowed(request.headers, request.nextUrl.origin)) {
    const headers = new Headers();
    if (consent || pathname.startsWith("/api/launcher/")) {
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
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  if (pathname === "/launcher/authorize" || pathname.startsWith("/api/launcher/")) {
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
