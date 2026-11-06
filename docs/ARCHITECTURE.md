# TheWorldAfterZ Web: architecture plan (draft)

Stack: Next.js (App Router, TypeScript) + Auth.js credentials provider + PostgreSQL via Prisma.

## Routes
Public: `/` landing, `/register`, `/login`, `/logout`, `/forgot-password`, `/reset-password?token=` (`POST /api/forgot-password`, `POST /api/reset-password`).
Player (signed in): `/account` (key status), `/redeem`, `/download` (only with an active redemption).
Admin (role=ADMIN): `/admin/keys` (list/filter, mint batch, revoke), `/admin/users`.
API: `POST /api/redeem`, `GET /api/download` (issues a short-lived signed link), `POST /api/admin/keys/mint`, `POST /api/admin/keys/:id/revoke`.

## Schema
- User: id, email (unique, lowercased), passwordHash (argon2id), role (PLAYER|ADMIN), createdAt, emailVerifiedAt?, passwordChangedAt? (JWTs issued before it are rejected)
- PasswordResetToken: id, userId, tokenHash (sha256), expiresAt (1h), usedAt?, createdAt
- AccessKey: id, codeHash (sha256 of code; plaintext shown once at mint), codePrefix (first 4 chars, for admin lookup), tier (ALPHA|BETA), status (ACTIVE|REDEEMED|REVOKED), batchLabel, createdById, createdAt, revokedAt?, revokeReason?
- Redemption: id, keyId (unique, one use per key), userId, redeemedAt, ip
- DownloadEvent: id, userId, artifactVersion, issuedAt, ip
- AuditLog: id, actorId, action, targetId, meta (json), at

A user has access if they have a Redemption whose key is not REVOKED. Revoking a redeemed key removes that player's access.

## Auth
Auth.js credentials with JWT sessions in httpOnly, Secure, SameSite=Lax cookies. argon2id hashing. Rate limits (per IP and per account) on login, register and redeem, Postgres-backed so nothing extra to run. Same generic error for bad email or bad password. CSRF via Auth.js. Admin role is granted by seed/CLI only, never through the UI.

## Keys
Format `TWAZ-XXXX-XXXX-XXXX` from a crypto RNG (Crockford base32, no ambiguous characters). Only hashes are stored, so a DB leak exposes no usable keys. Plaintext is shown once and exported as CSV at mint. No public key list anywhere.

## Download gating
The launcher is not in /public. `/api/download` checks the session and an active redemption, logs a DownloadEvent, then 302s to a link that expires in about 5 minutes (HMAC-signed and served by the app or reverse proxy, or an S3-compatible presigned URL). Version, URL and sha256 come from a small manifest provided by Launcher Developer, so we never rebuild the launcher.

## Admin
Mint N keys with tier and batch label, then download a CSV once. Revoke with a reason. Search by prefix or email. Every action is written to AuditLog.

## Security defaults
HTTPS only with HSTS, strict CSP, zod validation on every input, secrets in env, and no stack traces in production.
