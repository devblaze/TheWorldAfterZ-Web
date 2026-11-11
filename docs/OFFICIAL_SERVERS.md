# Official servers — registry and heartbeat

This change implements registry administration and heartbeat only. There are no directory,
join-ticket, admit, or session check/end routes yet. Nothing authorizes player joins.
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
