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

DEC-PILOT-NOTIFICATIONS (2026-10-20, Owner lifted the freeze for pilot needs only) adds the
customer order message path for the single-store pilot: Amazon SES v2 email and Amazon SNS SMS
adapters (`src/infrastructure/providers/`, one attempt per send, ambiguous failures recorded as
`Unknown`, never resent blindly), configuration from the runtime `notification.json` with every
channel `disabled` by default, the SNS-signed SES bounce/complaint endpoint with an Inbox,
keyed-digest suppression list and delivery issues (`2000_092`), and the receipt email purpose.
The one-time order link itself is Identity-owned (`@bop/identity` order recovery, `2000_093`).
Marketing and Push stay disabled. See `docs/spec/design/pilot-notifications.md` and
`docs/runbooks/notification-deliverability.md`.
