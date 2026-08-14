# `@bop/notification`

Provider-neutral Notification stub and delivery adapter contract for WP-0124.

The package converts validated Event metadata into immutable, deduplicated Notification Requests.
It resolves exact-purpose preference and suppression evidence before routing, and keeps
transactional and marketing decisions separate. First-Pilot routing enables only transactional
Email; SMS, Push, and marketing delivery remain disabled.

Delivery attempts are append-only. Adapter timeout is recorded as `Unknown`, and explicit resend
creates a new sequence without rewriting the prior attempt. Core records contain only opaque
recipient, destination, template, content, Event, and Provider-attempt references.

This minimum contains no recipient address, content body, Provider payload, SES/SMS/Push resource,
Event consumer, retry worker, bounce/complaint handling, database, migration, production API/UI,
real delivery, or External Evidence claim.

WP-2145 adds permission-trimmed administrative projections for immutable Communication History and
versioned Template governance. Operational resend remains behind the accepted retry authorization;
Marketing cannot borrow it. Template preview evidence must be escaped, tracking is prohibited and
publication requires a distinct approver. No recipient value, live Provider result, approved sink,
content approval or persistence is introduced.
