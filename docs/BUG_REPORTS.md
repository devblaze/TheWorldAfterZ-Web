# In-game bug reports (schemaVersion 1)

Provisional website implementation of the Unity U13 contract (`DESIGN.md` from Unity, approved by Lead). A prod deploy still needs Nick's verbatim go: merging `main` auto-deploys via EasyDeploy.

The shipping game has no site token. The launcher mints a short-lived upload grant, then the game posts the multipart report with that grant only in the `Authorization` header.

## Endpoints

### `POST /api/bug-reports/grants`

Launcher user session (`Authorization: Bearer <launcher access token>`). Optional JSON `{ "ttlSec": 120 }` (`ttlSec` is 1–120, default 120).

The account must have a live launcher session, a verified email, and an active (non-revoked) key — same entitlement gate as the official-server directory. Official `TwazServer` credentials are not accepted.

**200** `{ "uploadToken": "…", "expiresAt": "…Z", "accountId": "clx…" }`. `accountId` is for the launcher's bookkeeping; the game may ignore it. Only a sha256 of `uploadToken` is stored. The grant is single-use and expires after `ttlSec`.

Grant errors use the existing launcher auth codes: `401 { "error": "invalid_token" | "session_revoked" | "password_changed" }`, `403 { "error": "unverified" | "no_key" }`, `400 { "error": "invalid_request" }`, `429 { "error": "rate_limited" }` + `Retry-After`. Other methods: `405 { "error": "method_not_allowed" }`. All responses are `no-store`.

Rate limit: **10 grants / hour / account** (fixed window, so a burst of failed submits cannot mint forever). This follows the U13 design, not a 5/hour cap on grants.

### `POST /api/bug-reports`

`Authorization: Bearer <uploadToken>` in the header only. `Content-Type: multipart/form-data`.

| Part | Type | Required | Limits |
|---|---|---|---|
| `report` | `application/json` | yes | max 64 KiB |
| `replay` | `application/gzip` (filename `replay.ndjson.gz`) | if `includeReplay` is true | max 1.5 MiB; omit entirely when the box is unchecked |
| `screenshots[]` | `image/jpeg` | optional | 0–8 when a replay is included; **at most one** (the submit shot) when it is not. Each ≤ 250 KiB, all images ≤ 1.5 MiB |

Whole request body ≤ **3 MiB**, enforced while streaming (413 as soon as the cap is crossed). Replay must be gzip (`1f 8b`); screenshots must be JPEG (`ff d8 ff`).

`accountId` is taken from the grant, never from the body. The grant is consumed atomically after the report validates and the account is under the upload rate cap (so a 400 does not burn the grant; a concurrent second use of the same token gets 401).

**`report` JSON** (unknown fields ignored; `schemaVersion` must be 1):

```json
{
  "schemaVersion": 1,
  "category": "gameplay",
  "description": "10–4000 chars, trimmed",
  "includeReplay": true,
  "clientSubmittedAt": "2026-11-21T10:00:00.000Z",
  "build": { "version": "playtest-0.73-abc1234", "sha": "…", "family": "playtest-0.73", "branch": "main", "date": "" },
  "platform": { "os": "Windows", "osVersion": "10.0.22631", "arch": "x64", "unity": "6000.4.1f1", "deviceModel": "" },
  "gpu": { "name": "NVIDIA GeForce …", "api": "D3D11", "vramMb": 8192 },
  "perf": { "fpsAvg": 61.2, "fpsMin": 22.0, "frameMsAvg": 16.4, "frameMsMax": 45.1, "windowSeconds": 60 },
  "net": {
    "mode": "official",
    "serverId": "eu1-or-empty",
    "serverName": "EU 1 or empty",
    "pingMsAvg": 28,
    "pingMsMax": 91,
    "windowSeconds": 60,
    "role": "client"
  },
  "session": { "map": "World_Main", "playerCount": 6, "inMenu": false },
  "logTail": [{ "t": 1732170000123, "lv": "error", "m": "scrubbed line" }]
}
```

`category`: `gameplay` | `graphics` | `network` | `ui` | `audio` | `crash` | `other`.  
`net.mode`: `official` | `listen` | `direct` | `relay` | `none`. Listen/direct must not include an IP, port, or join code.  
`logTail`: last 200 scrubbed lines, oldest first, `{ t, lv, m }` with `lv` one of `warning|error|exception|info|log|debug`.

The request is **rejected (400)** if the report JSON contains a forbidden key (`accountId`, `email`, `accessToken`, `token`, `ticket`, `pipeName`, `ipcCode`, `serverSecret`, …) or a secret-shaped value (email, `Bearer`, `TwazServer`, JWT) in a non-free-text field. `description` and `logTail[].m` are treated as free text and are not rejected for those shapes (the client already scrubs; staff still see only escaped text).

Validation lives in `src/lib/bug-reports.ts` so the contract is easy to change.

### Responses (upload)

