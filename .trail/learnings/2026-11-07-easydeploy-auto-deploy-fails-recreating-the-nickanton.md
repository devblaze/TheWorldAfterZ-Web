---
title: "EasyDeploy auto-deploy fails recreating the compose network: pin the subnet in the repo compose"
author: Nickanton
date: 2026-11-07
branch: fix/pin-compose-network
cost: { minutes: 1, tokens: 3568 }
id: l-8b7554d4
scope: repo
status: active
touches:
  - docker-compose.yml
---

## Decided
- Failed auto-deploys ("has active endpoints" for easydeploy-traefik-1, then "container ... is not connected to the network") come from the project network being removed and recreated on every deploy. Traefik is attached to it, so the remove fails, and the recovery then unplugs the app's own stopped container.
- Root cause: the repo compose had no network subnet. The EasyDeploy platform adds a subnet only when it creates the network, so the next deploy sees a changed config and recreates it. Fixed in the repo by declaring `networks.default.ipam` with 10.213.0.0/24 (the subnet prod already has), so the config never changes. Reproduced locally with docker compose: pin on deploy 1 and none on deploy 2 recreates the network; the declared subnet on every deploy leaves it alone.

## Tried and ruled out
- Waiting for the platform fix: EasyDeploy v0.6.15 (e92f2ea) fixes this, but the live platform still behaves like older code, so the repo-side pin is the fix that does not depend on a platform upgrade.

## Watch out
- If the prod network is ever deleted, another project can take 10.213.0.0/24 and the next deploy fails with a pool overlap; change the subnet here then.
- EasyDeploy prints every env var value in the deploy log under "Override contents", so secrets in pasted logs need rotating.
