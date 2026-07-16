# Tooling

This directory contains repository-wide, workspace-consumable engineering configuration and developer tooling.

WP-0003 establishes the root TypeScript base configuration, ESLint flat configuration, Prettier policy, and Vitest runner. The `vitest/` directory contains only the tooling smoke test that proves TypeScript test discovery and execution.

Tooling must not become a home for domain logic, runtime application code, credentials, or machine-specific configuration. Applications and reusable packages extend the root contracts in their owning Work Packages.