| Status | Body | Notes |
|---|---|---|
| **201** | `{ "id": "br_…", "createdAt": "…Z" }` | `id` is site-issued, `br_` + 20 `[A-Za-z0-9_]`, 8–64 chars overall |
| **400** | `{ "error": "invalid_report", "message": "…", "fields": { "description": "…" } }` | schema, types, forbidden keys, missing/extra replay |
| **401** | `{ "error": "unauthorized" }` | missing, expired, or already-used grant |
| **413** | `{ "error": "too_large" }` | request, report JSON, replay, or screenshot over the cap |
| **429** | `{ "error": "rate_limited" }` + `Retry-After` | honour the header; mint a new grant before retrying |
| 5xx | `{ "error": "server_error" }` | no secrets or paths in the body or logs |

Other methods: 405. CSRF: both paths are exempt in `src/proxy.ts` (launcher/game, no browser origin).

**Upload rate limits (per account, rolling):** 5 successful reports / hour, 20 / 24 hours, counted from stored rows (failed 400/401/413 do not count). `Retry-After` is the seconds until the oldest report in the saturated window ages out.

## Storage

Blobs (replay + screenshots) go to a local directory via a small filesystem driver (`src/lib/bug-report-storage.ts`):

- There is no `/tmp` default. The Dockerfile runner sets `ENV BUG_REPORT_STORAGE_DIR=/var/lib/twaz/bug-reports` and creates that directory (owned by `app`). docker-compose also sets the same path and mounts the named volume `bug-reports` there (the compose network/subnet is unchanged). Local and CI tests use a throwaway directory that is not under `/tmp`.
- EasyDeploy service A (prod) builds from the Dockerfile as a single image, not compose, and currently has no volume. The site **always boots**: a soft check at process start (`src/instrumentation.ts`) never throws. Storage is marked unavailable when the variable is unset, the path resolves under `/tmp`, or a write/delete probe fails. The result is cached for 30 seconds and re-checked so a later writable disk can recover. One startup warning logs the reason category (`unset`, `under_tmp`, or `not_writable`) and never logs secrets. When storage is available, a startup warning reminds operators that reports will not survive redeploys unless a persistent volume is mounted at that path.
- While storage is unavailable, `POST /api/bug-reports/grants` and `POST /api/bug-reports` return **503** `{ "error": "bug_reports_unavailable" }` with `Retry-After` (grants are not minted; existing grants are not consumed). Admin replay/screenshot routes return the same 503. The admin list and viewer still load and show a red banner with the reason category. The daily sweep skips its run.
- Server-generated random file names only; never a player-supplied name, never a public URL. sha256 and byte length are recorded in Postgres. An Unraid share remains out of scope.

Metadata (including `logTail`, build, perf, net, session) is in Postgres (`BugReport`, `BugReportScreenshot`, `BugReportGrant`).

## Admin

Access is the **owner** (always) plus anyone with the `bugReports` GameAdmin power (camelCase, default `false`, toggled by the owner on `/admin/moderation` like the other powers). Env admins with no `GameAdmin` row still get all powers, including `bugReports`, matching the existing convention. The dedicated-server roster still exposes only the five in-game powers; `bugReports` is not sent to game servers.

- List `/admin/bug-reports`, filtered by category, `net.mode`, build version/family, and server id/name. Rows are tagged with `net.mode`. Listen and direct reports are accepted and tagged the same way.
- View `/admin/bug-reports/[id]`: description, metadata, log tail, screenshots, and a replay download. Site admins and the owner see full emails; game admins with the power see the usual masked address.
- Fetch blobs only through authenticated routes: `GET /api/admin/bug-reports/{id}/replay` and `GET /api/admin/bug-reports/{id}/screenshots/{index}` (`bugReportsAdminOrNull`, 403 otherwise, no-store, no public object URL).

The nav link is shown only when the signed-in user can access this panel. All player text is rendered as React text (escaped); the UI never uses `dangerouslySetInnerHTML`.

## Retention

Reports are kept for **90 days**. The running app starts a once-per-process daily sweep (`src/instrumentation.ts` → `startBugReportSweepScheduler`): one immediate run after start, then every 24 hours, with a guard so two sweeps never overlap, logging only the deleted-report / blob / expired-grant counts. `npm run bug-reports:sweep` (`scripts/bug-reports-sweep.mjs`) remains for a manual run (requires `BUG_REPORT_STORAGE_DIR`). Override the window with `BUG_REPORT_RETENTION_DAYS`.

## Open questions

For Unity (unchanged):

- Confirm this matches the payload they will ship (field names, `logTail` object shape, `perf.frameMsAvg` / `frameMsMax` rather than `frameMsP95`, screenshot part name `screenshots[]`, gzip content type).
- Confirm they can POST multipart and that the launcher will call `/api/bug-reports/grants` then hand only `uploadToken` + `expiresAt` (and the upload URL) to the game.
- Any extra replay-header fields to freeze now for a later staff playback viewer?

Lead decisions already applied: persistent named Docker volume recommended (not `/tmp`, Unraid mount out of scope); Dockerfile ENV default plus a soft storage check so an EasyDeploy single-image deploy still boots; in-process daily 90-day sweep (skipped when storage is unavailable; manual script kept); access is the owner plus the `bugReports` power; grants still require an active key; listen/direct reports are accepted and tagged; grant minting stays 10/hour.

Do not merge this PR without Nick's go-ahead: merging `main` auto-deploys production.
