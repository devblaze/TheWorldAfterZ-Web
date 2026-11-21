# EasyDeploy env for theworldafterz.ncatechsolutions.org

Public URL: https://theworldafterz.ncatechsolutions.org/
Compose: docker-compose.yml (app:3000 + Postgres)
Repo: push to Gitea then create app in https://deploy.ncatechsolutions.org/

## Non-secret SMTP (Resend)
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=resend
SMTP_FROM=TheWorldAfterZ <noreply@ncatechsolutions.org>
# Domain ncatechsolutions.org is verified in Resend (eu-west-1).

## Secret (do not commit)
SMTP_PASS=<Resend API key TheWorldAfterZ-Web — only in /home/box/.secrets/resend_twaz_web_api_key on Lead's box; paste into EasyDeploy env>
AUTH_SECRET=<openssl rand -base64 32>              # required: without it every sign-in returns "server configuration" 500
DOWNLOAD_SIGNING_SECRET=<openssl rand -base64 32>  # required for launcher download links
# docker-compose.yml refuses to start if either is missing. Also set POSTGRES_PASSWORD etc. per README.

## Moderation
OWNER_EMAILS=<comma-separated owner emails>  # optional; each must also be in ADMIN_EMAILS. Unset/empty = nobody is owner (never falls back to ADMIN_EMAILS)

## Cloudflare note
Confirm EasyDeploy forwards CF-Connecting-IP or X-Forwarded-For for rate limits.

## Bug reports

# Required in production. Must not resolve under /tmp (the process refuses to start if it does).
# docker-compose.yml mounts the named volume `bug-reports` at /var/lib/twaz/bug-reports and defaults this path.
# A merge to main auto-deploys, and still needs Nick's verbatim go.
BUG_REPORT_STORAGE_DIR=/var/lib/twaz/bug-reports
# Optional; default 90. The app also runs the 90-day sweep once a day in-process.
# Manual: `docker compose exec app npm run bug-reports:sweep`
BUG_REPORT_RETENTION_DAYS=90

## SuperTracker (in-game bug reports)

# Optional. When unset, reports still work and no tracker issue is created.
# Dedicated 'TWAZ Bug Reporter' service-account token — names only here, never the value.
SUPERTRACKER_TOKEN=<service-account token>
# Optional; defaults shown.
SUPERTRACKER_URL=https://tracker.ncatechsolutions.org
SUPERTRACKER_PROJECT=TWAZ
