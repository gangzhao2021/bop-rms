# SPIKE-1300 — Payment Provider Capability / Cost / Region Spike

## Status and authority

- Status: `Public feasibility resolved; External Evidence gates retained`
- Decision date: `2026-08-03`
- Branch: `codex/spike-1300`
- Exact baseline: integrated and exact-main verified
  `main@f31b086ad46d6a347e3a08c7a9f1a358007b11c6` after WP-1226.
- WP-1226 exact-main CI passed `bootstrap` run `30814882933`, `verify` job `91690050281`
  in `14m29s`.
- Owner Handoff: `BOP-RMS-HANDOFF` v0.5.3 Sections 54.3, 54.5 F13.1, 64.10,
  86.8.2 IDR-0023, 87.5.4 and 87.9 IDR-0035.
- Repository authority: accepted Sections 92–97 through `docs/spec/README.md`.
- The complete Handoff file remains untracked, read-only and outside Git.

## Question and outcome

Can the accepted first-Pilot Payment boundary proceed with Stripe for one direct Canadian account,
online card PaymentIntents and Canadian Terminal card-present / Interac, without weakening BOP-RMS
idempotency, reconciliation, regional, privacy or External Evidence gates?

**Outcome: yes for interface and synthetic test work beginning at WP-1301.** Stripe remains the
single accepted v0.1 Provider. Public first-party material establishes technical feasibility and a
time-bounded public list-price baseline. It does not establish that the future Operating Entity has
an approved account, negotiated pricing, live capabilities, Canadian-only data residency, a valid
compliance posture or a successful real-reader test. Those facts remain explicit activation gates.

## First-party evidence snapshot

The following public facts were checked on `2026-08-03`. Links are evidence locators, not a claim
that their mutable contents are permanently frozen.

