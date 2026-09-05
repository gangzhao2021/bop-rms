# Worker application guidance

- Keep this app a runtime/lifecycle composition root. Dispatcher, consumer-delivery and retry components exist, but the default runtime does not register business workers. Connect them only within the owning Work Package through public contracts and explicitly configured dependencies.
- Preserve the owning Outbox/Inbox, retry, lease, poison and DLQ contracts. Never fabricate queue activity, database work, Provider results, scheduling or delivery evidence.
- Startup, shutdown, signal registration, cleanup, and failure propagation must remain deterministic and testable.
- Never add a timer or fake job merely to keep the process alive or demonstrate activity.
- See the [current delivery-status ledger](../../docs/spec/project-status.md) for the remaining runtime integration work.
- Run this workspace's lint, typecheck, test, and build commands after changes; root guidance remains fully applicable.
