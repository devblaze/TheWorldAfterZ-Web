# Official servers — registry and heartbeat

The site implements registry administration, heartbeat, the entitled launcher directory,
join-ticket issuance, admit, and session check/end. A ticket is not an admission decision;
the dedicated server must still fail closed unless admit returns admitted:true.
Do not register a live server, provision credentials, or deploy without Nick's approval.
Public update feeds and the gated first-install download are unchanged.

## Administration

`/admin/servers` uses the same live admin guard as `/admin/keys`. It creates official
servers, rotates credentials, disables servers, and updates build compatibility.
Name, region, host, port, game build, build family, protocol version, and allowed client
platforms are required on create. Client platforms are win-x64 and/or linux-x64.

Create and rotate show a 32-byte base64url secret once. Store it only in the dedicated
host environment as TWAZ_SERVER_SECRET, with TWAZ_SERVER_ID and TWAZ_SITE_ORIGIN.
The site stores SHA-256 only; it needs no per-server environment variables. Rotation
invalidates the old credential immediately. Disable is one-way and also ends open sessions.
The registry is admin-only; there is no public listing.

## Heartbeat contract

Send POST `/api/servers/heartbeat` over HTTPS with
`Authorization: TwazServer <serverId>.<secret>` and JSON:

```json
{
  "game_build": "0.59.1-linux",
  "build_family": "playtest-0.59",
  "protocol_version": 3,
  "server_runtime": "linux-x64",
  "instance_nonce": "random-per-process-at-least-16-chars",
  "players": 0,
  "maxPlayers": 16
}
```

Send every 30 seconds. A server is online for 90 seconds after its latest accepted heartbeat.
Only build_family and protocol_version affect compatibility; game_build and server_runtime
are informational. The nonce must be 16–128 printable ASCII characters. Player counts must
be integers in 0–10000 with players <= maxPlayers; the JSON body is limited to 4096 bytes.

Responses are JSON, no-store, and never redirect:
- 200 `{ok:true,checkedAt}` (ISO timestamp)
- 400 `{error:"invalid_request"}`
- 401 `{error:"invalid_server"}` for invalid, rotated or disabled credentials
- 409 `{error:"build_mismatch"}`
- 429 `{error:"rate_limited"}` plus Retry-After (4 attempts/minute/server after auth)
- 500 `{error:"server_error"}` (fail closed)

Malformed and incompatible authenticated attempts consume rate-limit capacity. A locked
transaction rechecks credentials and compatibility, records heartbeat state, and on a new
nonce ends open sessions of other instances with reason server_restart. A rotation or
disable committed before that transaction acquires its row lock wins.

The migration also prepares JoinTicket and ServerSession for later steps, including
instance-scoped connection identities. Audit action names live in src/lib/servers.ts;
compatibility updates use SERVER_COMPAT_UPDATED in addition to the planned actions.

## Validation

Run lint, typecheck, unit tests, Prisma migration deployment to a disposable Postgres,
integration tests, and the Next production build. Server integration tests use real
Auth.js sessions and Postgres, including rotation/heartbeat concurrency. Never point
tests at production. A browser click-through and real dedicated-server traffic remain
operator acceptance tasks, not claims made by the automated tests.

## Launcher directory and join tickets (steps 2 and 3)

Both routes reuse the native-auth live Bearer checks used by play-check, never browser
cookies. All responses are no-store; errors are JSON and there are no redirects.
The exact paths are CSRF-exempt. Unsupported methods return 405 JSON.

GET `/api/launcher/servers` requires each query parameter exactly once:
`build_family`, `protocol_version` (plain decimal 1–1000000), `client_platform`
(win-x64 or linux-x64), and informational `game_build` (1–128 characters).
Family is 1–64 characters. Missing/bad parameters give 400 invalid_request;
unverified/no-key accounts get 403 unverified/no_key respectively. Only ACTIVE servers
with a heartbeat within 90 seconds, matching family/protocol, and an allowed client
platform appear. Mismatch gives 200 with an empty list, never 409. At most 64 rows
are returned, sorted by region/name/id. Fields are id, name, region, host, port,
buildFamily, protocolVersion, players, maxPlayers, online (always true), plus a
response checkedAt ISO timestamp. No credentials or runtime fields are exposed.

POST `/api/launcher/join-ticket` takes JSON serverId, the four build fields above,
and nonce (16–128 characters from A-Z/a-z/0-9/underscore/hyphen). serverId uses the
same alphabet, 1–128 characters. Invalid input gives 400 invalid_request.
After native auth, the business denials are evaluated in this order and return
200 `{entitled:false,reason}`:
1. unverified
2. no_key
3. server_not_found (unknown or DISABLED)
4. server_offline (missing or stale heartbeat)
5. build_mismatch (family/protocol/client platform)
6. server_full (last heartbeat players >= maxPlayers)

Entitlement is checked before the server lookup. Join never returns 404 or 409.
Success contains ticket, serverId, accountId, nonce, the four echoed build fields,
checkedAt and expiresAt. There is no host/port in the join response. Both timestamps
use toISOString; expiresAt minus checkedAt is exactly 60000 ms. The random 32-byte
base64url ticket is returned once; only its SHA-256 is stored. Ticket and TICKET_ISSUED
audit writes are atomic; audit metadata never includes the ticket or its hash.
The ticket is bound to the account, native session, server and compatibility values.
Shared row locks protect issuance against session/key revoke and server changes.
Admit revalidates live state and enforces single use (see below).

