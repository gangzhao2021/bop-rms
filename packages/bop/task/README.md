# `@bop/task`

Provider-neutral BOP Task minimum contract for WP-0125.

The package validates exact-scope opaque work items, User/Role/Position/Queue assignment,
Membership-backed claim eligibility, expected version, idempotency, atomic Audit, terminal
finality, and explicit overdue escalation. Assignment、claim and escalation history is append-only.

Task completion records only an opaque completion reference. It never asserts or changes the
source Domain's business result. This minimum contains no free-form task body, recipient/contact
data, workforce scheduling, database, migration, scheduler, worker, production API/UI, real
Notification delivery, external resource, or External Evidence claim.
