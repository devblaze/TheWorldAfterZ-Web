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
# Also set APP auth/session secrets, DATABASE_URL, etc. per README.

## Cloudflare note
Confirm EasyDeploy forwards CF-Connecting-IP or X-Forwarded-For for rate limits.
