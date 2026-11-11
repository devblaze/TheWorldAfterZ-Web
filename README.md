# TheWorldAfterZ player website

[![CI](https://git.ncatechsolutions.org/nickanton/TheWorldAfterZ-Web/actions/workflows/ci.yml/badge.svg?branch=main)](https://git.ncatechsolutions.org/nickanton/TheWorldAfterZ-Web/actions?workflow=ci.yml)

Next.js (App Router, TypeScript) + Auth.js v5 (credentials, JWT sessions) + PostgreSQL/Prisma.
Players register, verify their email, redeem an access key and download the launcher. Admins mint and revoke keys.
Design notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Local development

```bash
cp .env.example .env          # then fill in the values (see below)
npm install                   # also runs `prisma generate`
npx prisma migrate dev        # applies migrations to DATABASE_URL
npm run dev                   # http://localhost:3000
```

You need a PostgreSQL 16+ database. For example: `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:16`.
If `SMTP_HOST` is empty, verification and password-reset links are printed to the server console. Open the link to verify.

Password reset: `/forgot-password` emails a single-use link to `/reset-password` that expires after 1 hour. The response is the same whether or not the account exists. A reset also verifies the email and signs out every existing session.

Checks: `npm run build`, `npx tsc --noEmit`, `npm run lint`, `npx prisma validate`, `npx vitest run`.

## CI

[`.gitea/workflows/ci.yml`](.gitea/workflows/ci.yml) runs on every push and pull request to `main`, in a `node:22` container
with a `postgres:16` service: `npm ci`, `prisma generate`, `prisma validate`, lint, `tsc --noEmit`, unit tests,
`prisma migrate deploy`, integration tests, `next build`. All env values in the workflow are dummies.

Integration tests (`tests/integration/`, `npm run test:integration`) drive the real route handlers against the
database at `DATABASE_URL`, so point it at a throwaway, migrated database. They need the same env as CI
(`AUTH_SECRET`, `AUTH_URL`, `DOWNLOAD_SIGNING_SECRET`, `LAUNCHER_DIR=./deploy/launcher-example`, `SMTP_HOST` empty).
Unit tests (`npm test`) need no database.

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `POSTGRES_PASSWORD` | Password for the compose `db` service (compose builds `DATABASE_URL` from it) |
| `AUTH_SECRET` | Auth.js JWT encryption secret (`openssl rand -base64 32`) |
| `ADMIN_EMAILS` | Comma-separated admin emails; compose defaults to `nikosantoniadis94@gmail.com`. They still have to verify the email. |
| `AUTH_URL` | Public base URL, e.g. `https://theworldafterz.ncatechsolutions.org`. Used for email links and the API origin check |
| `AUTH_TRUST_HOST` | `true` behind the reverse proxy |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` | Outgoing mail for verification. Leave `SMTP_HOST` empty to log links instead |
| `DOWNLOAD_SIGNING_SECRET` | HMAC key for the 5-minute download links (`openssl rand -base64 32`) |
| `LAUNCHER_FEED_URL` | Optional http(s) base URL ending in `/`; empty/unset disables feed lookup |
| `LAUNCHER_CACHE_DIR` | Writable verified-object cache; default `/tmp/twaz-launcher-cache` (app-owned in Docker) |
| `LAUNCHER_DIR` | Directory with `manifest.json` and the launcher file (`/launcher` in Docker) |

## Migrations

- Change `prisma/schema.prisma`, then run `npx prisma migrate dev --name <change>` and commit the new folder under `prisma/migrations/`.
- Production applies pending migrations on container start (`prisma migrate deploy`). You can also run `npm run db:deploy` by hand.

## Creating the admin

There is no UI path to become admin. Run:

```bash
npm run admin:create -- --email you@example.com
# in Docker:
docker compose exec app node scripts/admin-create.mjs --email you@example.com
```

If the user exists, they are promoted to ADMIN and marked verified. Otherwise a verified admin is created and a random password is printed once. The action is written to AuditLog.

## Deploying to theworldafterz.ncatechsolutions.org

1. Copy the repo to the server and create `.env` from `.env.example`, using real secrets.
   Set `AUTH_URL=https://theworldafterz.ncatechsolutions.org` and `AUTH_TRUST_HOST=true`, and fill in the SMTP settings.
2. Run `docker compose up -d --build`. The app listens on **127.0.0.1:3000 only**, and Postgres is not published at all.
3. Point the existing HTTPS reverse proxy at `http://127.0.0.1:3000`. It must:
   - pass `Host` and set `X-Forwarded-Proto https`;
   - set `X-Real-IP` to the client address, or append it to `X-Forwarded-For`. Rate limits key on these headers, so the proxy must overwrite any value the client sent.
   - allow responses as large as the launcher file and not buffer them, e.g. nginx `proxy_buffering off` for `/api/download/file`.
   Example for nginx:
   ```nginx
   location / {
     proxy_pass http://127.0.0.1:3000;
     proxy_set_header Host $host;
     proxy_set_header X-Real-IP $remote_addr;
     proxy_set_header X-Forwarded-For $remote_addr;
     proxy_set_header X-Forwarded-Proto https;
   }
   ```
4. Create the admin (see above).

The app sends HSTS, CSP (with a per-request nonce), X-Frame-Options DENY, nosniff and Referrer-Policy itself, so the proxy does not need to add them.

## Deploying with EasyDeploy (deploy.ncatechsolutions.org)

The target is https://theworldafterz.ncatechsolutions.org, which is behind Cloudflare. EasyDeploy terminates TLS.
1. Create an app in EasyDeploy from this repo using `docker-compose.yml`.
2. Set the env vars from `.env.example` in EasyDeploy (`.env` is optional). Set `AUTH_URL=https://theworldafterz.ncatechsolutions.org` and `AUTH_TRUST_HOST=true`, and set `APP_BIND` if EasyDeploy's proxy needs the port on all interfaces.
3. Route the hostname to the `app` service on port 3000. Keep `db` private.
4. Confirm that the real client IP arrives in `X-Real-IP` or as the last `X-Forwarded-For` entry. Behind Cloudflare it may only be in `CF-Connecting-IP`. If so, the rate-limit IP lookup must be adjusted before launch.
5. Mount persistent volumes for `pgdata` and `launcher`, then create the admin.

## Dropping in a launcher build

The launcher is never in `public/`. It is served from `LAUNCHER_DIR` (the `launcher` named volume, mounted at `/launcher`), and only through a signed link that expires after 5 minutes.

1. Put the build file in the directory, for example `TheWorldAfterZ-Launcher-1.0.0.zip`.
2. Write `manifest.json` next to it, using the same format as `deploy/launcher-example/manifest.json`:
   ```json
   { "version": "1.0.0", "filename": "TheWorldAfterZ-Launcher-1.0.0.zip", "sha256": "<sha256sum output>", "size": 123456 }
   ```
   `sha256sum file` and `stat -c %s file` give you the hash and the size.
3. Copy both into the volume through the host path. No rebuild or restart is needed. The app mounts the volume read-only, so write from the host:
   ```bash
   LDIR=$(docker volume inspect -f '{{ .Mountpoint }}' "$(basename "$PWD")_launcher")
   sudo cp TheWorldAfterZ-Launcher-1.0.0.zip "$LDIR/" && sudo cp manifest.json "$LDIR/"
   ```
   If you prefer, replace the named volume with a bind mount such as `./launcher:/launcher:ro` in `docker-compose.yml`.

Write the file first and `manifest.json` last, so the manifest never points at a half-copied file.

## Following the launcher update feed

Set `LAUNCHER_FEED_URL=https://twaz-updates.ncatechsolutions.org/` to follow
`playtest/latest.json` → `platforms.win-x64` → `launcher`. An explicit LAN override
`http://192.168.4.20/twaz/` is supported if reachable; prefer HTTPS outside a trusted LAN.
Unset/empty keeps the original volume-only resolution. Invalid configuration, missing
launcher metadata, network failures, unsupported encoding or integrity failures fall
back to the existing volume manifest; if neither is available, the existing unavailable notice remains.

The page reads metadata only (5-second request timeouts, 256 KiB response caps,
60-second in-process TTL). It displays `launcher.version` and decoded size. After the
existing verified-account/key gate, `/api/download` downloads and verifies the immutable
object **before** issuing its five-minute link, allowing safe volume fallback before
signing. The file route re-resolves and verifies the exact filename/SHA identity;
a promotion or fallback to a different SHA invalidates the link (retry Download).
Existing in-flight filename-only links also expire on upgrade; no access gates change.

Plain objects and `.gz` objects are supported; gzip is decoded server-side, never
streamed unverified. Decoded size and SHA-256 must match, with a 512 MiB hard limit
on both stored and decoded bytes and a 120-second transfer deadline. Concurrent
requests share object work. Verified files are atomically renamed to SHA-named cache
entries, revalidated on use, and retained indefinitely. The cache is private, not a
public route. Its default `/tmp` location is writable by the non-root app user and
is intentionally ephemeral across container replacements; a custom directory must
be writable by UID 1001. The read-only launcher volume remains the fallback.
