# Initial Brand administration

## Authority and delivery

This WP-2421 implementation interpretation follows Handoff 50.7, 87 and
88.7, the Tenant-owned Brand lifecycle, and the Owner's delegated software
design clarification in [project delivery inputs](project-delivery-decision-inputs.md).
Brand is the primary Tenant boundary; there is no additional Tenant root to
create. The existing Brand list and Detail routes remain canonical.

The usable first-Brand workflow includes approved initial provisioning,
discovery and deliberate selection of the actual Draft Brand, configuration
and genuine reference selection, independent review/publication where required,
activation, current reads and original-operation recovery. Platform Template
management is an already verified prerequisite. A context or passing owner
suite alone does not complete first setup.

## Administrative context

Tenant owns a separate `BrandAdministrationContextV1` contract. It records the
actual Workforce User Actor, the actual Brand identity and lifecycle, no Store,
fixed `BRAND_ADMINISTRATION` purpose and the server observation. It does not
share the operational `TenantContext` discriminator or grant access by itself.
The actual Identity, Membership and Permission owners must admit every request.

Administrative reads may represent Draft, Active, Suspended or Archived Brands
so the registered list, history and original recovery remain possible. Commands
continue to enforce their own lifecycle and version rules. Operational
`TenantContext` and Store/commerce entry still require an Active Brand.

The initial administrative permission entry admits only `organization.manage`
and the existing Brand configuration Draft, SubmitReview, Approve, Publish and
Archive actions. It uses genuine current Membership and persisted policy facts,
including Deny precedence and finite validity. It grants no Store operation,
new Brand creation, IAM administration or automatic Owner role. Future owning
actions need their own scoped implementation.

Readers keep the original transaction, actual Brand/Actor, RLS scope, locks,
observation deadline and final checks. No adapter may copy a Draft Brand into
an Active-shaped packet. Immutable history and an original receipt remain
different from permission to perform a new command.

## Phase 1A administrative admission

Handoff 88.7 and the `ORG-BRAND-LIST` / `ORG-BRAND-DETAIL` registry entries
make ordinary Brand administration available in Phase 1A. They do not require
each newly created Brand to publish a Feature override before its administrators
can manage it. Requiring that override creates a circular setup dependency:
the first Brand is Draft, while the current Feature mutation path requires an
Active operational context.

For the registered `organization.org_brand_list` and
`organization.org_brand_detail` administrative capabilities only,
a successful owning Feature read that holds an empty definition set permits the
Phase 1A baseline. This is administrative admission, not an `Enabled` verdict or
a fabricated `Published` definition. Current Workforce Session, same-Session MFA,
Membership and Brand permission remain mandatory. The same rule applies to the
actual lifecycles admitted by the administrative context so activation does not
remove access to the management entry. Each command still enforces its owning
lifecycle and action rules.

Any existing definition continues through the actual Feature evaluator. Explicit
Disabled hides navigation and refuses commands; unpublished, expired,
contradictory or dependency-unknown configuration and failed reads cannot use the
empty-set baseline. The original source set and current authority are held and
revalidated through commit. This interpretation does not change operational
Store/commerce admission, later phases or other capability keys.

## Catalogue identity during first setup

Handoff 88.7 includes the Brand's catalog-source identity and configuration in
the Owner/Brand Admin workspace. Registering this immutable identity is part of
Brand setup. The fixed administrative Catalog registry therefore accepts a real
Draft or Active Brand and current `organization.manage`; its reads and original
recovery retain current administrative authority. It uses the same Catalog-owned
identity, Audit and original-operation persistence as the existing registry.

This administrative constructor exposes only that metadata workflow. Product,
SKU and other catalogue editing continue to require their existing operational
scope and permissions. The original operational registry still requires
`catalog.manage`. Initial provisioning retains its six-action allowlist and
never adds that broad grant automatically. No source identity or successful
registration is invented when a current source is absent.

## Creation and activation boundaries

The first Brand does not yet have Membership or Brand-scoped permission.
`organization.manage` on another Brand and Platform Template management do not
authorize creating a new Tenant boundary. Initial provisioning must have an
explicit, independently approved authority and compose Tenant, Membership and
Permission public writers in one transaction. The browser cannot grant itself
that authority. The transaction composition and initial writers now have local
database evidence recorded in WP-2421. The authenticated composition now uses
actual signed relationship files and the concrete persistent Workforce account
binding/current Provider source. Local PostgreSQL evidence includes the actual
independently approved binding importer and approved local executable entry.
The ordinary local startup composition is described below. New Owner onboarding,
Theme composition, complete first setup and production deployment remain unfinished.

