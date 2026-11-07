---
title: "Pinned compose subnet verified on prod: auto-deploy now recreates only the app container"
author: Nickanton
date: 2026-11-07
branch: ui/account-polish
cost: { minutes: 1, tokens: 1981 }
id: l-c781e974
scope: repo
status: active
touches:
  - docker-compose.yml
  - src/app/account/page.tsx
---

## Decided
- After PR #2 (declared 10.213.0.0/24 in docker-compose.yml) merged, the poll-triggered auto-deploy of 3ef2a85 succeeded: the log shows only "Container ...-app-1 Recreate/Started", with no Network remove/create lines and no detach-and-retry. That is the evidence the repo-side pin fixes the recurring "active endpoints" / "not connected to the network" failure without a platform upgrade.
- Old failure logs get re-pasted from the EasyDeploy UI after the fix; check deployment dates and the gitSha against the merge before treating them as new failures.

## Tried and ruled out
- Nothing new; the platform-upgrade route (EasyDeploy v0.6.15) was left as a backup, not needed.

## Watch out
- A deploy that fails again with network errors means the prod network lost its 10.213.0.0/24 subnet or another project took it; re-pin or change the subnet in docker-compose.yml.
