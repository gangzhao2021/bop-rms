# Transactional Email Deliverability Runbook

## Scope

This runbook covers transactional customer order messages (receipt email, "we have your order",
"your order is ready" and the one-time order link) by email and, for the single-store pilot, SMS
([DEC-PILOT-NOTIFICATIONS](../spec/design/pilot-notifications.md)). Marketing and Push remain
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

## Pilot setup: from account to first real message (DEC-PILOT-NOTIFICATIONS)

Everything below is an external gate: the repository ships the adapters with every channel
`disabled`. Do the steps in order and record each result (date, who, opaque IDs only) in WP-2423.

### 1. AWS account and credentials

1. Use the store's AWS account in `ca-central-1`. Create one IAM user or role for the pilot host with
   only: `ses:SendEmail` on the verified identity and configuration set; `sns:Publish` (SMS) and
   `sns:ConfirmSubscription` on the feedback topic.
2. If the host has no instance/task role, put the access key ID and secret access key in two
   owner-only files in the runtime directory (mode 0600, one line each, e.g.
   `aws-notification-access-key-id`, `aws-notification-secret-access-key`). Never paste them into
   `notification.json`, tickets or chat. Rotate at least every 90 days.
3. Create the suppression digest key: one line `v1:<64 hex>` (e.g. `openssl rand -hex 32`) in an
   owner-only file such as `notification-contact-digest-key`. On rotation write
   `v2:<new>,v1:<old>` (newest first); keep the old version while any suppression made with it
   must still apply.

### 2. Email (Amazon SES v2)

1. **Domain identity**: verify the sending domain (for example `mail.<store-domain>`) in SES
   `ca-central-1` with **Easy DKIM** (2048-bit); publish the three DKIM CNAME records and wait
   for "Verified".
2. **SPF / custom MAIL FROM**: set a custom MAIL FROM subdomain (e.g. `bounce.mail.<domain>`),
   publish its MX record and the SPF TXT `v=spf1 include:amazonses.com ~all`, so SPF aligns.
3. **DMARC**: publish `_dmarc.<domain>` TXT `v=DMARC1; p=none; rua=mailto:<reports address>`;
   review aggregate reports for at least two weeks, then move to `p=quarantine` (and later
   `p=reject`) only when only SES and known senders pass.
4. **Sandbox exit**: request SES production access for `ca-central-1` (transactional use case:
   order confirmations, ready notices and receipts only, to the address the customer typed for
   that order; bounce/complaint handling as below). Until granted, SES only delivers to verified
   addresses — use that for the internal test.
5. **Configuration set** (e.g. `bop-transactional`): **no open or click tracking**; event
   destination = SNS topic (next step) for `Bounce`, `Complaint`, `Delivery` (and optionally
   `Reject`, `DeliveryDelay`, which are acknowledged and not stored).
6. **Feedback topic**: create a standard SNS topic (e.g. `bop-transactional-events`) in
   `ca-central-1`; leave **raw message delivery off**; subscribe
   `https://<api-host>/api/v1/provider/ses-feedback` (HTTPS). The API confirms the subscription
   itself with `ConfirmSubscription` for exactly this topic (it never opens the SubscribeURL); the
   subscription must show "Confirmed" within a minute of the API starting with email enabled.

### 3. SMS in Canada (Amazon SNS / End User Messaging SMS)

1. In AWS End User Messaging SMS (`ca-central-1`), acquire an origination identity for
   application-to-person transactional texts to Canadian numbers (a toll-free number or a short
   code; a 10-digit long code is not appropriate for application traffic in Canada). Complete the
   registration the console requires for that number type and country, and do not send until the
   registration and number show **Active**. Record the registration ID in WP-2423.
2. Set the account's SMS type default to **Transactional** and raise the **monthly SMS spend
   limit** from the account default to the store's approved amount (service quota request).
3. Keep the AWS opt-out list on: a customer who replies STOP is not texted again; HELP is
   answered by AWS with the registered message. The pilot only texts the number the customer
   typed for that order about that order (no marketing; CASL consent is not used for this).
4. Texts are English-only today; if the store is in Quebec, French versions are required before
   launch (WP-2423 store facts).

### 4. Turn it on

Write `notification.json` (mode 0600) in the runtime directory and restart the API and the
business worker:

```json
{
  "schemaVersion": 1,
  "email": {
    "provider": "ses",
    "region": "ca-central-1",
    "fromAddress": "orders@mail.<store-domain>",
    "fromDisplayName": "<Store public name>",
    "configurationSetName": "bop-transactional",
    "feedbackTopicArn": "arn:aws:sns:ca-central-1:<account>:bop-transactional-events",
    "accessKeyIdFile": "aws-notification-access-key-id",
    "secretAccessKeyFile": "aws-notification-secret-access-key"
  },
  "sms": {
    "provider": "sns",
    "region": "ca-central-1",
    "originationNumber": "+1<registered number>",
    "accessKeyIdFile": "aws-notification-access-key-id",
    "secretAccessKeyFile": "aws-notification-secret-access-key"
  },
  "customerOrigin": "https://<customer host>",
  "contactDigestKeyFile": "notification-contact-digest-key"
}
```

Either channel may stay `{ "provider": "disabled" }`. Omit both credential file names to use the
host's AWS role. `customerOrigin` null means messages go out without the one-time order link.

### 5. Verify (one live check per item, batch them)

- `GET /api/v1/customer/order-messages` answers the channels you enabled; checkout shows the
  matching sentence and, with email, "Email my receipt".
- One test pickup order with a verified address and a test phone: "we have your order" at payment,
  "your order is ready" when the kitchen marks it ready, the receipt email when requested. Each is
  one row in `bop_notification.customer_order_notification_attempt` and one `Accepted` outcome.
- Open the order link on a second phone within 30 minutes: it opens the order; opening it again
  shows "This link can’t open your order". After 30 minutes the same.
- SES mailbox simulator: send to `bounce@simulator.amazonses.com` and
  `complaint@simulator.amazonses.com` (as pickup or receipt email). Each gives one
  `delivery_provider_event`, one `contact_suppression` row and one `delivery_issue_case`; a later
  order to the same address is `Suppressed`.

### Operator queries (opaque references only)

```sql
SELECT kind, count(*) FROM bop_notification.delivery_issue_case
 WHERE opened_at > now() - interval '7 days' GROUP BY kind;
SELECT outcome, count(*) FROM bop_notification.customer_order_notification_outcome
 WHERE recorded_at > now() - interval '1 day' GROUP BY outcome;
```

A rising `Unknown` count means the provider was unreachable or slow; orders are unaffected and
nothing is resent automatically. Staff reach the customer from the order detail (pickup contact)
or at the counter by name/order number.
