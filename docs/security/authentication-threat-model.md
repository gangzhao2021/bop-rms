# Authentication Threat Model

## Scope and decision status

This model covers Merchant and Admin authentication through the accepted same-origin BFF, the
Identity-owned OIDC transaction and server Session stores, and authorization handoff to Tenant,
Membership and Permission. It also records the distinct order-scoped Guest Session boundary. It is
owned by Identity with Security, Privacy and Architecture review and is versioned with the code.

Local status is **synthetic contract evidence only**. Cognito Plus, a confidential app client,
Threat Protection, WAF, KMS, Secrets Manager, production Session storage, approved workforce tests
and penetration evidence are **External Evidence — unavailable and unclaimed**. Production
Merchant authentication stays disabled until every external gate in this document is satisfied.

## Security objectives

1. A Provider assertion authenticates an identity but never grants Brand, Store, object or action
   authority.
2. Browser-visible authentication state is an opaque, high-entropy `__Host-` Cookie; OIDC tokens,
   selectors, authorization codes, PKCE material and encryption keys never enter application URLs,
   browser storage, Service Worker state, logs, analytics or public errors.
3. Every state-changing request requires a current server Session, exact same-origin and Fetch
   Metadata checks, and a Session-bound CSRF credential held only in page memory.
4. Session creation, privilege elevation, recovery, risk change and Store-context change rotate
   authority. Logout and lifecycle changes revoke it server-side before browser cleanup.
5. Authentication denial is uniform and non-oracular. Authorization re-resolves current Tenant,
   Membership, Store Assignment, object scope and deny-first Permission evidence.
6. Restricted security evidence is minimized, access-controlled and retained only by an approved
   policy; raw credential material is prohibited data.

## Actors and dependencies

| Actor or dependency          | Trust level                       | Allowed responsibility                                                           | Explicitly not authoritative for                           |
| ---------------------------- | --------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Merchant/Admin browser       | untrusted                         | carry `__Host-` Cookie; hold CSRF in page memory; navigate exact clean paths     | identity claims, Tenant/Store, Permission, expiry, success |
| Customer browser             | untrusted                         | carry one order-scoped Guest Cookie and in-memory CSRF                           | Merchant capability, arbitrary Customer/Order lookup       |
| Same-origin API/BFF          | trusted composition               | validate HTTP boundary; orchestrate OIDC/Session ports; return minimized context | Provider rules, Membership facts, Permission grants        |
| Identity Domain              | trusted owner                     | Actor, external-link, OIDC transaction, Session, MFA/recovery/revocation rules   | Tenant/Store business facts or action grants               |
| Cognito                      | external trusted-after-validation | authenticate workforce and operate password/TOTP verifier material               | Brand, Store, object ownership or Permission               |
| PostgreSQL Session store     | restricted trust                  | atomic hashed-selector lookup, encrypted-token state, versions and revocation    | plaintext selectors/tokens or authorization policy         |
| KMS/Secrets Manager          | external restricted trust         | environment-scoped encryption and client/pepper secret custody                   | application authorization                                  |
| Tenant/Membership/Permission | trusted owners                    | current Brand/Store scope, assignment and deny-first action decision             | Provider/token validity                                    |
| Security operations          | privileged and audited            | investigate minimized risk evidence and execute approved response                | silent risk acceptance or unrestricted impersonation       |

## Assets and data classification

| Asset                                                                  | Classification                  | Permitted location                                                          | Prohibited location                                                                                                               |
| ---------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Cookie/CSRF/state/nonce/PKCE/code/tokens/client secret/pepper/data key | Prohibited plaintext credential | transient process memory; encrypted Provider/secret boundary where required | database plaintext, URL except one-time Provider callback code/state, logs, metrics, traces, analytics, fixtures, browser storage |
| Hashed selectors and authenticated ciphertext                          | Restricted                      | Identity-owned Session/OIDC records                                         | public contracts, frontend, cross-Domain tables                                                                                   |
| Actor/external subject surrogate/Session/Membership references         | Confidential identifier         | owning records and request-private context                                  | public errors, metric labels, analytics                                                                                           |
| Risk, MFA, recovery and revocation evidence                            | Restricted security evidence    | owning append-only Audit/Case records under policy                          | general logs, browser cache, business projections                                                                                 |
| Brand/Store/Permission decision                                        | Confidential authorization fact | Tenant/Membership/Permission owner and request-private context              | Provider claims, client-selected headers/body                                                                                     |

## Data flows and trust boundaries

1. **Browser → same-origin BFF.** TLS, exact HTTPS Origin/Host, Fetch Metadata, JSON/body limits,
   `__Host-` Cookie and Session-bound CSRF cross an untrusted network/browser boundary. Responses
   containing authentication or authorization state are `no-store` and never enable credentialed
   cross-origin access.
