---
name: pilot-regression-milestone
description: Run the bop-rms full-repository regression milestone (frozen install, static gates, unit/turbo tests, all packages/database configs under restricted roles, merchant production-fail-closed and customer browser suites, Linux-image tooling/environment) and record one WP-2423 line. Use before staff UAT, before launch approval, after changes to shared contracts/persistence/authorization/tooling, or whenever the user asks for 全仓回归 / full regression / release gate / "run everything" — not for routine small changes, which only run affected checks.
---

# Full-repository regression milestone

WP-2423 requires one before staff UAT and one before launch approval. AGENTS.md: write the
selection into the WP first (question, inputs, commands), reuse valid evidence, don't rerun
passing checks without a reason, and stop once every question has evidence.

## Ground rules

- Do not touch v15: avoid ports 4300/4443/55435 and the pilot containers.
- `source .local/activate.sh` (pinned Node/pnpm) in every Bash call; use absolute paths — the
  shell cwd races between parallel calls.
- Long steps run in the background. Only one browser suite at a time (shared `dist`, port 4173,
  `test-results`), serialized with `lockf /tmp/bop-merchant-browser.lock`.
- Run independent, non-browser steps concurrently only if the host has headroom; under load,
  5 s CLI timeouts appear that pass alone — rerun the single item before calling it a failure.

## Steps

1. **Install:** `pnpm install --frozen-lockfile --offline`.
2. **Static gates:** each `*:check` from the root `verify` script plus `format:check`, `lint`,
   `typecheck`, `build`. Run them individually (not `pnpm verify`, whose `&&` chain hides
   everything after the first failure).
3. **Unit:** root `vitest run` and `turbo run test --continue`. On macOS ~12 files / ~94 cases
   in `tooling/environment` fail (process control/leases) — host noise; step 6 is their real gate.
4. **Database:** run every `packages/database/vitest.*.config.ts` one by one in a bash loop
   (zsh does not split newline lists), `TMPDIR=/private/tmp`, recording pass/fail per config.
   Rerun each failure alone; classify as regression, timing/load, or known unstable
   (`option-set-binding` option-publish case, `store-configuration` concurrent Validate race).
5. **Browsers:** rebuild changed workspace packages (vite reads their `dist`), then
   - merchant: `lockf /tmp/bop-merchant-browser.lock pnpm --filter @bop-rms/merchant-web exec playwright test --config .playwright-reuse.config.ts --project production-fail-closed`
     (the reuse config is local and untracked — never commit it). Baseline 0 failures; skipped
     specs are the WP-2421 pages listed in WP-2423. To rerun only some specs, write
     `--project=production-fail-closed <spec-name> ...`; with a space, the spec names are read as
     project names.
   - customer: `lockf /tmp/bop-merchant-browser.lock pnpm --filter @bop-rms/customer-pwa test:browser` (all projects).
6. **Linux image:** build a temporary image of HEAD (e.g. `bop-rms-regr:<sha>`, not the pilot
   tag), run
   `docker run --rm -e NODE_ENV=development <image> sh -c 'cd /app && mkdir -p .local && HOME=/tmp ./node_modules/.bin/vitest run tooling/environment'`,
   then delete the image.

## Judging results

A failure is a regression unless it is on the known list above or passes alone with a recorded
load/timing reason. A config that fails the same way every run usually traces to a recent commit
that changed behaviour on purpose while that config was not run (2026-10-22: `8eab1c5e` moved the
option-set draft's observation time after its locks): `git log <last milestone>..HEAD` on the code
under test, read the commit's intent, then fix whichever side is wrong. Fix real regressions (structural cause, not symptom) and rerun only the
affected configs/specs. A newly unstable case gets a named follow-up, not silence.

## Record

One line in `docs/spec/work-packages/WP-2423.md`, Chinese, following the existing
"全仓回归里程碑（<date>，HEAD `<sha>`…）" lines: per step the command and counts, each failure
with its classification and single-run result, fixes with commits. Update the "状态 → 剩余工作"
item for the regression milestone in place.
