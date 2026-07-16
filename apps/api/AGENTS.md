# API application guidance

- Keep this app a transport and composition root. No business rule, ORM, Provider SDK, authentication implementation, or cross-Domain Repository belongs here.
- Preserve the app-factory/process-entry split. Health and readiness must be structured, bounded, and truthful about unconfigured dependencies.
- Default HTTP behavior must fail safely: finite limits/timeouts, no credentialed cross-origin policy, no payload echo, no raw stack, and no request/response body logging.
- Run this workspace's lint, typecheck, test, and build commands after changes; root guidance remains fully applicable.
