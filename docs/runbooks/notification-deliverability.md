# Transactional Email Deliverability Runbook

## Scope

This runbook covers transactional receipt/resume email only. Marketing, SMS and Push remain
disabled. Never paste recipient addresses, rendered bodies, resume links/tokens, SNS payloads,
credentials, DNS values or AWS account details into tickets, chat, logs or screenshots.

## Signals and first response

- Rising Permanent Bounce or Complaint: pause new sends to the affected opaque recipient/purpose
  through the owned suppression control, confirm the atomic Inbox consumer is healthy and open the
  owning operational case. Do not edit old delivery evidence or retry.
- Transient Bounce: verify bounded retry/backoff and Dead-letter state. Do not bypass the three
  Attempt maximum or convert timeout/Unknown to failure/success.
- SNS authentication failures: verify the configured Topic/Region and certificate-verification
  component using approved synthetic evidence. Never follow a message-supplied subscription URL.
- Delivery/Inbox backlog: preserve ordering/idempotency, stop unsafe replay and escalate with only
  opaque Notification, Attempt and correlation references.

## Recovery and evidence

1. Confirm WP-1720 readiness evidence remains current for `ca-central-1`.
2. Confirm DKIM/SPF/DMARC and SES Production Access through the approved external evidence process;
   do not infer them from application success.
3. Reconcile Inbox uniqueness, suppression state, operational cases, retry eligibility and
   Dead-letter count with synthetic or authorized minimized evidence.
4. Resume only after the owning alert/case records approval. An explicit resend requires its own
   authorization reference and creates a linked append-only Attempt.
5. Record timestamps, opaque references, counts, decision owner and evidence-policy reference.

Retention and legal hold follow the approved policy reference. Application code and responders may
not shorten retention, delete Provider evidence, unsuppress a Complaint automatically or claim a
production/deliverability pass without the real external evidence.
