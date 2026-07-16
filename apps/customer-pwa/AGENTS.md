# Customer PWA guidance

- Preserve the Guest Session, privacy, analytics, and Section 87.3 deny-by-default offline boundary. This WP does not register a Service Worker.
- Never cache or persist private/transaction data, add background mutation replay, infer success offline, or expose tokens/PII in URLs, fixtures, logs, or analytics.
- Keep the shell mobile-first, keyboard accessible, non-color-dependent, and explicit about loading, failure, and offline read-only states.
- Run this workspace's lint, typecheck, test, and build commands after changes; root guidance remains fully applicable.
