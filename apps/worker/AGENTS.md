# Worker application guidance

- Keep this app a runtime/lifecycle composition root only. Do not simulate queues, database work, Outbox/Inbox, Providers, schedules, retries, leases, poison handling, or DLQ evidence.
- Startup, shutdown, signal registration, cleanup, and failure propagation must remain deterministic and testable.
- Never add a timer or fake job merely to keep the process alive or demonstrate activity.
- Run this workspace's lint, typecheck, test, and build commands after changes; root guidance remains fully applicable.
