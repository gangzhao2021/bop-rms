# Pilot Integration Readiness Inventory

## Purpose and authority

This is an owner-action inventory for the planned Ontario Pilot. It summarizes gates already named
by the accepted BOP-RMS specification, ADRs, Work Packages and repository policies. It is not the
external `IDR-0037`, a legal/compliance opinion, a production approval or an evidence store.

Authority is the `BOP-RMS-HANDOFF` version `0.5.3` composite baseline in the Specification Index,
especially Sections 80.7, 87.11–87.13 and 89–91; ADR-0018 and ADR-0023–0028; WP-2190,
WP-2192–WP-2194; and the referenced security/runbook policies. Later accepted decisions supersede
this inventory if they conflict.

## Planning baseline — not operational facts

| Planning decision           | Accepted planning value                                                        | Operational boundary                                                                     |
| --------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Market                      | Canada                                                                         | Does not establish registration, hosting, Provider or production availability            |
| Jurisdiction/currency       | Ontario / CAD                                                                  | Does not establish tax registration, tax result or professional advice                   |
| Operating model             | One Canadian Operating Entity                                                  | Does not create an entity, authority, account or ownership fact                          |
| Entity provenance/name mode | New dedicated numbered Ontario corporation                                     | Does not provide a corporation number, filing or legal name                              |
| Formation profile           | Simple single-founder planning profile, subject to professional review         | Does not identify a person or establish shares, directors, officers or registered office |
| Store/fulfillment           | Toronto synthetic `CA-ON-TOR-PILOT-001`; Dine-in and Pickup; Delivery disabled | Does not identify premises, address, operating hours or a real Store                     |

The canonical synthetic gate `STORE-LIVE-GATE-CA-ON-TOR-001` remains blocked. No row below changes
runtime authority or enables production behavior.

## Controlled states

- `Blocked — source unavailable`: the governing external source has not been supplied and
  reconciled.
- `Blocked — evidence unavailable`: the requirement is known, but no accepted real evidence is
  available.
- `Ready for owner action`: prerequisites are met and an accountable owner may initiate the named
  external action under separate authorization.
- `In review`: a controlled reference has been submitted to the accountable reviewer.
- `Accepted`: the owning reviewer has accepted a current, scoped reference; this is not by itself
  production authorization.
- `Not applicable`: the owning reviewer records a reason, scope and version. Absence is never
  interpreted as not applicable.

Only the last four states may be assigned by a later evidence-intake process. This initial inventory
contains no external evidence and therefore initializes every item as blocked.

## Evidence handling contract

For a later update, record only a stable controlled reference, evidence owner, scope, version,
issued/reviewed times, validity/expiry and review decision. Keep evidence bytes outside Git in an
approved restricted system. Never record credentials, tokens, unrestricted storage/object IDs,
payment data, health/allergy facts, government identifiers, home addresses or unnecessary PII.

A local test, synthetic fixture, screenshot, demo, build or GitHub workflow can prove software
behavior only. It cannot satisfy any professional, legal, Store, Provider, operator, production or
real-data row below.

## Readiness matrix