Existing ActivateBrand rules enforce lifecycle, expected version and time.
Neither a Published configuration nor Theme is presently an owning activation
precondition. This change adds no such business gate. Missing configuration,
Theme selection and new Owner onboarding remain explicit unfinished setup work;
activation alone cannot mark first setup complete.

## Ordinary local startup

The explicit InternalTest entry is
[`brand-administration-runtime.mjs`](../../../tooling/environment/brand-administration-runtime.mjs).
It loads an existing private installation and the built Merchant application,
then serves the canonical Brand list/detail and authenticated administration API
on one loopback HTTPS origin. It starts without a selected Brand or Store.
Accounts, accepted invitations, current Memberships and permissions must already
exist; the entry creates none of these and does not invoke a pilot seed profile.

The canonical absolute installation directory must belong to the process user
with mode `0700`. Every referenced file must be a distinct, stable, nonlinked
regular file owned by that user with mode `0600`, at most 64 KiB. Retain the
existing `installation.json`, `api-password` and Workforce credential keys across
restarts. The API role must already have the required minimum owner permissions.
The `brand-administration.json` has these required fields and one optional
onboarding configuration:

- `schemaVersion: 1`, `environment: "InternalTest"`, and the existing `database`.
- `exactOrigin`: `https://127.0.0.1:4443` or the chosen matching loopback host/port,
  without a path or trailing slash.
- `workforce`: `environment`, `issuer`, `clientId`, `managedLoginOrigin`,
  `clientSecretFile`, and `credentialsFile`. The environment/issuer/client must
  match the existing immutable account bindings. The managed login origin has
  no path or trailing slash; file values are basenames in this private directory.
- `tls`: `keyFile` and `certificateFile`, also distinct private basenames.
  Supply an existing matching key and current non-CA server certificate whose
  SAN covers the configured host. Startup never generates or installs a certificate.
- Optional `onboarding`: `environmentReference`, `acceptanceRoleName`, and
  `files` containing `planPath`, `approvalPath`, `approvalTrustPath`,
  `relationshipPath`, and `relationshipTrustPath`. Every path is a distinct
  basename in the same private directory, separate from credentials and TLS
  files. The environment reference must be a UUIDv7; the acceptance role must
  already exist with the owning permissions. These files contain the complete
  approved onboarding plan and independently signed approval/relationship
  material. Their owners read and verify them at acceptance, including current
  withdrawal; startup creates no approval or invitation. Omission leaves
  invitation acceptance explicitly unavailable, while ordinary sign-in remains
  configured as before. Explicit malformed configuration refuses startup.
  Invitation acceptance uses the unselected Brand directory; after activation
  the user deliberately selects an authorized Brand. A server configuration
  combining onboarding with a fixed preselected `brandReference` is refused.

The existing Provider client must permit the exact configured origin plus
`/merchant/organization/brands/callback` as callback and
`/app/organization/brands` as logout return. The browser must trust the supplied
certificate. The existing credential-file format is implemented by
[`pilot-credentials.mjs`](../../../tooling/environment/pilot-credentials.mjs);
this entry only reads its retained keys, without provisioning or rotating them.

With pinned dependencies and workspace dependencies already built, build the API
and Merchant application using their existing build scripts, setting
`VITE_BOP_LOCAL_DEMO=0` for the Merchant build. From the repository root, launch
the existing process entry with explicit absolute paths, for example:

```sh
NODE_ENV=development PORT=4443 \
BOP_BRAND_ADMINISTRATION_DIRECTORY=/absolute/private/installation \
pnpm exec node apps/api/dist/server.js \
  --configuration /absolute/checkout/tooling/environment/brand-administration-runtime.mjs
```

Open the configured origin. Anonymous users receive the ordinary secure-sign-in
entry; successful Workforce authentication starts without a Brand selection.
The user deliberately chooses an actual authorized Brand before opening its
configuration/lifecycle workspace. `/ready` verifies database connectivity only;
it does not certify current user permissions or business readiness. Shutdown and
failed listen close the owned server and database pool; a restart uses the same
stored keys and revalidates the existing Session and current authority.
The optional onboarding configuration connects the invitation-acceptance runtime
under development; its complete callback/native/rendered verification is tracked
in WP-2421. Invitation issuance/delivery, first Owner seed closure, cloud production
deployment and Theme ownership remain unfinished software work.

## Approved initialization implementation

