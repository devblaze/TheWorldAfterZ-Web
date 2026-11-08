import { randomBytes } from "node:crypto";
import { sha256 } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { consentPage, messagePage } from "@/lib/launcher/html";
import { launcherHtml, launcherRedirect } from "@/lib/launcher/http";
import { pruneNativeAuth } from "@/lib/launcher/store";
import { CODE_TTL_MS } from "@/lib/launcher/constants";
import { authorizePath, echoState, evaluateAuthorize, safeLauncherNext, type AuthorizeCheck, type AuthorizeInput } from "@/lib/launcher/validate";
import { originAllowed } from "@/lib/origin";
import { limitLauncherAuthorize } from "@/lib/rate-limit";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FIELD_MAX = 4096;

function nonceOf(req: Request) {
  return req.headers.get("x-nonce") ?? "";
}

function take(value: string | null): string | null {
  if (value === null || value.length > FIELD_MAX) return null;
  return value;
}

function fromSearch(search: URLSearchParams): AuthorizeInput {
  return {
    clientId: take(search.get("client_id")),
    redirectUri: take(search.get("redirect_uri")),
    responseType: take(search.get("response_type")),
    state: take(search.get("state")),
    codeChallenge: take(search.get("code_challenge")),
    codeChallengeMethod: take(search.get("code_challenge_method")),
  };
}

async function fromForm(req: Request): Promise<{ input: AuthorizeInput; userId: string | null; decision: string | null } | "bad"> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/x-www-form-urlencoded") && !ct.includes("multipart/form-data")) return "bad";
  const form = await req.formData();
  const read = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? take(v) : null;
  };
  return {
    input: {
      clientId: read("client_id"),
      redirectUri: read("redirect_uri"),
      responseType: read("response_type"),
      state: read("state"),
      codeChallenge: read("code_challenge"),
      codeChallengeMethod: read("code_challenge_method"),
    },
    userId: read("userId"),
    decision: read("decision"),
  };
}

function invalidClient(nonce: string) {
  return launcherHtml(
    messagePage("Sign-in link not valid", "This sign-in link is not valid. Close this window and press Log in in the launcher again.", nonce),
  );
}

function oauthError(redirectUri: string, error: string, state: string | null) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  const echoed = echoState(state);
  if (echoed) url.searchParams.set("state", echoed);
  return launcherRedirect(url.toString(), 302);
}

function toLogin(checked: Extract<AuthorizeCheck, { ok: true }>) {
  const next = safeLauncherNext(authorizePath(checked));
  return launcherRedirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login", 303);
}

function verifyEmail(nonce: string) {
  return launcherHtml(
    messagePage("Verify your email", "Verify your email first. Then return to the launcher and press Log in.", nonce),
  );
}

async function checkedResponse(checked: AuthorizeCheck, nonce: string) {
  if (!checked.ok && checked.kind === "client") return invalidClient(nonce);
  if (!checked.ok) return oauthError(checked.redirectUri, "invalid_request", checked.state);
  const user = await currentUser();
  if (!user) return toLogin(checked);
  if (!user.emailVerifiedAt) return verifyEmail(nonce);
  return launcherHtml(
    consentPage({
      email: user.email,
      userId: user.id,
      clientId: checked.clientId,
      redirectUri: checked.redirectUri,
      state: checked.state,
      codeChallenge: checked.codeChallenge,
      nonce,
    }),
  );
}

export async function GET(req: Request) {
  try {
    await pruneNativeAuth();
  } catch {
    console.error("launcher auth prune failed");
  }
  const nonce = nonceOf(req);
  const checked = evaluateAuthorize(fromSearch(new URL(req.url).searchParams));
  return checkedResponse(checked, nonce);
}

export async function POST(req: Request) {
  const nonce = nonceOf(req);
  if (!originAllowed(req.headers, new URL(req.url).origin)) {
    return launcherHtml(messagePage("Forbidden", "Forbidden", nonce), 403);
  }
  try {
    await pruneNativeAuth();
  } catch {
    console.error("launcher auth prune failed");
  }
  const parsed = await fromForm(req);
  if (parsed === "bad") return invalidClient(nonce);
  const checked = evaluateAuthorize(parsed.input);
  if (!checked.ok && checked.kind === "client") return invalidClient(nonce);
  if (!checked.ok) return oauthError(checked.redirectUri, "invalid_request", checked.state);

  const user = await currentUser();
  if (!user) return toLogin(checked);
  const gate = await limitLauncherAuthorize(user.id);
  if (!gate.ok) {
    return launcherHtml(
      messagePage("Too many attempts", "Too many attempts. Wait a few minutes and press Log in in the launcher again.", nonce),
      429,
      { "Retry-After": String(gate.retryAfter) },
    );
  }
  if (parsed.userId !== user.id) {
    return launcherHtml(
      messagePage("Account changed", "This confirmation was started for a different account. Close this window and press Log in in the launcher again.", nonce),
      403,
    );
  }
  if (!user.emailVerifiedAt) return verifyEmail(nonce);
  if (parsed.decision === "deny") return oauthError(checked.redirectUri, "access_denied", checked.state);
  if (parsed.decision !== "approve") {
    return launcherHtml(
      messagePage("Sign-in not completed", "This confirmation could not be completed. Close this window and press Log in in the launcher again.", nonce),
      400,
    );
  }

  const code = randomBytes(32).toString("base64url");
  await prisma.nativeAuthCode.create({
    data: {
      codeHash: sha256(code),
      userId: user.id,
      clientId: checked.clientId,
      redirectUri: checked.redirectUri,
      codeChallenge: checked.codeChallenge,
      pwdAt: user.passwordChangedAt ?? new Date(0),
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });
  const url = new URL(checked.redirectUri);
  url.searchParams.set("code", code);
  url.searchParams.set("state", checked.state);
  return launcherRedirect(url.toString(), 302);
}