| Decision area         | First-party observation                                                                                                                                                                                                                                                  | Accepted limit                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Country               | [Stripe global availability](https://stripe.com/global) lists Canada as supported.                                                                                                                                                                                       | Public availability does not prove approval or capability enablement for the future entity/account.                                                                                         |
| Online flow           | [Payment Intents](https://docs.stripe.com/payments/payment-intents) supports a stateful create/confirm flow, reuse and idempotency keys.                                                                                                                                 | WP-1301 must normalize Provider state; browser or redirect results never become authoritative Payment facts.                                                                                |
| API stability         | [API versioning](https://docs.stripe.com/api/versioning) supports an explicit `Stripe-Version`; the observed GA reference identifies `2026-02-25.clover`.                                                                                                                | WP-1301 must pin an exact GA API/SDK pair and fixtures; no preview channel or implicit account default. Revalidate before implementation if the official GA reference changes.              |
| Request replay        | [Idempotent requests](https://docs.stripe.com/api/idempotent_requests) supports idempotency keys for `POST` retries and rejects parameter reuse conflicts.                                                                                                               | BOP operation/Attempt idempotency remains authoritative and persists beyond Provider key retention.                                                                                         |
| Webhooks              | [Webhook verification](https://docs.stripe.com/webhooks) requires the unmodified raw body; Stripe's library default timestamp tolerance is five minutes.                                                                                                                 | WP-1303 must verify before parsing, durably accept before `2xx`, redact failures and support secret rotation.                                                                               |
| Canadian Terminal     | [Canadian regional considerations](https://docs.stripe.com/terminal/payments/regional?integration-country=CA) supports Canadian accounts/Locations, CAD, cards and Interac; account and reader Location must be in the same country.                                     | Server-resolved Store → Canadian Terminal Location is mandatory; offline collection remains disabled.                                                                                       |
| Interac               | The same regional guide requires `interac_present`, treats Interac as single-message and rejects a separate capture; [Terminal refunds](https://docs.stripe.com/terminal/features/refunds) requires an in-person Interac refund flow.                                    | `manual_preferred` may coexist with `card_present`, but code must never issue a standalone Interac capture or an online Interac refund.                                                     |
| Testability           | [Reader setup](https://docs.stripe.com/terminal/payments/setup-reader) provides a simulated reader without physical hardware.                                                                                                                                            | Simulator evidence enables synthetic development only; an approved real Canadian reader/Location remains a live gate.                                                                       |
| Security              | [Stripe integration security](https://docs.stripe.com/security/guide) describes shared PCI responsibility and annual business attestation.                                                                                                                               | BOP-RMS never handles PAN/CVV; actual PCI scope/SAQ and professional approval are External Evidence.                                                                                        |
| Public standard price | [Canadian pricing](https://stripe.com/en-ca/pricing) lists domestic online cards at `2.9% + CA$0.30`, most Terminal cards at `2.7% + CA$0.05`, Interac at `CA$0.15`, international Terminal cards at `3.5% + CA$0.05`, and additional published Tap to Pay/P2PE charges. | These are a dated comparison baseline only, excluding tax, hardware, disputes, refunds, FX, connectivity, settlement and negotiated/custom terms. No business case or contract is approved. |
| Data region           | Stripe publishes global service/privacy behavior, including some global storage; its public availability pages do not promise Canadian-only residency for this integration.                                                                                              | AWS Canada hosting must not be represented as end-to-end Provider data residency. Privacy, processor/subprocessor, transfer and contract review remain blocking External Evidence.          |

## Closed decision for WP-1301+

1. Provider identity is `Stripe` and deployment model is one direct Canadian account. Connect,
   marketplace settlement, sub-merchants and alternate Providers are excluded.
2. Online v0.1 accepts `card` only, uses one PaymentIntent per BOP Payment Attempt and automatic
   capture after the accepted immutable Order submission/preconditions. Wallets, Link, BNPL, bank
   debit, cash, gift card, split tender and pay-later remain disabled.
3. Terminal v0.1 uses Canadian CAD Locations with `card_present` and `interac_present`.
   `manual_preferred` supports the accepted mixed flow: non-Interac authorization follows the
   capture watchdog, while Interac is single-message and never receives a separate capture call.
4. The core Payment Aggregate stores normalized state, stable BOP references, bounded Provider-safe
   references and evidence digests only. Raw Provider payload, secrets, client secrets, PAN/CVV,
   card fingerprint, Radar detail and unrestricted metadata never enter Domain, Event, log,
   analytics, URL, fixture or screenshot surfaces.
5. Every Provider mutation uses a deterministic environment + BOP operation/Attempt idempotency
   key. Timeouts and transport failures become `Unknown`/reconciliation work, never inferred
   success or failure.
6. Webhooks require raw-byte signature verification with bounded timestamp tolerance, current/next
   secret rotation, unique Provider Event acceptance and durable idempotent processing. Redirect or
   SDK callbacks are UX evidence only.
7. An exact stable GA API version and compatible SDK version are pinned in WP-1301. Upgrades require
   fixtures and explicit review; preview/beta versions are prohibited from the baseline.
8. The dated public prices above are planning inputs only. Financial modeling must include expected
   method/volume mix, hardware/connectivity, disputes, non-returned processing fees, refunds, FX,
   settlement, support and applicable tax before commercial approval.
9. Kill Switch, reconciliation, refund/capture watchdog, late-success compensation and exception
   projection remain owned by WP-1307–1310 and cannot be collapsed into the adapter interface.
10. No credential, account, Provider call, dependency installation, database change, live resource,
    legal conclusion, Store fact or production readiness claim is authorized by this Spike.

## External Evidence and Future Triggers

These items do not block WP-1301 contract/synthetic implementation, but they block the indicated
activation or later acceptance claim:

- Canadian Operating Entity/account approval, beneficial-owner/business records, settlement bank,
  supported capability flags and live payout currency;
- executed pricing/contract/tax schedule and an accepted volume/TCO comparison;
- restricted test/live keys, webhook endpoints/secrets, rotation procedure and least-privilege
  access evidence in the actual account;
- Canadian Terminal Location, approved physical reader, Interac present/refund and network-loss
  evidence; simulator results cannot substitute;
- privacy/DPA/subprocessor/cross-border transfer review and retention/deletion obligations;
- PCI scope/SAQ eligibility, Terminal responsibility and annual attestation by the accountable
  parties; and
- test-mode matrix, reconciliation/settlement, disputes, refund, failover and live-readiness gates
  required by IDR-0035.

If any of those facts contradict the accepted baseline, IDR-0023/0035 becomes `Revisit Required`;
the implementation must stop at the existing Provider boundary rather than silently switching
Providers or weakening controls.

## Acceptance and handoff

- Capability: `PASS for public technical feasibility`.
- Cost: `PUBLIC LIST-PRICE SNAPSHOT RECORDED; commercial approval gated`.
- Region: `CANADIAN ACCOUNT / CAD / TERMINAL FEASIBLE; residency and account evidence gated`.
- Security/privacy review: no secret, credential, real Customer/Store/Payment fact, Provider payload,
  account identifier or unnecessary PII was collected or added. Open Blocker `0`; High `0` for this
  documentation-only Spike.
- WP-1301 may now close and implement the provider-neutral adapter contract against this boundary.
- Local verification: frozen install passed all 28 workspace projects with the lockfile unchanged;
  all first-party evidence links resolved through their official Stripe pages; root Prettier plus
  all `27/27` workspace format checks passed; diff and secret/credential scans passed.
- Implementation-head GitHub CI: `PASS` on
  `15bf0e349e7305c55ccbfdcf2dcdf487257507b0` (`bootstrap` run `30816490737`, `verify`
  job `91695430970`, `14m17s`).
- Final-head and exact-main GitHub CI: pending.