The controlled deployment path uses a closed, signed initialization approval;
it is not a reusable browser bootstrap endpoint. Permission owns verification
of that approval with Node's Ed25519 implementation and explicitly configured
public keys bound to a named approver, environment and this purpose. No default
key or production approval is shipped. The signature binds operation, target
Brand, exact complete initialization-plan digest, actual executing operator,
independent approver, evidence reference and finite business validity. Current
trust and approval withdrawal are rechecked within the original request lease.
Signature validity proves the configured approver signed the plan, not the
truth of legal, employment, identity or production observations.

The orchestration must hold actual current operator and target Workforce
identities, real relationship qualification and approved plan through commit.
First production Owner invitation, TOTP, reviewed deployment and permanent
seed-path closure remain governed by Handoff 87.6; this path cannot fabricate
an Actor, invitation or relationship. Existing identities can be admitted only
through their actual owners. Initial roles contain only the explicitly approved
subset of the six administrative actions; no Store assignment is created.

Tenant's existing CreateBrand writer remains the Brand owner. Membership and
Permission receive initialize-only public writers borrowing the same outer
transaction. They create absent-to-version-1 facts, reject existing roots or
Actor/Brand membership, preserve exact scope and append actual Audit in that
transaction. They do not implement independent replay or repair an existing
policy. The final controlled provisioner must own one immutable full-operation
receipt and resolve it before these writers; a replay must never regrant a
revoked membership or policy. Receipt persistence and actual orchestration are
required before exposing creation. Initial owner writers and a signature
verifier alone do not complete this workflow.

## Existing Workforce identity qualification

For this initialize-only path, targets must already have completed actual
invitation onboarding. `invitationEvidenceReference` identifies Identity's
`invitation_id`, not a new approval or a caller-supplied qualification verdict.
Its owning source must verify the same Actor, Accepted state, actual Provider
acceptance evidence and consumption within that invitation's original window.
The original Membership binding stays immutable; historical invitation evidence
does not authorize or become bound to the new Brand's Membership. An accepted
invitation's elapsed delivery window alone does not undo the historical
acceptance. Current identity status and the new Brand's relationship qualification
must still be held independently of that historical evidence.

This is the narrow existing-identity interpretation of Handoff 87.6 and
WP-0108's original Actor/Membership invitation binding. The new Brand authority
comes from the independently approved exact plan and current relationship
sources. The owning historical invitation and signed relationship file readers
and the persistent current Workforce account producer are locally verified.
Concrete ordinary Workforce authentication now has native first-created Draft Brand
acceptance with actual persisted owners and explicitly controlled Provider transport.
Approved local executable creation also has actual PostgreSQL evidence. A new Actor or first production Owner instead needs the separately
governed approved pending
Membership, invitation acceptance, TOTP and activation sequence; this path cannot
replace it with an initially Active Membership.

## Concrete authenticated composition

The authenticated initializer now creates and retains Identity's actual Platform
Session, directory and Cognito status holders on the same transaction as the
Brand writers. The encrypted Session's same-Session TOTP proof supplies the
actual operator's RecentMfa state. The owning invitation reader selects only
the bound Actor's accepted invitation evidence; it does not read email or
credential selectors. Both sources register current reads and final guards,
preserve the original bounded deadline and reuse holders during later checks.

Trusted deployment configuration supplies the fixed Workforce issuer/client
scope, protected crypto ports and private paths for separately trusted relationship
statements. The composition instantiates the owning persistent account reader,
original invitation reader and signed relationship reader; it accepts no injected
account or relationship verdict. Each source binds its actual recipient and
retains current authority through commit.

Local native evidence uses real persisted Session, directory, approved Workforce
binding and invitation owners plus actual signed approval/relationship files.
Two concurrent binding importers return the same original receipt with one
binding, Audit record and encryption. Provider/TOTP origin and independently
approved mapping/relationship issuer facts remain controlled synthetic boundaries.
This does not establish real onboarding or complete ordinary first setup.

## Local approved creation entry

The accepted local InternalTest phase has a concrete command in
[`brand-initial-provisioning.mjs`](../../../tooling/environment/brand-initial-provisioning.mjs).
It uses the existing approved initializer and PostgreSQL connection resource;
the command does not require an already-created Brand or Store. Its unit and
native verification status is recorded once in WP-2421. This entry is separate
from normal server startup and first/new Owner onboarding.

Use the repository's pinned Node and pnpm with a valid frozen installation.
Build the API when its compiled output is absent or stale, then run from the
repository root:

```sh
pnpm --filter @bop-rms/api build
NODE_ENV=development pnpm exec node \
  --import ./tooling/environment/register-workspace-typescript.mjs \
  ./tooling/environment/brand-initial-provisioning.mjs \
  --directory /absolute/private/installation
```

