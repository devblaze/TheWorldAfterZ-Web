# TheWorldAfterZ launcher native auth

Status: phase 1 implemented (browser-first, OAuth 2.0 authorization code + PKCE S256, RFC 7636 / RFC 8252). Official server admission is a later phase and is not part of this contract. The sections below are the wire contract.

Section 5 replaces the section 1 login handoff: an absent browser session is a 303 to `/login?next=`, not `callbackUrl`. No other auth query parameter is added.

## Client
- Single public client `twaz-launcher`, no secret. Allowed redirect: `http://127.0.0.1:<port>/callback` only (port 1024-65535, exact host 127.0.0.1, exact path, no query/fragment). Everything else HTTPS.

## Data (no raw tokens/codes stored; sha256 only)
- NativeAuthCode { id, codeHash UNIQUE, userId, clientId, redirectUri, codeChallenge, pwdAt, expiresAt(+60s), usedAt?, sessionId? UNIQUE -> NativeSession }  — sessionId set in the same transaction as the exchange; code rows retained (hash only) for at least 24h after expiresAt so reuse is detectable, then pruned.
- NativeSession (family) { id(sid), userId, clientId, createdAt, absoluteExpiresAt(+90d), lastUsedAt, idleExpiresAt(+30d), revokedAt?, revokeReason? }
- NativeRefreshToken { id, tokenHash UNIQUE, sessionId -> NativeSession, createdAt, usedAt?, replacedById? }  — every issued refresh token kept (hash) so any old token maps to its family; rows pruned only after family expiry.

## 1. GET /launcher/authorize
1. Validate client_id and redirect_uri FIRST. If either invalid: render error page on site, never redirect, never reflect redirect_uri.
2. Then validate response_type=code, state (required, 16-512 chars), code_challenge (43-128 base64url), code_challenge_method=S256; failures redirect to the validated redirect_uri with error=invalid_request&state.
3. Require existing Auth.js cookie session (currentUser(), which already enforces passwordChangedAt). If absent -> /login?callbackUrl=<same authorize URL, same-origin only>. Unverified -> verify notice, no code.
4. Consent page: "Allow TheWorldAfterZ Launcher to sign in as <email>?" + "Not you? Sign out". Approve/Deny is a POST with existing Origin/CSRF check; POST re-validates all params and re-reads currentUser (account switch between GET and POST => uses current account shown on POST; consent form carries a hidden userId and is rejected on mismatch).
5. Approve -> create code (hash stored), 302 to redirect_uri?code&state. Deny -> 302 error=access_denied&state.
- Headers: Cache-Control: no-store, Pragma: no-cache, Referrer-Policy: no-referrer, frame-ancestors 'none'.

## 2. POST /api/launcher/token (x-www-form-urlencoded; CSRF-exempt, no cookies read)
- authorization_code: in ONE transaction: `UPDATE NativeAuthCode SET usedAt=now WHERE codeHash=? AND usedAt IS NULL AND expiresAt>now RETURNING *`; 0 rows => invalid_grant (if a row with that codeHash exists with usedAt set => revoke NativeSession where id = code.sessionId, reason=code_reuse, and audit NATIVE_CODE_REUSE). On success: insert NativeSession, then set code.sessionId = session.id, all in the same transaction. Check client_id, redirect_uri exact match, S256(verifier)==challenge, user still verified and passwordChangedAt <= code.pwdAt. Create NativeSession + first NativeRefreshToken.
- refresh_token: in ONE transaction with row lock (SELECT ... FOR UPDATE on token row): look up by hash.
  - not found => invalid_grant.
  - usedAt set (replay) => revoke family (reason=refresh_reuse), invalid_grant.
  - family revoked/expired (idle or absolute)/password changed since session creation => invalid_grant.
  - else mark usedAt, insert successor, set replacedById, bump lastUsedAt/idleExpiresAt (capped at absoluteExpiresAt).
- 200: {access_token, token_type:"Bearer", expires_in:900, refresh_token, account:{id,email}}; errors per RFC 6749: invalid_request, invalid_client, invalid_grant, unsupported_grant_type (400), 429 rate_limited + Retry-After.
- Client must serialize refreshes (single in-flight refresh).
- Headers: Cache-Control: no-store, Pragma: no-cache.

## Access token
- HS256 JWT, secret LAUNCHER_TOKEN_SECRET (new env), aud "twaz-launcher", iss site origin, claims sub, sid, pwdAt, iat, exp(+900s), jti.
- Every authenticated request: verify signature+aud+iss+exp, THEN load NativeSession by sid: must belong to sub, not revoked, not past idle/absolute, and user.passwordChangedAt <= pwdAt. Any failure => 401.

## 3. POST /api/launcher/revoke
- Body token + token_type_hint (refresh_token|access_token).
- refresh_token: lookup by hash (used or current) -> family -> revoke.
- access_token: verify signature, aud, iss (expiry may be ignored, max 90d old by iat), then load sid and require session.userId == sub; revoke family. Unverified/forged JWT => no action.
- Always 200 {} (RFC 7009), no-store. Revoking family invalidates all its access tokens via live sid check.
- Password reset/change: revoke all of user's NativeSessions (reason=password_changed) in same transaction as passwordChangedAt update.

