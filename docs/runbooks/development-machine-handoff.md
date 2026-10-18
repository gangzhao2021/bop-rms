# Development machine handoff — 2026-09-22

## Current continuation navigation

This file preserves the 2026-09-22 transfer snapshot. Use [the candidate register](./project-candidate-register.md), [scenario evidence](../spec/design/business-scenario-coverage.md#current-scenario-evidence-view) and [Make/repository crosswalk](./project-completion-review.md#make-to-repository-acceptance-crosswalk-2026-09-23) for later recorded progress. Recheck live design access before an authorized edit; no historical version or save/reload result proves current access. Git transfers neither another host's private installation nor uncommitted candidates.

This is an Owner-authorized source snapshot for continuing development on another computer.
It is not a completed pilot, release approval, deployment, or new test certification.

## Get the current work

```bash
git clone --branch codex/wp-2402-pilot-submission https://github.com/gangzhao2021/bop-rms.git
cd bop-rms
```

On Windows, clone inside WSL2 at `~/src/bop-rms`, not on a Windows-mounted drive.
Use Node.js 24.18.0, Corepack 0.35.0 and pnpm 11.13.0; follow
[developer setup](../onboarding/developer-setup.md) and use `pnpm install --frozen-lockfile`.
Read [AGENTS.md](../../AGENTS.md), the [spec index](../spec/README.md),
[WP-2402](../spec/work-packages/WP-2402.md) and the
[current pilot runbook](single-store-pilot.md) before continuing implementation.
Existing records describe historical checks on their stated inputs, not a new check of this snapshot.

For non-interactive agent setup, use `CI=true pnpm install --frozen-lockfile` and
keep `CI=true` on subsequent pnpm checks for that installation. With pinned pnpm
11.13.0, CI disables the default global virtual store; mixing CI installation and
non-CI execution can trigger a settings-mismatch reinstall. This was reproduced
and diagnosed on the receiving Mac. Do not disable dependency validation to hide it.

## Historical design continuation — 2026-09-22

Use the [complete Figma Make brief](../spec/design/bop-rms-figma-make-brief.md),
starting with the section labelled “复制以下内容到 Figma Make”.
Target draft: [High-Fidelity Restaurant Order Prototype](https://www.figma.com/make/u5gjkcwfARvEqaiUKnCJnp/High-Fidelity-Restaurant-Order-Prototype).

Orders has been generated and corrected. The earlier receiving-machine task records
normal acceptance, Unknown recovery, Conflict refresh, responsive and partial keyboard
checks. The Owner subsequently requested Kitchen, Dining, Pickup and Exceptions;
at that historical transfer, version9 implemented their first draft and a repair request was in progress. For current continuation, consult the linked later crosswalk, then inspect
the live draft and [WP-2402](../spec/work-packages/WP-2402.md). Keep the draft unpublished, preserve sharing settings and use fictional
in-memory data only. Do not connect to the real runtime.

Historical initial handoff: the brief had not yet been submitted and no Figma result
had been inspected. This is superseded by the receiving-machine progress above.
The old host's normal shell failed before execution with
`app-server socket directory has an unsupported host mount at /mnt/wslg/distro`.
Computer Use failed with `sandboxCwd is not a local file URI`; the extension relay
reported `extensionConnected: false`. A new projectless task did not resolve these errors.
Test terminal and browser connectivity on the receiving computer before claiming recovery.

## Not transferred through GitHub

- `.env`, `.local/`, database volumes/backups, installation keys and certificates.
- Browser cookies, login sessions, local browser captures and dependency/build output.

The receiving computer has source code and migration definitions, not the old host's
running `.local/pilot-v14` installation or historical database. Do not infer that cloning
restores the pilot or authorizes production activation. Retain the original host's local data.

## Complete Handoff source

The Owner subsequently explicitly authorized syncing
[BOP-RMS Complete Handoff Package.md](../../BOP-RMS%20Complete%20Handoff%20Package.md)
to this public repository for development on another computer. The original document is
tracked without content changes. Windows download metadata remains excluded. Read the
[spec index](../spec/README.md) for the distinction between source availability and the
accepted composite baseline; uploading the document does not change accepted decisions.