2. **BFF → Identity.** Exact provider-neutral commands cross the composition/Domain boundary. The
   BFF cannot inspect Identity private tables or manufacture Actor/Session facts.
3. **Identity → Cognito.** Authorization Code + PKCE S256, exact redirect, state, nonce, issuer and
   audience validation cross an external Provider boundary. Provider payloads are canonicalized to
   minimum claims; raw ID Token data is discarded.
4. **Identity → PostgreSQL/KMS/Secrets.** Only keyed selector hashes and authenticated ciphertext
   cross the persistence boundary. Encryption context binds environment, Session and Actor. A
   decrypt/authentication failure revokes authority and emits minimized security evidence.
5. **BFF → Tenant/Membership/Permission.** Current route resource and current owning-Domain facts
   derive scope. Permission runs deny-first; Provider subject/email and client scope never grant it.
6. **Operations → recovery/break-glass.** Named, recent-MFA, purpose-bound and audited approval
   crosses a privileged-human boundary. High-risk recovery requires separation of duties; there is
   no reusable bootstrap or email-only bypass.

## Threat register

`Local evidence` names executable repository contracts, not production proof. An `External gate`
disposition blocks live enablement until independently evidenced.

| ID         | STRIDE / misuse case                             | Attack and affected boundary                                                          | Preventive and detective controls                                                                                                                         | Local evidence                                                       | Owner / disposition                                                                          |
| ---------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| TM-AUTH-01 | Spoofing / login CSRF                            | attacker binds a victim browser to an attacker authorization transaction              | fresh state/nonce/PKCE, exact auth Cookie, same-origin start, one-time transaction, generic failure                                                       | browser Session and Merchant BFF acceptance                          | Identity / local controlled; Provider interoperability is an External gate                   |
| TM-AUTH-02 | Spoofing / authorization-code injection          | stolen or substituted code crosses callback boundary                                  | consume transaction before exchange, exact redirect/issuer/audience/nonce, PKCE S256, clear ephemeral Cookie                                              | browser Session adversarial callback matrix                          | Identity / local controlled; real Cognito negative evidence is an External gate              |
| TM-AUTH-03 | Elevation / Session fixation                     | attacker supplies a chosen pre-login selector or reuses a predecessor                 | ignore candidate, generate high-entropy selector, rotate at login/elevation/recovery/risk/Store change, atomically invalidate predecessor                 | browser Session fixation/rotation tests                              | Identity / controlled                                                                        |
| TM-AUTH-04 | Information disclosure / Cookie or token theft   | script, cache, URL, telemetry or storage exposes credentials                          | `Secure; HttpOnly; SameSite=Lax; Path=/;` no Domain; `no-store`; no Web Storage/IndexedDB/Service Worker; redaction checks                                | Cookie snapshots, response/log/object scans                          | Identity + API / controlled; CSP browser evidence is WP-2047                                 |
| TM-AUTH-05 | Tampering / CSRF                                 | cross-site request performs an authenticated mutation                                 | exact Origin/Host/Fetch Metadata, same-origin JSON, Session-bound constant-time CSRF comparison, rotation                                                 | Merchant BFF and Store-switch negative matrices                      | API + Identity / controlled                                                                  |
| TM-AUTH-06 | Information disclosure / database compromise     | Session database reveals replayable tokens or selectors                               | HMAC selector hashes, authenticated ciphertext, environment/Session/Actor context, PUBLIC denial, no raw Provider JSON                                    | isolated Session-store compromise and ACL tests                      | Identity + Data / controlled locally; KMS/Secrets evidence is an External gate               |
| TM-AUTH-07 | Repudiation / stale Session                      | idle/absolute-expired, revoked or background-extended Session remains usable          | server clock on every request, bounded foreground last-seen, no SSE extension, atomic revocation and cleanup                                              | Identity Session lifecycle tests                                     | Identity / controlled                                                                        |
| TM-AUTH-08 | Elevation / role or Store drift                  | cached Membership/Assignment or Provider claim retains removed authority              | re-resolve current owning-Domain facts, rotate Store switch, deny-first Permission, lifecycle global revocation                                           | Merchant authentication, object authorization and Store-switch tests | Membership + Permission + Identity / controlled                                              |
| TM-AUTH-09 | Elevation / cross-Tenant object access           | Actor probes foreign Brand, sibling Store or unknown object                           | route-derived scope, exact object-scope check after Permission, uniform denial, request-private cleanup                                                   | WP-0109 cross-Tenant matrix                                          | owning Domain + API / controlled; WP-2041 expands persistence evidence                       |
| TM-AUTH-10 | Denial / concurrent Session abuse                | excess or racing Sessions bypass limits or fork authority                             | profile-specific finite limit, deterministic oldest revocation, optimistic version/single winner                                                          | browser Session concurrency tests                                    | Identity / controlled; production load evidence is an External gate                          |
| TM-AUTH-11 | Spoofing / enumeration and credential stuffing   | login/recovery timing or messages reveal accounts; automated guesses exhaust verifier | invite-only pool, `PreventUserExistenceErrors`, uniform bounded responses, ≥14 characters/history 10, Provider threat controls and WAF                    | generic local denial contract                                        | Identity + Security / Cognito Plus 14-day Audit→Enforced and WAF evidence are External gates |
| TM-AUTH-12 | Elevation / MFA downgrade or recovery bypass     | SMS/email-only reset or factor reset grants privileged access                         | TOTP required for privileged roles, SMS disabled, `admin_only` recovery, identity proofing, distinct approver/two-person break-glass, revoke all Sessions | workforce identity security acceptance                               | Identity + Security / real factor and recovery drill is an External gate                     |
| TM-AUTH-13 | Elevation / bootstrap or shared identity         | reusable seed path, default password or shared KDS user creates unowned authority     | one-shot first-Owner task, 24-hour invite, TOTP before business action, permanently disabled seed, named KDS Session                                      | lifecycle contract and KDS profile tests                             | Identity + Operations / first-Owner and device evidence are External gates                   |
| TM-AUTH-14 | Tampering / logout or revocation partial failure | browser Cookie clears while refresh token/session remains authoritative               | revoke local Session and Provider refresh token before Cookie clear; Provider Unknown never restores authority; idempotent global revocation              | logout/revocation failure tests                                      | Identity / local controlled; Cognito logout evidence is an External gate                     |
| TM-AUTH-15 | Denial / volumetric authentication abuse         | login, callback, bootstrap or recovery floods BFF/Provider                            | bounded body/time/concurrency, generic errors, dedicated User Pool WAF, rate/alert policy                                                                 | strict parser and bounded local HTTP tests                           | API + Security / WP-2042 and production WAF evidence are External gates                      |
| TM-AUTH-16 | Repudiation / security evidence leakage or loss  | raw credentials enter logs, or minimized events lack correlation/retention            | allowlisted structured fields, redaction, correlation, restricted 30-day security retention, append-only Audit/Case linkage                               | structured logging, Audit integrity and secret/PII scans             | Observability + Audit / controlled locally; WP-2043 and WP-2052 expand evidence              |