## 4. POST /api/launcher/play-check
- Bearer access token (validated as above). Body {nonce (16-128 chars), game_build, platform}.
- entitled = activeRedemption(userId) != null (ANY linked key not REVOKED; ALPHA=BETA; no key expiry) AND emailVerifiedAt set.
- 200 {entitled, reason: ok|no_key|unverified, accountId, nonce, game_build, platform, checkedAt, expiresAt: checkedAt+30s}. Session/password failures are 401 {error: session_revoked|password_changed|invalid_token}.
- Client validity uses a MONOTONIC clock only (Stopwatch / CLOCK_MONOTONIC), never local wall clock vs server timestamps:
  - start the monotonic timer when the play-check request is SENT; window = min(30s, server expiresAt - checkedAt) (both server timestamps, difference only).
  - allow only if elapsed(request start -> actual game process spawn) <= window; if spawn is delayed past the window, discard and re-check.
  - require 200 && entitled && nonce == sent nonce && accountId == current signed-in account && game_build == sent game_build && platform == sent platform.
  - capture an auth generation counter (incremented on login, logout, account switch, refresh failure) at request start; reject the response if it changed.
  - deny on any network/parse/auth/timeout error. No grace/offline allow.
- checkedAt/expiresAt are for server validation and diagnostics; the client never compares them with its own wall clock.
- Headers: Cache-Control: no-store, Pragma: no-cache.

## Rate limits / audit
- Existing DB limiter: token by IP + client, refresh by IP + sid, play-check by account, authorize POST by account.
- AuditLog: NATIVE_SESSION_CREATED, NATIVE_SESSION_REVOKED(reason), NATIVE_REFRESH_REUSE.

## Unchanged
- Browser Auth.js login, Origin/CSRF in src/proxy.ts (exempt list adds only /api/launcher/token, /revoke, /play-check), cookie+HMAC first-install download, public update feed.

## Tests (integration, real Postgres)
- PKCE: wrong verifier, plain method, missing challenge, code reuse (second exchange fails + the session linked via code.sessionId and its access tokens are revoked), expired code, redirect_uri mismatch at exchange.
- authorize: invalid client/redirect => no redirect & not reflected; invalid state/challenge => error redirect to validated URI; unauth -> login round-trip; unverified -> no code; consent POST CSRF reject; account switch between GET and POST rejected.
- refresh: rotation works; old token replay revokes family and its access tokens; concurrent refresh => exactly one succeeds; idle and absolute expiry; family revoked => refresh fails.
- revoke: by refresh (current and used), by expired-but-authentic access token, forged JWT no-op, other user's sid no-op; outstanding access tokens 401 afterwards.
- password reset revokes all families; access token with old pwdAt 401; authorize after reset needs fresh browser login.
- launcher client (Launcher Developer): monotonic window incl. delayed spawn re-check, skewed wall clock has no effect, build/platform/nonce/account mismatch and auth-generation change all deny.
- play-check: no key, one revoked + one active => entitled, all revoked => no_key, unverified, nonce/platform/build echo, no-store headers on all four routes.

## Prereqs
- Live prod browser login verified (Lead dashboard says AUTH_SECRET set; not verified by me).
- LAUNCHER_TOKEN_SECRET env in EasyDeploy (Nick sets; never in chat).
- Supported repo coding route.

## 5. Launcher Log in / Create account entry points (added 2026-11-09)
Current prod source (Gitea main 1ccd3fa): /register exists; loginAction always redirects to /account; /api/verify redirects to /login?verified=1. There is NO return-to support today. To implement:
- Launcher "Log in" opens the authorize URL (section 1) only. If no cookie session, authorize 303s to `/login?next=<urlencoded path+query of this authorize request>`.
- `next` validation (login page, loginAction, register link): must parse as a RELATIVE path starting exactly with `/launcher/authorize?`, no scheme/host, no `//`, no backslash, max 2048 chars; otherwise ignored (default /account). After login success redirect to `next`; authorize re-validates everything (client, redirect, state, challenge) as if fresh. No new auth query params are invented.
- Launcher "Create account" opens `https://theworldafterz.ncatechsolutions.org/register?from=launcher` (no auth/PKCE params). `from=launcher` only changes copy: after register, "Check your email, then return to the launcher and press Log in".
- Return-to is NOT carried through email verification: the launcher loopback listener is one-shot and the PKCE attempt should be fresh. /api/verify keeps redirecting to /login?verified=1; the player then uses launcher Log in again. A Register link shown on /login during an authorize flow drops `next` deliberately.
- Registration and verification never grant Play. Authorize refuses unverified accounts (error page "verify your email first", no code). play-check returns no_key until a key is redeemed on /redeem.
- Tests: next open-redirect cases (//evil, https://evil, /\evil, /launcher/authorizeX, encoded variants) ignored; login with valid next lands on authorize; register?from=launcher copy; unverified authorize => no code.
