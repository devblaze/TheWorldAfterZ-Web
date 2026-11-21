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

## Bug reports (optional until a deploy is approved)

# Directory for private replay/screenshot blobs. Unset uses /tmp/twaz-bug-reports (not durable).
# Intended production path: a host mount of Nick's Unraid share \\192.168.4.253\grokbot, if the EasyDeploy
# host can mount it. Do not change compose/EasyDeploy in this PR for that mount; set the env var to the
# mount path when Nick approves a deploy. A merge to main auto-deploys, and still needs Nick's verbatim go.
BUG_REPORT_STORAGE_DIR=/var/lib/twaz/bug-reports
# Optional; default 90. Used by `npm run bug-reports:sweep` (not scheduled automatically).
BUG_REPORT_RETENTION_DAYS=90
