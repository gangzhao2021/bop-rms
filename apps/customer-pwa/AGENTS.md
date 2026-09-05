# Customer PWA guidance

- Preserve the Guest Session, privacy, analytics, and Section 87.3 deny-by-default offline boundary. WP-1707/1708 implement the bounded Service Worker: cache only the accepted public shell/Menu allowlist, keep private routes and mutations NetworkOnly, and apply updates only through the accepted safe-update flow.
- Never cache or persist private/transaction data, add background mutation replay, infer success offline, or expose tokens/PII in URLs, fixtures, logs, or analytics.
- Keep the shell mobile-first, keyboard accessible, non-color-dependent, and explicit about loading, failure, and offline read-only states.
- Add or connect Customer behavior only within its owning Work Package. See the [current delivery-status ledger](../../docs/spec/project-status.md); local synthetic previews and acceptance do not establish production or Provider readiness.
- Run this workspace's lint, typecheck, test, and build commands after changes; root guidance remains fully applicable.
