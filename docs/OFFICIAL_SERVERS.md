# Official servers — registry and heartbeat

The site implements registry administration, heartbeat, the entitled launcher directory,
and join-ticket issuance. There are no admit or session check/end routes yet. A ticket
is not an admission decision; the dedicated server must still fail closed without admit.
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
Admit must revalidate live state and enforce single use when step 4 is implemented.

Limits are separate, per account: directory 30/minute, join 10/minute. Every authenticated
attempt counts, including malformed requests and denials. 429 includes Retry-After as
positive delta-seconds. Check order is auth, rate limit, input validation, then business
denials. Unexpected failures give 500 server_error and never grant access.

The directory is a read snapshot, not a reservation or admission decision. A server can
fill or be disabled after listing; join rechecks it and admit remains authoritative.
Expired-ticket pruning belongs to the later admission lifecycle. Native-auth integration
tests currently require a UTC test database; this implementation changes no production
timezone settings. Freeze reference: TheWorldAfterZ aa21ca99, docs/OFFICIAL_DEDICATED_SERVER.md.