| ID           | Category            | Accountable owner                            | Required outcome/evidence                                                                                                                 | Repository dependency                           | Initial state                  | Unblock condition                                                                                                                            |
| ------------ | ------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| PILOT-SRC-01 | Source authority    | Product + Compliance                         | Authoritative `IDR-0037` version is supplied through an approved restricted channel and reconciled against this matrix                    | Spec index; WP-2194                             | Blocked — source unavailable   | Named owners accept a versioned reconciliation; no source bytes or access metadata enter Git                                                 |
| PILOT-GOV-01 | Governance          | Product + Release                            | Named Pilot scope, accountable owners, change window, rollback authority and go/no-go process                                             | Sections 89–91; release evidence policy         | Blocked — evidence unavailable | Approved scope and decision process references exist with current owners and version                                                         |
| PILOT-LEG-01 | Corporate/legal     | Legal + Finance                              | Dedicated Ontario corporation formation and authority are professionally verified                                                         | ADR-0024–0027; WP-2190                          | Blocked — evidence unavailable | Legal reviewer accepts controlled formation and authority references                                                                         |
| PILOT-LEG-02 | Corporate/legal     | Legal + Finance                              | Registered office, ownership, director/officer and signing authority satisfy the accepted real structure                                  | ADR-0027; WP-2190                               | Blocked — evidence unavailable | Professional review accepts current references and any planning differences are resolved by a new decision                                   |
| PILOT-STR-01 | Premises/Store      | Store Operations + Legal                     | Real premises identity, right of occupancy/use and exact Store scope are verified                                                         | ADR-0028; WP-2192                               | Blocked — evidence unavailable | Accepted premises and Store references replace the synthetic planning identity through the owning workflow                                   |
| PILOT-STR-02 | Premises/Store      | Store Operations + Compliance                | Applicable municipal, building, fire, occupancy and business permissions are current                                                      | WP-2194 Live Gate                               | Blocked — evidence unavailable | Compliance owner accepts every applicable reference or records reviewed non-applicability                                                    |
| PILOT-STR-03 | Premises/Store      | Store Operations                             | Real timezone, business-day start, hours, service periods, capacity and Dine-in/Pickup configuration are approved                         | WP-2192                                         | Blocked — evidence unavailable | Store owner publishes reviewed configuration through accepted Store/Live Gate controls                                                       |
| PILOT-FOD-01 | Food safety         | Food Safety + Store Operations               | Food-premises/public-health requirements, inspections and operating permissions are current                                               | WP-2194; Compliance contracts                   | Blocked — evidence unavailable | Food-safety owner accepts applicable authority references and expiry tracking                                                                |
| PILOT-FOD-02 | Food safety         | Food Safety + People Operations              | Required food-handler/operator qualifications and training coverage are verified without storing personal evidence in Git                 | Compliance qualification workflow               | Blocked — evidence unavailable | Qualification owners accept minimized controlled references for the named operating roles                                                    |
| PILOT-TAX-01 | Tax/fiscal          | Finance + Tax professional                   | Business/tax registrations, filing obligations, fiscal settings and receipt requirements are professionally confirmed                     | ADR-0023/0027; Tax and Receipt boundaries       | Blocked — evidence unavailable | Tax professional accepts current registration/configuration references and effective dates                                                   |
| PILOT-PAY-01 | Payment             | Finance + Payment owner                      | Provider merchant account/KYC, supported methods, settlement/refund/dispute ownership and commercial approval are complete                | WP-2045 future live Payment gate; WP-2194       | Blocked — evidence unavailable | Payment owner accepts Provider/account references; no credential is copied into Git                                                          |
| PILOT-PAY-02 | Payment             | Security + Payment owner                     | Live credentials, webhook trust, secret rotation, least privilege and environment separation are proven in approved systems               | Security policies; Payment Provider boundary    | Blocked — evidence unavailable | Security review accepts configuration evidence and rollback/revocation ownership                                                             |
| PILOT-PAY-03 | Payment             | Payment + Store Operations                   | If in-person Payment is in scope, Terminal Location, approved reader/device, network path and end-to-end refund/settlement UAT pass       | Device management; WP-1808/WP-2045 future gates | Blocked — evidence unavailable | Scoped device and Provider UAT references are accepted; otherwise reviewed `Not applicable`                                                  |
| PILOT-PRV-01 | Privacy             | Privacy + Legal                              | Public notices, consent/legal basis, retention, data-subject request and incident processes are approved for the exact Pilot              | Privacy workflows; WP-2194                      | Blocked — evidence unavailable | Privacy/legal owners accept versioned policy/process references and effective dates                                                          |
| PILOT-PRV-02 | Privacy             | Privacy + Security                           | Vendor/data-flow inventory, residency/transfers, access boundaries and deletion/retention controls are reviewed                           | Security/cloud evidence policies                | Blocked — evidence unavailable | Privacy/security review accepts a minimized scoped inventory and unresolved risks have owners                                                |
| PILOT-ACC-01 | Accessibility       | Accessibility + Product                      | Customer and Merchant workflows receive applicable accessibility review, including alternate ordering/support paths                       | Section 88 Screen contracts; browser gates      | Blocked — evidence unavailable | Accessibility owner accepts review evidence and bounded remediation disposition                                                              |
| PILOT-ACC-02 | Accessibility       | Accessibility + Store Operations             | Real premises accessibility and accommodation process are reviewed                                                                        | Store/Dining configuration; WP-2194             | Blocked — evidence unavailable | Accepted premises/process references exist or reviewed non-applicability is recorded                                                         |
| PILOT-OPS-01 | Staffing/operations | Store Operations + People Operations         | Named operating roles, shift coverage, training, escalation and segregation responsibilities are approved                                 | Permission/qualification workflows              | Blocked — evidence unavailable | Role owners accept minimized assignment/qualification references; no employee PII enters Git                                                 |
| PILOT-OPS-02 | Staffing/operations | Support + Security                           | Support, incident, break-glass, on-call and rollback operators are named and exercised with audit evidence                                | Break-glass and observability runbooks          | Blocked — evidence unavailable | Current exercise/review references and escalation contacts are accepted in approved systems                                                  |
| PILOT-DEV-01 | Devices/network     | Store Operations + Technology                | Pilot-enabled managed browser KDS and network inventory, placement, connectivity, failure-mode and recovery UAT pass for real premises    | Device management; WP-1804/WP-1808; IDR-0039    | Blocked — evidence unavailable | Device owner accepts scoped KDS/network UAT and contingency references; disabled output remains future-gated                                 |
| PILOT-PLT-01 | Platform/security   | Platform + Security                          | Production account/environment, region, DNS/TLS, identity/MFA, secret/KMS, least-privilege and audit boundaries are approved              | Cloud/security policies; Platform Live Gate     | Blocked — evidence unavailable | Security/platform reviewers accept current environment and access-control evidence                                                           |
| PILOT-PLT-02 | Platform/security   | SRE + Data                                   | Backup/restore, disaster recovery, retention, monitoring, alert routing, capacity and incident evidence meet approved objectives          | Backup/restore and observability runbooks       | Blocked — evidence unavailable | Named owners accept dated exercises, objective results and unresolved-risk disposition                                                       |
| PILOT-PLT-03 | Platform/security   | Security + Release                           | Required SBOM, provenance, dependency, secret, SAST, container/IaC, owned-route DAST and license artifacts pass for the release candidate | `docs/security/release-evidence-policy.json`    | Blocked — evidence unavailable | Exact-candidate release evidence is accepted with tool versions and findings disposition                                                     |
| PILOT-COM-01 | Communications      | Product + Support                            | Customer-facing domains, sender identities, notification templates, deliverability, consent and failure handling are approved             | Notification deliverability runbook             | Blocked — evidence unavailable | Channel owners accept production sender/domain and deliverability evidence                                                                   |
| PILOT-DAT-01 | Production data     | Data + Store Operations                      | Minimal real Tenant/Brand/Store/operator/Catalog initialization is approved, source-attributed and rollback-capable                       | Owning Domain commands; Live Gate               | Blocked — evidence unavailable | Live Gate prerequisites pass and separately authorized initialization uses owning contracts; no ad hoc seed                                  |
| PILOT-GO-01  | Production go/no-go | Product + Compliance + Security + Operations | Exact-scope Store and Platform Live Gates have current accepted evidence, no unresolved blocker and an independently authorized decision  | WP-2194; `STORE-LIVE-GATE-CA-ON-TOR-001`        | Blocked — evidence unavailable | Every applicable row is accepted/not-applicable, required future WPs are integrated, and a new explicit production authorization is recorded |