## Abuse and failure invariants

- Unknown, malformed, expired, replayed, cross-origin, cross-Tenant, wrong-Store and wrong-object
  requests fail closed before business mutation. Public errors do not distinguish account or
  resource existence.
- Provider, persistence, decrypt, refresh and logout `Unknown` outcomes cannot create or restore
  authority. Recovery is a new approved operation, never destructive history repair.
- A Session/Provider claim cannot construct Membership, Store Assignment, object ownership or a
  Permission Grant. Current owning-Domain facts are evaluated for every protected operation.
- Authentication state is not cached in module globals, frontend persistence, a Service Worker or
  a shared KDS login. Request cleanup and rotation prevent cross-request or cross-operator bleed.
- Security events carry correlation and opaque references only. Credential material, raw Provider
  payloads, email/username and unrestricted identifiers are forbidden.

## Verification and release gates

Local executable evidence includes `browser-session:acceptance`, `identity-session:acceptance`,
`merchant-authentication:acceptance`, `workforce-identity-security:acceptance`, Permission policy,
Store-switch/object-authorization, isolated Session-store, architecture and logging/Audit suites.
The focused WP-2040 validator checks this model's mandatory register and external-gate language.

Before any production Merchant login is enabled, the release record must independently provide:

- Cognito User Pool in `ca-central-1`, Plus plan, confidential client and exact redirect/logout URI;
- approved Secrets Manager rotation and environment-scoped KMS encryption-context evidence;
- at least 14 days of approved staging/pre-live Threat Protection Audit evidence followed by
  Enforced configuration for compromised/high-risk/medium-risk behavior;
- dedicated User Pool WAF volumetric-control and alert evidence;
- production Cookie/CSRF/fixation/revocation, concurrent-session, cross-Tenant and recovery tests;
- named first-Owner creation, MFA/reset, global revocation and break-glass drill evidence;
- security/privacy review, authenticated penetration test and incident-contact readiness.

Any missing or failing item keeps production authentication disabled and triggers Identity +
Security review; it is not waived by passing synthetic tests.

## Residual risk and review triggers

Residual risk remains for Provider behavior, phishing/social engineering, browser compromise,
credential stuffing scale, privileged operator abuse, KMS/secret compromise and cloud-control
drift. WP-2042, WP-2043, WP-2046, WP-2047, WP-2050 and WP-2052 own the adjacent executable and
operational controls. Re-review this model for any authentication Provider/flow, token lifetime,
Cookie/CORS policy, Session store, MFA/recovery, role/scope model, production topology or regulated
data change, and after any identity incident or material penetration finding.
