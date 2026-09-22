# Development machine handoff — 2026-09-22

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

## Continue the design task

Use the [complete Figma Make brief](../spec/design/bop-rms-figma-make-brief.md),
starting with the section labelled “复制以下内容到 Figma Make”.
Target draft: https://www.figma.com/make/u5gjkcwfARvEqaiUKnCJnp/Untitled

Create an original SSENSE/Apple-inspired Orders workbench and order detail flow first.
The brief defines the exact acceptance, cancellation, Unknown recovery, Conflict refresh,
read-only, responsive and accessibility constraints. Keep the draft unpublished, preserve
sharing settings and use fictional in-memory data only. Do not connect to the real runtime.

At handoff, the brief has NOT been submitted, generation has NOT begun and no Figma
result has been inspected. The old host's normal shell failed before execution with
`app-server socket directory has an unsupported host mount at /mnt/wslg/distro`.
Computer Use failed with `sandboxCwd is not a local file URI`; the extension relay
reported `extensionConnected: false`. A new projectless task did not resolve these errors.
Test terminal and browser connectivity on the receiving computer before claiming recovery.

## Not transferred through GitHub

- `.env`, `.local/`, database volumes/backups, installation keys and certificates.
- Browser cookies, login sessions, local browser captures and dependency/build output.
- The private complete Handoff source document, which the spec index requires outside Git.

The receiving computer has source code and migration definitions, not the old host's
running `.local/pilot-v14` installation or historical database. Do not infer that cloning
restores the pilot or authorizes production activation. Retain the original host's local data.
