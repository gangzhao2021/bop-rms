---
name: pilot-v15-deploy
description: Deploy a bop-rms revision to the local v15 pilot (compose.pilot.yaml) inside a planned update window, then run one live check and record one WP-2423 line. Use whenever the user asks to deploy, redeploy, roll out, ship to v15/pilot, rebuild or restart the pilot container, apply pilot migrations or grants, or "live test" a finished WP item — even if they just say "上线到 v15" / "部署一下" / "实测一下".
---

# Deploying to the v15 pilot

The source of truth is `docs/runbooks/single-store-pilot.md` → "Planned updates". This skill is
the condensed order of operations plus the traps that cost debugging loops before. If the runbook
and this skill disagree, the runbook wins; fix this file.

## When to deploy

Deploy once per finished WP item, not after every small fix (Owner, 2026-10-13). Cross-feature
coverage belongs in automated journey / restricted-role acceptance tests; the live check confirms
the item end to end once.

## Environment (every compose command)

Run `compose run`/`up`/`exec` from the main checkout (`/Users/ryanzhao/yashirq/bop-rms`), never
from a `.claude/worktrees/*` directory: the runtime lives in the main checkout's
`.local/pilot-runtime`, and a worktree has none, so recreated pilot/ops containers mount an empty
directory and crash-loop (2026-10-26). Building the image from a worktree is fine.

```bash
export PILOT_UID=$(id -u) PILOT_GID=$(id -g) \
  PILOT_RUNTIME_DIRECTORY=.local/pilot-v15 \
  PILOT_OFFSITE_DIR=$HOME/bop-rms-pilot-offsite
```

Shell variables do not persist between Bash calls here, so prefix each command with them. Without
`PILOT_RUNTIME_DIRECTORY` the compose default would point at old data; without
`PILOT_OFFSITE_DIR` compose refuses to start (by design).

## Steps

1. **Pre-checks.** Working tree committed; note the revision `<sha>`. Tag the current image so
   rollback is one command: `docker tag bop-rms-pilot:local bop-rms-pilot:pre-<sha>`.
2. **Build while the old version serves** (can exceed 10 min; run in the background with a long
   timeout): `docker compose -f compose.pilot.yaml build pilot`. First check `uptime` and
   `docker stats --no-stream`: the build shares the VM with the running pilot, and on 2026-10-29 a
   build next to another project's tests (load 63) left guests on the "paused" page for 8 minutes
   outside any window. Wait out other heavy work. After the build, look for pauses outside the
   window with `docker logs -t bop-rms-pilot-front-1 | grep DOWN`. Then, still before the window,
   check the new image's service entries load (2026-10-27: a tooling file importing `express`
   passed on macOS through hoisting and crashed api/customer in the image):
   `docker run --rm -e NODE_ENV=development --entrypoint sh bop-rms-pilot:local -c "cd /app && for f in pilot-api-entry pilot-customer-entry; do timeout 30 node --import ./tooling/environment/register-workspace-typescript.mjs -e \"import('./tooling/environment/\$f.mjs').then(()=>console.log('OK \$f'))\" 2>&1 | grep -E 'OK|ERR_' | head -2; done"`
   — an `ERR_` line means do not open the window.
3. **Open the window** (max 15 min, so only after the build finishes):
   `docker compose -f compose.pilot.yaml run --rm --no-deps -T ops node tooling/environment/pilot-ops.mjs maintenance start "$PILOT_RUNTIME_DIRECTORY" --reason "deploy <sha>"`
4. **Migrations and grants, only if the change needs them.**
   - Run the migration CLI inside the freshly built image — the env file
     (`.local/pilot-runtime/migrate-v14/migrate-v15.env` on the host) names its password by a
     path relative to the container's `/app`, so host runs fail:
     `docker compose -f compose.pilot.yaml run --rm --no-deps -T -e NODE_ENV=development pilot node --import ./tooling/environment/register-workspace-typescript.mjs packages/database/src/cli.ts status --env-file .local/migrate-v14/migrate-v15.env`
     → record `applied=N pending=M`; apply with `apply ... --confirm-target <environment>:<database>`.
   - Grants: render with `tooling/environment/pilot-acl-render.mjs` (usage in its header) and
     compare with the installed set; record whether they are identical or what changed. New
     grants go in `docs/spec/pilot-acl-additions.json` with approval text citing the Owner's
     standing approval of 2026-10-14 and the WP item; read the grants back after applying.
