# Moderation panel and game-server moderation API

## Roles (recomputed from the database and env on every request; fail closed)

| Role | Definition |
|---|---|
| Owner | verified email AND `User.role = ADMIN` AND email in `ADMIN_EMAILS` AND email in `OWNER_EMAILS`. Unset/empty `OWNER_EMAILS` = nobody is owner (no fallback to `ADMIN_EMAILS`). docker-compose defaults `OWNER_EMAILS` to Nick's address, mirroring the `ADMIN_EMAILS` default. |
| Site admin | verified + `User.role = ADMIN`. Keeps `/admin/keys`, `/admin/servers`, `/admin/users` and the launcher server-admin routes exactly as before. Also a roster admin: powers come from their `GameAdmin` row if one exists, otherwise all panel powers are true when the email is also in `ADMIN_EMAILS` (source "env"), else none. |
| Game admin | verified account with a `GameAdmin` row (promoted in the panel). No `User.role` change: no keys/servers/users pages, no launcher admin routes. Moderation panel only. |

The launcher `role` claim ("admin"|"player") is unchanged.

Powers: `teleport`, `godMode`, `spawnItems`, `kick`, `ban`, `bugReports`. The owner always has all of them. `bugReports` is a panel-only power (list, viewer, and authenticated blob routes); it is not sent to dedicated servers.

| Action | Who |
|---|---|
| Open the moderation panel | owner, site admins, game admins (others: redirect on pages, 403 `forbidden` on the API) |
| Promote a verified player to game admin (all powers false) | owner or any admin |
| Demote a game admin, change any admin's powers | owner only. Nobody can change the owner, themselves, or an env admin's demotion (env admins can have powers set, which creates their row). |
| Kick | owner, or admin with the `kick` power |
| Ban / unban | owner, or admin with the `ban` power |
| Ban an admin | owner only. Nobody can ban the owner or themselves. |
| See full emails | owner and site admins. Game admins see `n***@domain`; promotion is an exact-email match only. |

Display name: `Player-` + first 8 hex of `sha256("display:" + userId)`.

## Web panel

- `/admin/moderation`: admins (powers editable by the owner), promote by exact email, servers with online counts.
- `/admin/moderation/servers/[id]`: online players (from the heartbeat `playerAccountIds`, trusted while the heartbeat is < 90 s old) with Kick and Ban forms; "admitted" = open `ServerSession` on that server.
- `/admin/moderation/bans`: active bans, toggle for expired/revoked, unban.
- Form POSTs to `/api/admin/moderation/...` (303 back to the page; JSON 403 `{error:"forbidden"}` when not allowed): `admins`, `admins/[userId]/demote`, `admins/[userId]/powers`, `servers/[id]/kick`, `bans`, `bans/[banId]/unban`.
- Panel ban duration: permanent, or 1 minute to 365 days. A ban is global or scoped to one server.

## Bans

Active = `revokedAt` null AND (`expiresAt` null OR `expiresAt` > now). Creating a ban queues a `kick` command (reason = ban reason or "banned") on every ACTIVE server (global) or on the scoped server, in the same transaction. Unban sets `revokedAt`/`revokedById`; rows are never deleted.

Enforcement (fail closed, checked after the entitlement checks, under a FOR SHARE lock on the `bans` counter row so a concurrent ban is either seen or commits after):
- `POST /api/launcher/join-ticket`: 200 `{"entitled":false,"reason":"banned","banExpiresAt":"2026-12-01T00:00:00.000Z"}` (`null` = permanent).
- `POST /api/servers/admit`: 200 `{"admitted":false,"reason":"banned"}`; the ticket is already consumed, like every other denial; `ADMIT_DENY` is audited. A successful admit still returns `accountId` and `displayName`, unchanged.
- `POST /api/servers/sessions/check`: an open session of a banned account is revoked with reason `banned`.

## Server contract

All use `Authorization: TwazServer <id>.<secret>`, no cookies. Order: parse, credential (401 `{"error":"invalid_server"}`), path id must be the authenticated server (403 `{"error":"forbidden"}`), per-server rate limit (429 `{"error":"rate_limited"}` + `Retry-After`), then the work. Responses are `no-store` and never contain secrets or emails. Other methods: 405 `method_not_allowed`.
Limits per server per 60 s: roster/bans/commands GET 30 each, ack 600, `POST /bans` 30 (own bucket), heartbeat 12.