Limits are separate, per account: directory 30/minute, join 10/minute. Every authenticated
attempt counts, including malformed requests and denials. 429 includes Retry-After as
positive delta-seconds. Check order is auth, rate limit, input validation, then business
denials. Unexpected failures give 500 server_error and never grant access.

The directory is a read snapshot, not a reservation or admission decision. A server can
fill or be disabled after listing; join rechecks it and admit remains authoritative.
Expired-ticket pruning is not implemented. Native-auth integration
tests currently require a UTC test database; this implementation changes no production
timezone settings. Freeze reference: TheWorldAfterZ aa21ca99, docs/OFFICIAL_DEDICATED_SERVER.md.

## Admit and session checks (steps 4 and 5)

All three routes use `Authorization: TwazServer <serverId>.<secret>`, never read cookies,
are CSRF-exempt only through the existing `/api/servers/` prefix, return JSON no-store
with no redirects, and answer unsupported methods with 405 JSON (`Allow: POST`). Order:
server auth, per-server rate limit, input validation, then a transaction that takes a
shared row lock on the server and re-verifies the credential, so a rotation or disable
committed first wins (401 invalid_server). Limits per server per minute: admit 60,
sessions/check 120, sessions/end 600; 429 carries Retry-After. Unexpected failures give
500 server_error and grant nothing. Malformed requests count against the limit. The DB
transaction budget is 4 seconds, with at most 1 second waiting to start one. Check allows
batched 256-id polls at the registry's 10000-player cap (40 batches/minute); clients with
more than 256 connected sessions must batch their checks.

POST `/api/servers/admit` takes JSON `ticket`, `instance_nonce` (16–128 printable ASCII),
`connection_id` (decimal unsigned 64-bit string), `build_family`, `protocol_version`,
`game_build` (informational, logged only); body max 2048 bytes; unknown fields are rejected.
Success is 200 `{admitted:true,accountId,displayName,serverSessionId}`; every denial is
200 `{admitted:false,reason}` with reason one of ticket_invalid, ticket_used,
ticket_expired, wrong_server, stale_instance, build_mismatch, no_key, unverified,
session_revoked. The server must drop the connection on anything else, and on any error
or 5 s timeout. displayName is a stable non-PII `Player-xxxxxxxx` derived from the
account id; it is never the email. Checks, in order:
1. The conditional UPDATE consumes a ticket only when unused, unexpired, and bound to
   this authenticated server. The SQL uses the current UTC clock at statement execution,
   not the earlier transaction-start clock, so a ticket cannot expire while waiting for
   a lock and still be admitted. Concurrent admits of one ticket have exactly one winner.
2. On 0 rows: a known used ticket is ticket_used plus TICKET_REUSE (even when presented
   by another server); an unused foreign ticket is wrong_server; an unused expired ticket
   is ticket_expired; otherwise ticket_invalid. None of these consumes a foreign ticket.
3. Compare instance_nonce to the latest heartbeat (stale_instance), and compare family
   and protocol to BOTH current registration and ticket-bound values (build_mismatch).
4. Live account recheck: native session, password, verification, any non-REVOKED key
   (ALPHA=BETA, no expiry). Unverified gives unverified, no active key gives no_key, and
   a revoked/expired native session or a password changed after the session was created
   gives session_revoked (the raw reason is in the audit meta).
5. A connection identity (serverId, instance_nonce, connection_id) that already has a
   session is denied ticket_invalid (audit detail connection_reused).
6. A ServerSession and an ADMIT_OK audit are written.
All business denials AFTER consumption keep the ticket spent and write ADMIT_DENY in
that same transaction, including stale-instance and current-build denials. Replay always
becomes ticket_used. An audit failure rolls the transaction back (500). Audit metadata
never contains the ticket or its hash. connection_id must be canonical decimal (no
leading zeros except zero), avoiding alternate spellings of one NGO uint64 identity.

The plan's zero-row shorthand says "used, else invalid", but its declared reason set
also includes wrong_server and ticket_expired; the classification above preserves those
specific declared reasons. NativeSession has no pwdAt column: password checks use its
creation time, matching the existing refresh invariant. Password reset also revokes all
native sessions transactionally. Native-session and active-key shared locks protect live
checks. User rows are read after the native-session lock without an extra row lock: this
avoids deadlocks with refresh (session then user) and reset (user then session). An
in-flight reset may wait for an earlier decision; once reset commits, later checks deny.
The account read is a live snapshot; no offline entitlement cache is used.

POST `/api/servers/sessions/check` takes `{serverSessionIds:[...]}` (at most 256 ids, each
1–64 of A-Za-z0-9_-; duplicates are collapsed; body max 24576 bytes). Response 200
`{revoke:[{serverSessionId,reason}],checkedAt}` in first-seen order, reason one of
key_revoked, password_changed, session_revoked, unverified, unknown_session. Precedence:
password_changed, session_revoked, unverified, key_revoked. Ids that are unknown, owned by
another server, or already ended return unknown_session with no mutation. A lost open
session is ended (endReason = reason) with a PLAYER_KICK audit; repeating the call is
idempotent. Entitled sessions are omitted. The server must kick everything returned,
and every connected player if the call fails or times out.

POST `/api/servers/sessions/end` takes `{serverSessionId,reason}` (reason 1–64 of
A-Za-z0-9_.-; body max 1024 bytes) for the server's own sessions and returns `{ok:true}`. It is idempotent: the
first end wins and unknown, foreign or ended ids change nothing but still return ok.

Not covered by tests: real dedicated-server traffic and production behaviour.
