# Worker application guidance

- Keep this app a runtime/lifecycle composition root only. Do not simulate queues, database work, Outbox/Inbox, Providers, schedules, retries, leases, poison handling, or DLQ evidence.
- Startup, shutdown, signal registration, cleanup, and failure propagation must remain deterministic and testable.
- Never add a timer or fake job merely to keep the process alive or demonstrate activity.
- Follow the root `AGENTS.md` verification policy: run or reuse affected workspace lint, typecheck, test, and build checks; documentation-only changes need text, source/link, and format review.