5. **Recreate:** `docker compose -f compose.pilot.yaml up -d pilot ops` (leaves `front` up, so
   guests see the "We're updating" page rather than a reset).
6. **Wait until it serves**, then end the window — ending early raises the urgent alert. If
   `/ready` has not answered, do not end the window: read `.local/pilot-runtime/pilot-v15/api.log`
   and `customer.log`, and roll back inside the window if the cause is not a quick restart.
   - `curl -fsS http://localhost:4300/ready`
   - `curl -fsS --cacert .local/pilot-runtime/pilot-v15/customer-tls-cert.pem -H 'Host: 127.0.0.1:4443' https://127.0.0.1:4443/` and `/app`
     (`https://localhost:4443` answers 421 by design) and `/menu`. In a wait loop, write the
     options out on each curl: zsh does not split `$C="--cacert … -H …"` into words, so every curl
     fails as an unknown option (2026-10-30). End the window only when the loop saw all 200s,
     never just because the loop timed out.
   - `docker compose -f compose.pilot.yaml exec -T ops node tooling/environment/pilot-ops.mjs maintenance end "$PILOT_RUNTIME_DIRECTORY"`
7. **Health:** `.local/pilot-runtime/pilot-v15/*.health.json` — 14 service files whose
   `snapshot.state` is `running`, plus `supervisor.health.json` whose `services` are all running;
   and `docker logs --since <window end> bop-rms-pilot-pilot-1 | grep -c '"level":50'` is 0.

## Live check

Use TEST data only. Exercise the item's real workflow in the browser as staff/guest would, at
1440/1024/390 for UI changes, plus the standard regression path: one pickup order with simulated
payment → accept → kitchen → pickup-code check → handed over. Staff identities are at
`https://127.0.0.1:4443/internal-test/staff` (DEMO staff / kitchen / cashier). The kitchen board
covers itself whenever the page is not visible, so when the browser pane is hidden drive kitchen
and handoff steps with a headless Playwright script (repo `@playwright/test`, imported via its
default export, `ignoreHTTPSErrors: true`) kept in the scratchpad. Never print pickup or table codes,
tokens or customer contact details in logs, screenshots or the report. Leave or clean up test
drafts deliberately and say which.

## When something fails

- Service entry files swallow the real error (`PILOT_API_START_UNAVAILABLE` etc.). Reproduce
  inside the container with the loader:
  `node --import ./tooling/environment/register-workspace-typescript.mjs <script>`
  (plain `node` fails on `.js`→`.ts` resolution — a red herring).
- Linux test suite: the running container cannot run vitest (uid 501, root-owned `/app`). Use
  `docker run --rm -e NODE_ENV=development bop-rms-pilot:local sh -c 'cd /app && mkdir -p .local && HOME=/tmp ./node_modules/.bin/vitest run tooling/environment'`.
- Database: `docker exec bop-rms-pilot-postgres-1 psql -U bop_rms_wp2402_v4_admin -p 55435 -d bop_rms_pilot_v15`.
- Rollback: `docker tag bop-rms-pilot:pre-<sha> bop-rms-pilot:local` and `up -d pilot ops`
  inside a window. Migrations are forward-only; correct with a compensating change.

## Boundaries

Standing approval covers local v15 migrations, api/worker grants, permission catalog installs and
store-role upgrades. It does not cover real external services, production, real credentials or
real customer/Store facts, nor business rules affecting customers, staff or money — those go to
the Owner.

## Record (one line in WP-2423)

Append to `docs/spec/work-packages/WP-2423.md`, in Chinese, following the existing deploy lines:

`- <date> v15 部署 \`<sha>\`（<what>）：构建镜像（旧镜像留标签 \`bop-rms-pilot:pre-<sha>\`）；<迁移 applied/pending>；<ACL 一致/变更>；计划窗口 <start>–<end>Z 内 \`up -d pilot ops\`，\`/ready\` 正常。实测（TEST 数据，…）：<numbered results>；仍待改进：<findings>。<health> 全部 running、0 失败；窗口后无 level 50。`

Then report to the Owner once for the item: what now works, what was found, what is left.
