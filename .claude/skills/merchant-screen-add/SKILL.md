---
name: merchant-screen-add
description: Checklist for adding or exposing a merchant-web (staff back-office) screen in bop-rms so it actually appears in the pilot workspace sidebar, routes correctly, passes the registry/ownership gates and meets the design brief. Use whenever work adds a new merchant screen, page, route or sidebar entry, moves a screen into the pilot workspace, adds a new persistence source file to a package, or a merchant link "disappears" / redirects home unexpectedly — even if the user only says "add a page for X" or "staff need a screen to do Y".
---

# Adding a merchant screen

A merchant screen is only reachable when several independent registrations agree on the same
`screenId`, `href` and permission. Missing any one of them fails silently: the link vanishes
from the sidebar or the address redirects to the nearest working screen. Touch all of them in
the same change.

## 1. Canonical definition first

Section 88 (`docs/spec/`) owns Screen IDs, routes, permissions, states and Projection ownership.
Find the screen there before writing code; do not invent an ID or route.

- `docs/product/screen-registry.yaml` — add/update the screen record (screen_id, surface
  `merchant_web`, canonical_route, permission_ref, projection_ref, command_refs, work_packages).
  Checked by `pnpm screen-registry:check`.

## 2. Registration points (all must agree)

| Where | What |
|---|---|
| `apps/api/src/merchant-bff-contract.ts` | `merchantNavigation` map entry (screenId → href, permission). `merchant-bff-workspace.ts` rejects screenIds not in this map. |
| `apps/merchant-web/src/merchant-workspace.ts` | client `merchantNavigation` map entry and the screenId union. |
| `tooling/environment/pilot-merchant.mjs` | pilot workspace `navigation` list (the sidebar labels live here, in staff language — no internal codes). |
| `apps/merchant-web/src/App.tsx` | the `<Route>` (lazy-loaded via `route-chunks.tsx` like its neighbours). |
| `apps/merchant-web/src/pilot-routes.ts` | classify the route. `App.test.tsx` keeps this list equal to `App.tsx`. A screen without real sources gets `hiddenTo` (pilot rule: no reachable stubs); one served only when the session lists it uses `listed`. |

If the screen writes data through a **new persistence source file** in a package, also accept it in
`tooling/database-ownership/validate.mjs` (an `accepted...Asset` block plus the negation chain),
otherwise `pnpm database-ownership:check` fails with `UNSUPPORTED_DATABASE_ASSET`. New tables or
grants also need the pilot ACL entry in `docs/spec/pilot-acl-additions.json` and an acceptance test
run under a restricted `NOBYPASSRLS` role with the same grants (the owner client bypasses RLS and
hides policy bugs).

## 3. Workflow completeness

AGENTS.md defines done as a usable workflow, not a page: ordinary entry from the sidebar, current
reads, authorized commands with expected version and idempotency, post-write refresh, and
error/retry states (409 "changed, refresh" for concurrent edits, not 503). Name what staff do
when the network, host or device fails.

## 4. Design

Follow `docs/spec/design/bop-rms-figma-make-brief.md` §2–3: build on `@bop-rms/ui` tokens and
`WorkspaceLayout`; no new colour schemes, gradients or pills; table cells carry `data-label` so
they become cards on phones. Screenshot-check at 1440, 1024 and 390 px.

## 5. Checks (run only what the change touches)

```bash
pnpm screen-registry:check
pnpm database-ownership:check
pnpm --filter @bop-rms/merchant-web test -- App pilot-routes
pnpm --filter @bop-rms/api build   # the local pilot imports apps/api/dist
```

Plus typecheck/lint/tests of the touched packages. For a browser run of the merchant
`production-fail-closed` suite: rebuild changed workspace packages first (vite resolves their
`dist`), use the untracked `apps/merchant-web/.playwright-reuse.config.ts` (never commit it), and
run one production suite at a time. The baseline is 0 failures; any failure is a regression.

## 6. Record

One line in `docs/spec/work-packages/WP-2423.md` (while the pilot track is active): what changed,
the commands and their results.