The path is a placeholder for the owner's existing canonical, owner-only 0700
installation directory. Its `installation.json` selects the actual local test
database and API role; `api-password` holds that role's existing private
credential. No database, role, key, account or Session is provisioned by this
command. `NODE_ENV=production` and non-InternalTest installations are refused.

The fixed `brand-initial-provisioning.json` is a closed record containing:

- `schemaVersion: 1`, `environment: "InternalTest"`, and `database` matching
  `installation.json`.
- `operator`: the approved Platform issuer/client/callback configuration,
  `credentialsFile`, and `cookieFile`. The callback is `/platform/auth/callback`
  and the sole post-login path is `/platform/tenants`.
- `workforce`: the actual issuer/client configuration, a separate
  `credentialsFile`, and `relationships` with `trustPath` plus one
  `{ actorReference, qualificationPath }` per exact plan recipient.
- `approvalFiles` with `approvalPath` and `trustPath`, plus `planFile` for the
  complete independently approved owning plan.

Every file reference is a distinct basename in the same directory, never a
relative traversal, subdirectory or external absolute path. Files opened by
the entry must be owner-only 0600 regular files, at most 64 KiB, with neither
symbolic nor hard links. `cookieFile` contains only the existing raw Platform
Session credential, without a cookie header or trailing newline. Credentials
use the existing local credential loader's explicit file format; Platform and
Workforce keys are supplied independently and are never generated or rotated
by startup. Secret values belong in these private files, never command arguments.

Membership opens signed relationship/trust files only when fresh target
qualification is required, applying its own private-file and signature rules.
An exact original retry can therefore return the persisted operation after a
relationship file is removed, without recreating ended Membership or revoked
grants. This preserves owner recovery semantics; fresh creation still requires
current relationship qualification.

Success writes only `{"environment":"InternalTest","status":"Applied"}` or
the corresponding `AlreadyApplied` status. Failure writes the fixed
`INTERNAL_BRAND_INITIAL_PROVISIONING_UNAVAILABLE` code and exits nonzero, with no
identifiers, credentials or raw errors. The database pool closes on success,
refusal and startup failure. Current production Secrets Manager/KMS, real
onboarding and externally approved release evidence remain separate gates.

## Target account and relationship evidence

An initialization recipient needs a current active Workforce account, not an
invented login. Identity's narrow `CurrentWorkforceAccountV1` describes that
account and its bounded observation, without authentication or MFA timestamps.
The executing operator still requires the actual authenticated Session and
RecentMfa. Only the initial administrative writers consume this account fact;
normal authenticated commands keep their existing IdentityActor contract.
Invitation consumption or account creation times cannot stand in for OIDC
`authenticatedAt`. The concrete account reader verifies the persisted Workforce subject binding,
original invitation and current Provider status to produce this fact. Ordinary
OIDC must separately supply real authentication and same-Session MFA evidence.

Under Handoff 42.7/48.3.5 and WP-0102, Membership may consume an external signed
qualification statement as the machine-verifiable carrier of separately verified
workforce relationship evidence. It binds the named Actor and new Brand, opaque
relationship/evidence references, an explicitly trusted issuer, revision and
business validity. A fixed private deployment file and separately configured
Ed25519 trust file provide the initial concrete transport; current status and
trust withdrawal are reread through the original commit deadline. No HR details,
employee classification or role grants belong in this statement. Its issuer is
not automatically the initialization-plan approver. Verifying its signature does
not make BOP the authority for legal or employment findings.

## Persistent Workforce account binding

Identity owns one immutable binding between an existing Workforce Actor and an
explicitly approved Cognito issuer/subject. The controlled importer binds the
original accepted invitation, original Membership and Provider evidence, plus
independent Actor-to-subject approval and the actual Platform operator's Audit.
It encrypts the subject with bound context and persists only a keyed lookup hash
outside the encrypted payload. The mapping carries no Brand or Store grants.
An approved relationship statement does not authorize importing an identity link.

The importer is create-only with exact original-operation recovery; it cannot
reassign an existing Actor or subject. Account reads require the original
invitation tuple to remain accepted and the real Provider account to remain
enabled and confirmed. They return bounded account facts without login or MFA
timestamps. Concrete ordinary Workforce OIDC/logout now uses the owning account
source and actual encrypted Session with same-Session MFA. Executable first setup and first Owner enrollment remain separate required work. This scope adds no new local
account suspension or generic staff administration workflow.

## Verification

Verify administrative positive and denial paths alongside unchanged operational
consumers, then actual minimum-role PostgreSQL, authenticated HTTP and rendered
list/Detail flows. Use the owning WP's single check inventory. Real account,
provisioning approval and production observations require their actual evidence;
synthetic local proofs do not supply them.
