---
title: "Auth.js 'server configuration' 500 = missing AUTH_SECRET in EasyDeploy env"
author: Nickanton
date: 2026-11-06
branch: fix/auth-secret-deploy
cost: { minutes: 1, tokens: 557 }
id: l-acba2211
scope: repo
status: active
touches:
  - docker-compose.yml
  - EASYDEPLOY_ENV.md
---

## Decided
- Prod login 500 ("There was a problem with the server configuration") was Auth.js MissingSecret: the EasyDeploy prod env had no AUTH_SECRET (and no DOWNLOAD_SIGNING_SECRET). Not caused by the password-reset code; the reset route doesn't touch Auth.js.
- Secrets were added to the EasyDeploy environment's envVars via the API; compose now uses `${VAR:?}` so a missing secret fails the deploy instead of every login.

## Tried and ruled out
- Reset flow / passwordChangedAt session invalidation: not involved; /api/auth/session itself 500'd for everyone.

## Watch out
- EasyDeploy PATCH /environments/:id replaces envVars wholesale: send the full map, not just new keys.
- Deploys have failed on the host with "all predefined address pools have been fully subnetted" (Docker network exhaustion on the deploy host).
- Behind Cloudflare the client IP may only be in CF-Connecting-IP; ipFrom() doesn't read it, so rate limits may share one key.
- Quick health check: curl /api/auth/session should be 200, not 500.