## Current software evidence — not external readiness

The [current delivery-status ledger](../spec/project-status.md) owns the software progress summary. The following dated repository evidence is retained from WP-2206 and is valid for local software quality only:

- WP-2203 Merchant local demo browser acceptance: `42/42` deterministic Chromium tests.
- WP-2205 Customer local demo browser acceptance: `36/36` deterministic Chromium tests.
- Exact `main@ee54f68e1e0f7cb08ca975486d5ed780444202c4` passed complete GitHub run/job
  `33762450947 / 100671860220` in `33m41s`.
- WP-2194 provides the fail-closed Live Gate workflow and leaves the synthetic Pilot gate blocked.

These results do not prove a deployed environment, real Store workflow, production accessibility,
device/network behavior, Provider result, professional conclusion or operator readiness.

For `PILOT-DEV-01`, the accepted first Pilot requires the managed browser KDS and its network/device UAT. Physical printers, scanner/peripheral integrations and Store Gateway output remain disabled under IDR-0039; they require an accepted scope revision before implementation or operation, or an owning review may record `Not applicable` for the disabled requirement. Stripe Terminal remains the separate `PILOT-PAY-03` boundary. This clarification changes no evidence state: all 26 initial inventory rows remain blocked.

## Owner action queue

1. Product and Compliance obtain the authoritative `IDR-0037` through an approved restricted
   channel and reconcile its exact requirements, owners and applicability with `PILOT-SRC-01`.
2. Product names accountable Legal, Finance/Tax, Store Operations/Food Safety, Privacy,
   Accessibility, Payment, Security/Platform, Data and Support owners outside this repository.
3. Those owners sequence irreversible or paid actions only after professional advice and separate
   authorization; credentials and evidence bytes remain in approved external systems.
4. After source reconciliation and owner assignment, authorize a bounded evidence-intake WP that
   records controlled references and updates Live Gate requirements without copying sensitive data.
5. Production activation remains a later explicit decision after all applicable requirements and
   future WPs pass. Completing this inventory is not that decision.

## Hard stops

Stop and seek a refreshed accepted decision if `IDR-0037` conflicts with this matrix, Pilot market
or entity/store scope changes, Delivery becomes in scope, a professional requirement is ambiguous,
an owner proposes committing evidence bytes/secrets/PII, or any status would be advanced without a
current controlled reference and owning review.