Versions are integers bumped in the same transaction as the change: `roster` (global), `bans` (global), `commands:<serverId>`. Heartbeat 200:

```json
{ "ok": true, "checkedAt": "2026-11-16T10:00:00.000Z", "maxPlayers": 64, "rosterVersion": 3, "bansVersion": 7, "commandsVersion": 12 }
```

### GET /api/servers/{id}/admin-roster
Verified accounts only: owner (once), env admins, game admins; sorted by `accountId`; all five in-game power keys always present (`teleport`, `godMode`, `spawnItems`, `kick`, `ban`). `bugReports` is omitted.
```json
{ "version": 3, "admins": [ { "accountId": "clx1abc", "displayName": "Player-1a2b3c4d", "role": "owner",
  "powers": { "teleport": true, "godMode": true, "spawnItems": true, "kick": true, "ban": true } } ] }
```
`role` is `"owner"` or `"admin"`.

### GET /api/servers/{id}/bans
Active bans, global plus scoped to this server.
```json
{ "version": 7, "bans": [ { "id": "clx9ban", "accountId": "clx1abc", "reason": "cheating", "expiresAt": null, "scope": "global" } ] }
```
`reason` string|null, `expiresAt` ISO|null, `scope` `"global"|"server"`.

### GET /api/servers/{id}/commands
Pending (not acked, not expired; 5 min TTL), oldest first, max 100.
```json
{ "version": 12, "commands": [ { "id": "clx9cmd", "type": "kick", "accountId": "clx1abc", "reason": null,
  "createdAt": "2026-11-16T10:00:00.000Z", "expiresAt": "2026-11-16T10:05:00.000Z" } ] }
```

The three GETs return a strong `ETag` (`"` + first 32 hex of sha256 of the canonical JSON + `"`). `If-None-Match` matching gives 304 with no body and the ETag kept. A 304 still counts toward the rate limit.

### POST /api/servers/{id}/commands/{cmdId}/ack
Body (strict): `{"result":"done"}` | `"player_not_found"` | `"failed"` -> 200 `{"ok":true,"id":"clx9cmd","result":"done","ackedAt":"..."}`.
Idempotent: a repeat returns 200 with the FIRST stored result and no new audit. Unknown command or another server's: 404 `{"error":"not_found"}`. An expired but unacked command can still be acked. Bad body: 422 `{"error":"invalid_request"}`. First ack bumps `commandsVersion` and writes `COMMAND_ACKED`.

### POST /api/servers/{id}/bans
Strict body, all four keys required: `{"accountId":"clx1abc","byAccountId":"clxowner","reason":"cheating","durationMinutes":60}` (`reason` string 1..200 or null; `durationMinutes` integer 1..525600 or null = permanent).
`byAccountId` must be the owner, or a roster admin with the `ban` power: otherwise 403 `{"error":"forbidden"}`. Target is the owner, an admin while the actor is not the owner, or the actor: 403. Unknown target: 422 `{"error":"unknown_account"}`. Bad body: 422 `{"error":"invalid_request"}`.
The ban is global. One transaction: ban row, `bans` bump, kick commands on every active server (each `commands` counter bumped), `PLAYER_BANNED` audit with source `game`.
```json
201 { "ban": { "id": "clx9ban", "accountId": "clx1abc", "reason": "cheating", "expiresAt": "2026-11-16T11:00:00.000Z", "scope": "global", "createdAt": "2026-11-16T10:00:00.000Z" } }
```

## Recommended game cadence
- Heartbeat every 10 s (30 s also fine), including `playerAccountIds`.
- After each heartbeat 200, fetch only the resource whose version changed (roster, bans, commands), and ack commands after acting.
- Full refresh of all three every 60 s with `If-None-Match`.
- On 429, back off for `Retry-After`.

## Audit (`AuditLog`, same transaction as the change)
`ADMIN_GRANTED`, `ADMIN_REVOKED`, `ADMIN_POWERS_CHANGED`, `PLAYER_KICK_REQUESTED`, `PLAYER_BANNED` (meta includes `queuedKicks`), `PLAYER_UNBANNED`, `COMMAND_ACKED`. `actorId` = acting user (null for ack), `targetId` = target user (command id for ack). Meta `{old, new, reason, source: "web"|"game", serverId?, banId?, expiresAt?}` holds ids only, never emails.
