# `identity`

## Identity and responsibility

- Module Name: `identity`
- Package Name: `@bop/identity`
- Layer / Domain: `BOP / Identity`
- Phase / owning Work Package: `Phase 0 / WP-0100, WP-0107`
- Owner role: `Identity Engineering Owner`
- Status: `active`
- Responsibility: stable opaque Actor identity、provider-independent Authentication Session
  lifecycle、browser credential and OIDC transaction contracts、strict validation and
  current-session resolution/revocation ports.
- Explicit non-goals: Brand、Store、Operating Entity、Membership、Role、Permission、Tenant Context、
  concrete Cognito/KMS/Secrets Manager adapters、production route registration、MFA workflow and UI.

## Public contract

- `IdentityActor`: closed `User | System | Service` classification、opaque UUIDv7 Actor reference、identity-only account kind、authentication method and verification level.
- `AuthenticationSession`: closed lifecycle、exact accepted policy snapshot、UTC time bounds、rotation reference、positive version and closed revocation fact. It contains no browser secret or Provider token.
- `IdentitySessionPort`: issue、resolve、revoke and rotate operations. Mutations carry expected version、correlation、purpose and idempotency facts. Tenant and Permission composition is owned by WP-0103/0104.
- `BrowserSessionService`: provider-independent Authorization Code + PKCE orchestration over injected
  Store、OIDC、selector-hash、randomness and envelope-crypto ports. Raw selectors and token material
  never enter the public Session object.
- Events: `identity.session-revoked.v1` and `identity.credential-compromised.v1`, both strict and minimal; credential correlation uses only an environment-keyed HMAC-SHA-256 surrogate.
- Errors: closed stable `IdentityContractError` codes with privacy-safe messages and no existence detail.

Private paths, Domain entities, ORM models, Provider payloads, and database fields are not public contracts.

## Dependencies

- Allowed synchronous dependencies: none in WP-0100.
- Allowed asynchronous dependencies: future public Event/Outbox composition may publish the two declared events.
- Forbidden dependencies: private Module paths、foreign repositories/tables、HTTP/ORM/SDK/Provider types、BOP-to-RMS and UI.
- Failure/degradation behavior: malformed、inactive、revoked、expired、rotated or conflicting state fails closed with a stable code. A stale Actor snapshot never restores a Session.

## Data ownership and lifecycle

- Owned facts: stable Actor identity、Authentication Session lifecycle、browser Session record and
  one-time OIDC authorization transaction.
- Write owner and allowed reads: `@bop/identity` public ports only.
- Tenant / Brand / Store / location scope: deliberately absent. Identity cannot grant business scope.
- Money: not applicable.
- Time / Business Date: canonical UTC millisecond instants only; no Business Date.
- Concurrency / idempotency / audit: positive expected Session version and idempotent revocation intent; later adapters append Audit/Event evidence in their caller-owned transaction.
- Data classification / retention / redaction: Actor/Session references are Internal; verification/compromise facts are Restricted; logs、URLs and analytics prohibit raw values; fixtures are synthetic-only.
- Correction model: rotate/revoke/append a new fact; never rewrite historical Actor references or restore an old Session.

## Persistence and eventing

The `bop_identity` schema owns `authentication_session` and
`oidc_authorization_transaction`. WP-0107 supplies constrained Stage DB-1 storage and an injected
Store port but no production Repository adapter、runtime role、Outbox writer、job or Projection.

## Security and privacy

Provider subject、email、phone、username、Cookie、Token、authorization code、state、nonce、PKCE
verifier、client secret and TOTP seed are not Actor references. Raw browser credentials are
short-lived application inputs only; persistence holds keyed hashes and authenticated ciphertext.
Identity does not evaluate a Permission or Tenant scope.

## Operations

- Configuration: none.
- Health/readiness: no runtime adapter exists in WP-0100.
- Logs/metrics/traces: no raw Actor、Session、credential or Provider values; stable result/error codes only.
- Failure/recovery/disable: current-state resolution rejects revoked/expired state. Recovery and Provider revocation are WP-0107/0108.

## Development and verification

```bash
pnpm identity-session:acceptance
pnpm browser-session:acceptance
pnpm module-manifest:check
pnpm import-boundary:check
pnpm database-ownership:check
pnpm domain-layer-boundary:check
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The focused suite covers Actor/account/method/status combinations、UUIDv7 and UTC canonicalization、MFA facts、policy profiles、version/time/rotation/revocation states、expiry boundaries、events、idempotent synthetic revocation and adversarial unknown/prototype/accessor/secret-bearing inputs.

## Decisions and follow-up

- ADR / IDR references: accepted IDR-0025、Handoff Sections 8、48.3.2、52.6、86.8.4 and 87.6; WP-0100 brief.
- External Evidence: real Cognito/BFF/Session Store/KMS/credential/staging/production evidence is unavailable and unclaimed.
- Revisit triggers: accepted identity/session IDR changes、raw Provider-type need、Redis、new account kinds、social login or altered session/MFA policy.
- Next allowed Work Package: WP-0101 only after WP-0100 completes its full lifecycle.
