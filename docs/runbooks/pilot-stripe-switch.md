# Switching the pilot to Stripe (test mode, then live)

Decision: [DEC-STRIPE-PILOT-WIRING](../spec/design/stripe-pilot-wiring.md). Owner of the account
facts: the Owner (Stripe account, keys, webhook signing secret, wallet domain). This procedure
copies no credential into Git, chat, logs or screenshots. Every secret lives in its own `0600`
file in the pilot runtime directory (for example `.local/pilot-v16`), owned by the pilot user.

## What changes for staff and guests

Guests pay in Stripe's secure card form instead of the internal "Confirm simulated payment"
buttons. Staff screens, refunds, day-end and reconciliation are unchanged. Real card numbers are
never entered in test mode: use Stripe's documented test cards only.

## A. Stripe test mode (InternalTest installation)

1. **Owner, in the Stripe Dashboard (test mode):**
   - Note the account's API version (Developers → API version). Use the same version below and on
     the webhook endpoint.
   - Create a restricted or secret test key (`rk_test_…` / `sk_test_…`) and copy the publishable key
     (`pk_test_…`).
   - Add a webhook endpoint for `https://<customer host>/api/v1/payment-provider/stripe/webhook`
     with events `payment_intent.succeeded`, `payment_intent.payment_failed`,
     `payment_intent.canceled`, pinned to that API version. Reveal its signing secret (`whsec_…`).
   - For local testing without a public host, `stripe listen --forward-to
https://127.0.0.1:4443/api/v1/payment-provider/stripe/webhook` prints a temporary signing secret;
     use it the same way.
2. **Operator, on the pilot host** (inside the runtime directory, as the pilot user):
   - `umask 077`; write the secret key to `stripe-secret-key` and the signing secret to
     `stripe-webhook-secret` (one line each, nothing else). Check `ls -l` shows `-rw-------`.
   - Create `payment.json` (`0600`):

     ```json
     {
       "schemaVersion": 1,
       "provider": "stripe",
       "stripe": {
         "mode": "test",
         "apiVersion": "<the account's API version>",
         "publishableKey": "pk_test_…",
         "secretKeyFile": "stripe-secret-key",
         "webhookSecretFile": "stripe-webhook-secret",
         "returnUrl": "https://<payment-return sanitizer host>/return",
         "webhookUrl": "https://<customer host>/api/v1/payment-provider/stripe/webhook",
         "paymentMethodDomain": "<customer host>"
       }
     }
     ```

     `returnUrl` must be on a different host than the customer app (Stripe appends the client
     credential to it); card payments do not redirect, so it is only reached by redirect-based
     methods. Leave out `paymentMethodDomain` until wallets are wanted.

3. **Check readiness (read-only):**
   `NODE_ENV=development node --import ./tooling/environment/register-workspace-typescript.mjs tooling/environment/pilot-stripe-operations.mjs check .local/pilot-v16`
   Every line must say `"status":"ok"` (or `skipped` for the wallet domain). Fix each `fail`
   (missing secret file, endpoint disabled or missing an event, API version differs, account
   cannot charge CAD) before continuing. Exit code 1 means not ready.
4. **Wallet domain (optional):** dry run first, then apply only after reading the plan:
   `… pilot-stripe-operations.mjs register-domain .local/pilot-v16`
   `… pilot-stripe-operations.mjs register-domain .local/pilot-v16 --apply --confirm-target <customer host>`
   Apple Pay additionally needs the Stripe-hosted domain association file served by the hosting
   front end (hosting gate). The card form keeps wallets off until a later change turns them on.
5. **Restart the pilot services** in a planned update window (the provider is chosen at start).
   The customer app reads `/bff/customer/payment-configuration` and shows the Stripe form; no
   frontend rebuild is needed.
6. **Verify with Stripe test cards** (record one line per item in WP-2423):
   pickup payment succeeds → order reaches the kitchen; a declined card shows "Try another card"
   and the next card succeeds; an abandoned dine-in round is cancelled at its deadline with nothing
   charged; an ordinary refund and an approved refund show in the Dashboard; the next day-end
   settlement matches Stripe's balance transactions; `check` still passes. Webhook deliveries in the
   Dashboard must show `200`.

**Rollback:** move `payment.json` aside (or set `"provider": "simulated"`) and restart in an
update window. Payments already taken stay in Stripe and in Payment's records; refunds of them
need Stripe mode back on.

**Key rotation:** add the new signing secret as `nextWebhookSecret` (`file`, `validFrom`,
`validUntil`, at most 7 days), roll the endpoint secret in Stripe, then after the overlap make it
the `webhookSecretFile` and remove the old file. A new API key replaces `stripe-secret-key` and
takes effect at the next restart.

## B. Live mode (real Store) — not available yet

The configuration refuses `"mode": "live"` and the supervisor keeps the `PaymentProvider`
capability gap open for a Pilot Store. Before live: the repository must carry the Live Provider
environment through the pilot composition (with the other Pilot gaps: staff login, managed
secrets, TLS/hosting), and the Owner must complete PILOT-PAY-01/02 (account/KYC, live keys,
webhook trust, rotation and revocation owners). Then repeat section A with live keys, a live
webhook endpoint and its secret, `mode: "live"`, and the Owner's go-live approval.

## If something fails

- `check` reports `secret-files fail`: a file is missing, not `0600`, or has an unexpected format.
- Dashboard shows webhook `400`: the signing secret file does not match the endpoint (or the host
  clock is off by more than 5 minutes). `503`: the pilot database or Stripe was unreachable; Stripe
  retries for up to 3 days and the inbox deduplicates.
- The API log line `payment_webhook_rejected` carries only a reason code.
