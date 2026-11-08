import { launcherJson } from "@/lib/launcher/http";
import { revokePresentedToken } from "@/lib/launcher/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// RFC 7009: unknown, forged, and mismatched tokens are still 200. A database failure is 500 so the
// launcher does not tell the player the server accepted a revoke that did not happen.
export async function POST(req: Request) {
  try {
    let token: string | null = null;
    let hint: string | null = null;
    const ct = (req.headers.get("content-type") ?? "").toLowerCase();
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const rawToken = form.get("token");
      const rawHint = form.get("token_type_hint");
      if (typeof rawToken === "string" && rawToken.length > 0 && rawToken.length <= 4096) token = rawToken;
      if (typeof rawHint === "string" && rawHint.length <= 64) hint = rawHint;
    }
    if (token) await revokePresentedToken(token, hint);
    return launcherJson({});
  } catch (err) {
    console.error("launcher revoke failed", err instanceof Error ? err.name : "error");
    return launcherJson({ error: "server_error" }, 500);
  }
}
