# Owning Option publication policy source

WP-2421 milestone50 implements the policy source required by accepted Handoff
Sections71.4–71.5 and88. It follows the current immutable Publishing workflow
without qualifying an Option version or inventing an external fact. See the
[spec authority](../README.md), [work package](../work-packages/WP-2421.md),
[internal Option seal](./option-set-content-seal-writer.md), and
[current Product source composition](./product-publication-policy-source.md).

## Repository software decision

`PublishingOptionSetPublicationPolicyV1` and `OPTION_SET_PUBLICATION_POLICY`
are a distinct typed public contract and configuration/purpose pair. The first
repository policy grammar uses the accepted six scope levels Store, StoreGroup,
Region, Brand, Channel and OrderType; each appears exactly once and Store must
precede Brand. Policy content also specifies whether Option content requires
approval, whether warnings may be overridden, canonical required locales,
optional/required media, and an inclusive start/exclusive end in UTC. It cannot
disable hard errors or replace topology/reference/rule checks. Empty required
locale lists do not waive applicable Brand locale or full content requirements.
No default policy is activated by defining this grammar.

The grammar mirrors the Product policy requirements but has an independent
parser/type/profile/digest. Both public service and owning store reject a Product
body in an Option registration and vice versa, mixed bodies, unexpected fields,
accessors, wrong Brand/family/reference/digest and body registration on a later
workflow operation. JSON bodies are detached and frozen, arrays are canonical
and bounded. Full policy bodies are internal confidential governance content.

## Append-only workflow and recovery

The ordinary authorized `executePublishingMutation` entry forwards the typed
Create body through the existing current permission and Audit checks. The
internal owning store still requires callers to authorize each request and
bind its transaction runner to their outer unit of work; direct store access
is not authentication or current field permission. No HTTP route is enabled
by this milestone.

Registration binds Tenant/Brand, policy family, policy reference, sequential
positive policy version and exact content fingerprint to the immutable Create
record. Existing family/operation locks and the new typed reference lock protect
Option registration. A currently visible conflicting Create record of another
profile for the same reference/family refuses Option registration. Product
registration rules remain unchanged; this is not a new global cross-profile ID
uniqueness contract. Original operation replay returns its original Audit
receipt without writing a second record; changed intent refuses. Reusing an
original registered body for an explicit rollback requires its original digest
and a new eligible lifecycle/review/approval/release sequence.

The policy governance itself requires a different approving User from its
original submitting User. This applies even when the policy says Option
content approval is NotRequired: policy governance and Option content approval
are separate facts. Original validation/approval evidence is retained and
matched by the existing publication write checks. Policy writes remain
append-only with current family head and expected lifecycle version checks,
Audit in the same transaction, and whole transaction refusal on any failure.
No new schema, migration, ACL, Event or schedule path is introduced.

## Current source and source barrier

`resolveCurrentOptionSetPublicationPolicy` accepts only an exact policy
reference/version/observation tuple. It requires Brand scope and READ COMMITTED,
sets Tenant/Brand with no Store context, and holds the owning mutation table
SHARE lock through the caller transaction. It reads actual immutable typed
Create content and verifies the original stored intent hash. A supplied client
body or requested reference alone is not current authority.

The public current release query must return the actual current Published
head for the same family/configuration/purpose and original snapshot/digest.
The policy period must contain the observation. Original SubmitReview and
Approve records and their intent hashes must match the actual release evidence
and independent actors. Governance evidence must have been valid when the
release was created; it is never renewed. Its historical expiry alone does not
archive a current configuration. Policy effective expiry, current head change,
archive, malformed/missing content, wrong scope, or nonmatching provenance
refuses with the existing bounded PUBLISHING_INPUT_INVALID result.

A source observation opened in an independent completed transaction cannot
supply a held barrier to dependent work. The next API composition milestone
must bind this reader to the same caller transaction, require current fields
and Actor permission, cap the original observation lease by policy expiry, and
recheck before dependent commit.

## Evidence boundary and remaining work

Focused contract/service tests and isolated actual PostgreSQL exercise owning
immutable content, current heads, original replay, policy version/collision
refusal, independent same-user refusal, replacement, rollback, archive/expiry,
and held source/outer rollback. Test Actor/permission/validation assertions
are controlled synthetic inputs; the SQL history and locks are actual local
execution. This does not constitute UAT, production activation or real IAM.

Internal Frozen Option content remains NotEvaluated. Current Option content
validation/reference/topology/rule satisfiability, policy composition, independent
approval of the Option content where required, exact scope/period release
qualification and Publishing linkage remain implementation work. Product
normal editable publication pages, partial overlap disposition and Store
capability management remain tracked by WP-2421.

## Same caller transaction policy composition (milestone51)

The API composition root now provides
`createCurrentOptionSetPublicationPolicySource`. Its server configuration
captures Tenant, Brand, User/System Actor, authority methods and clock. Each
request supplies only Option Set reference, policy reference/version and
original observation. Client contents, Ready status, approval or extended lease
are rejected. The API performs no foreign private-table query.

Before work, a required current authority holds catalog.manage,
catalog.option_set.publish, CATALOG_OPTION_SET_PUBLICATION and all seven
policy field paths through the caller transaction. It returns an exact finite
observation/deadline. This authority has no production default: unavailable
current identity/permission/fields must refuse. The Set selector is an
authorization target; this policy reader does not assert that a real Set exists
or that its contents are currently eligible.

The actual owning Publishing public reader runs on a captured query method in
the same transaction. Its READ COMMITTED/source SHARE fence remains held by
that transaction. The composition verifies the detached typed policy, actual
Published release/lifecycle, original evidence pins and current observation;
the owning reader remains responsible for original independent provenance.
Catalog and Publishing branded references/instants are compared only after
each Domain has strictly parsed them.

The request's original 30-second maximum is exclusive and never renewed. The
effective deadline is the earliest original cap, authority deadline and policy
end. Every sample is monotonic; permission/source latency cannot hide expiry or
backward time. The callback receives a frozen policy with a current publication
reference, actual source observedAt, original request originalObservedAt and
exact finite window, plus publishValidation Incomplete and
eligibility NotEvaluated. It never receives complete Option qualification.

After the one permitted callback, the provider holds current authority again
and rereads the actual owning source. A head or original evidence/content
change, field/permission denial, expiry, changed query method or shorter
deadline refuses. A SHARE lock prevents other transactions from writing but
cannot substitute for this check against changes made by the caller itself.
A failure poisons subsequent admission and the enclosing hold for that
transaction object, including a caught recursive failure.

Use a provider and transaction facade scoped to the authorized request/unit of
work. A pooled physical pg Client reused for a new BEGIN is not a new
transaction identity; do not reuse a poisoned facade to admit a fresh request.
The test fixture creates a new request provider for each independent BEGIN.
The caller must still let refusal abort its outer unit of work; this provider
does not own COMMIT/ROLLBACK or revoke permissions itself. All other current
full Option source checks remain mandatory through that outer commit.

Unit tests use an explicitly synthetic public owner result and authority. The
existing isolated SQL scenario uses actual immutable Option policy and
Publishing governance, actual held source locks and tentative owning Archive
writes followed by outer rollback. Actor/field/Option selector controls remain
synthetic; no production permission provider, scheduler, normal HTTP endpoint,
UI, UAT or actual Store activation is established.
