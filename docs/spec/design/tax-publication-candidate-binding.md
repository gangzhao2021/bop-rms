# Tax publication candidate and external material binding

## Scope and authority

This is the WP-2421 implementation interpretation of accepted Handoff 86.8.3,
88.8 and 88.9 and WP-2103. The Owner authorized necessary document requirement
adjustments while completing the project. It defines the missing software
composition; it does not accept a legal rate, professional identity, registration
fact, report or real Store qualification.

The existing Draft protocol and historical bytes remain unchanged. Published
Tax requires registration applicability, qualified professional evidence, complete
coverage and a passing approved Basket/Refund suite. IAM Allow, upload success,
manual mechanical simulation and software approval never supply professional
approval.

## Frozen candidate before professional review

Pricing prepares an immutable publication candidate from an actual saved Draft.
The preparation captures Tenant/Brand/Store, configuration identity, the exact
base Draft version, aggregate version, version number and digest. The server
allocates the target version and new rule identities. Target aggregate version and
version number equal the base values plus one. A source-rule to target-rule join
preserves each rule's actual values and provenance.

The professional review packet exposes that real candidate version and content
digest. External professional reports and the approved suite must identify that
candidate. Preparation is not submission, approval or publication. Missing
professional material leaves the candidate incomplete and Publish blocked.

Draft edits can continue before submission. Submission and publication compare
the current Draft with the captured base. An old candidate cannot silently adopt
new Draft content; its immutable historical receipt remains recoverable.

## Nonrecursive content digest

New candidates use the explicit `TaxPublicationCandidateContentV1` profile and
RFC 8785 SHA-256 content digest. The closed preimage contains:

- profile, Tenant/Brand/Store and configuration identity;
- exact base Draft version, digest, aggregate version and version number;
- target version, aggregate version and version number;
- stable code, `CA-ON`, full Currency Metadata and effective period;
- complete ordered target rules and their source-rule bindings;
- the selected immutable registration material version and content digest.

The preimage excludes its own content digest, the professional report and suite
bodies, qualification decisions, approval/release metadata and the future Publish
timestamp. Each material and qualification decision has its own immutable digest.
These exclusions prevent the professional report's target digest from recursively
hashing itself and permit actual publication time to remain truthful.

Publish loads the same frozen candidate, checks exact material/report/suite
bindings and current validity, and creates a Published snapshot whose
`snapshotDigest` equals the candidate content digest. `createdAt` remains the
actual Publish operation time. A public proof must compare all Published content
with the candidate and bind the actual approval and release; digest equality alone
is insufficient. New versions carry an explicit owning candidate/profile join.
Missing new-profile evidence cannot fall back to a legacy row. Historical Draft
and Published records retain their original interpretation.

## Material and qualification ownership

Pricing owns append-only registration applicability materials, professional
reports, approved fixture manifests, provenance, qualification decisions and their
original-operation recovery. Registration material is scoped to the real Store
and Operating Entity references; professional reports and suites target the frozen
candidate. Material replacement creates a new immutable version.

The normal entry records bounded structured external material. Recorded claims
remain `NotEvaluated`; an entered name or credential does not authenticate a
professional. The server hashes the actual stored structured content. A checksum
supplied for external bytes not acquired by the system is a declared checksum.
The existing Media Image/Video API is not a PDF evidence producer.

Unqualified registration recording binds the current TaxRegistrant's actual
Operating Entity profile, nullable tax registration reference and jurisdiction
code. It records applicability, source time, effective period and declared digest
as operator declarations. A missing registration reference remains null; the
ordinary form does not request an arbitrary UUID or manufacture a Jurisdiction
Profile identity. The qualified evidence contract remains unchanged: recording
`NotApplicable` is not a waiver, and neither a material UUID nor an Operating
Entity profile UUID substitutes for genuine jurisdiction qualification.

This clarifies the new, unreleased material recording contract and its unapplied
owning migration. It does not rewrite deployed material history or accept any
registration or legal conclusion. The API checks the supplied source pins against
the actual held TaxRegistrant source on fresh writes. Original recovery retains
the old exact command and digest without adopting today's source values.

Qualification must retain genuine external issuer, registration and professional
evidence with scope, provenance, review time and expiry. The software must provide
the registration, reading and qualified-source composition rather than leaving
only a load port. Actual external professional facts remain external acceptance.

Suite validation compares every stored expected result with actual owner
calculation, including all component explanations and signed integer totals, and
acquires required coverage from real owning sources. Labels and a supplied digest
cannot establish full coverage. New exemption/zero-rating rules also require a
real owning exception-evidence source.

## Store service-mode preparation before first publication

Accepted WP-2421 implementation interpretation under the Owner-authorized
requirement adjustment: Section 88.7 permits a Store Setup Draft to save service
modes before Tax and Payment references are qualified. Tax coverage preparation
may therefore read the actual saved draft's `Configured enabledServiceModes`.
This is a `NotPublished` preparation basis, not a Published configuration,
live Store capability, approval or professional finding. A missing draft or
`Unconfigured` modes is incomplete; the server must not assume DineIn or Pickup.

The Store owner supplies scope, Setup identity, source revision and the complete
source snapshot digest, alongside the canonical service modes and a separate
semantic digest of scope, Setup identity and those modes. A later unrelated
Tax-reference edit may preserve the semantic basis across requests. A changed
Setup identity or service-mode set invalidates it. Submit, Approve and Publish
must acquire the actual current held source and compare the semantic basis;
retained origin revision/digest is provenance, not permission to skip that read
or proof of the original history by itself. The original immutable revision must
also be authenticated when a persisted qualification consumes its provenance.
The existing Store source's whole-snapshot guard remains unchanged within each
transaction; semantic equality must not excuse same-transaction source mutation.

Store legally represents Delivery, while the current Tax/Ordering contracts
represent only DineIn and Pickup. The Store projection retains Delivery as an
actual configured fact; the Tax coverage consumer must return an explicit
unsupported-mode result rather than filter it out or map it to Pickup. This
interpretation does not supply the complete Catalog classification set, charge
policy, exception evidence, approved suite or professional qualification. Those
owning sources and the eventual Published Store/current Tax joins remain required.

## Complete Catalog recorded inputs before effective coverage

The Catalog owner reads the entire scoped Brand root roster under its source
barrier, with a finite root and packet budget that rejects overflow rather than
truncating the set. Saved Draft preparation classifications remain explicitly
separate from recorded Published classifications. The latter come from the
immutable sealed content and complete publication/retirement graph, never from
today's mutable successor Draft. Missing classifications are reported as
incomplete; an empty recorded set is not an approved suite or professional pass.

`CompleteRecordedInputs` describes that owning input inventory only. The coverage
consumer must still use actual held Store topology and publication scope policy
to resolve effective applicability, and acquire the required fee contexts and
exception evidence. It must not rename the recorded Brand inputs as complete
current Store sellability. The owning source's stable content digest binds the
whole roster, source versions and complete historical graph; observing unchanged
facts again does not alter that digest. Actor authority, the actual observation
and the original short validity lease remain separately enforced. The source
observes after acquiring the barrier, so a legitimate commit during the wait is
not falsely required to predate request admission.

An original Store preparation revision is authenticated through the Store owner
using exact Setup identity, revision and full snapshot digest, joined to its
actual Committed original operation. That read is explicitly historical, with a
fresh read lease; it is not a current Draft or a renewed historical approval.
Current semantic revalidation and original immutable authentication are both
required when qualified evidence consumes this source. Neither grants business
qualification or professional approval.

## Complete delivery and checks

The delivery is normal material registration/selection and candidate preparation,
stored Submit, independent Approve, Publish, current/history reads and original
recovery through actual Session/IAM/FeatureControl and persistence, with rendered
UI. Reuse the public Publishing kernel, Tax calculation and actual Draft authority;
do not read another Domain's private tables. Record Audit and minimal Events
atomically, retain original deadlines and scope, and use expected versions and
payload-free durable recovery.

WP-2421 owns one current plan and check inventory. Candidate or material helpers
alone are implementation progress. Missing real external material blocks Publish
but does not block ordinary Draft authoring or mechanical simulation.

## Store fee-context configuration preparation

WP-2421 implements this missing software composition under the Owner-authorized
requirement adjustment, using Handoff 27.7 and Section 88.7. Store owns the
versioned intent describing which fee contexts this Store needs. Pricing owns
Service Charge rules and calculation; Checkout/Payment owns voluntary transaction
Tip selection; DeliveryFee consumes its real owning external fee result. Store
configuration does not set a rate, quote, transaction tip or legal conclusion.

Use the existing Store Setup ordinary entry, scope, save/original recovery and
append-only revision history. New StoreSetupDraftV2/StoreSetupSaveV2 records add
one closed `feeContexts` configured-value slot. V1 snapshots, original digests
and receipts retain their exact historical interpretation. A fresh V2 content
cannot downgrade to V1 and silently discard fee policy. The three canonical
entries are ServiceCharge, DeliveryFee and Tip, each explicitly Unconfigured,
Disabled or Enabled. Enabled entries select a real registered tax classification
and a nonempty canonical subset of DineIn, Pickup and Delivery. No fee amount or
rate is supplied. Unconfigured is incomplete and never becomes Disabled; Disabled
never means a zero quote. An authorized user makes each selection explicitly.

The actual Catalog classification registry and independent Brand read permissions
must be held for new Enabled selections. Structural parsing does not establish
registration or legal qualification. Recovery of an existing original retains
its exact old receipt rather than applying today's registry.

A Store-owned fee-context preparation read binds the actual immutable Setup
revision and whole snapshot digest, with a semantic digest of the exact scope,
Setup identity and fee contexts. It remains NotPublished/NotEvaluated. V1 without
this field is missing fee policy, not an empty enabled set. Whole-snapshot guards
remain through COMMIT; semantic equality cannot excuse same-transaction mutation.
Delivery remains represented and must be reported unsupported by a consumer that
only supports DineIn/Pickup. Accountant-approved global fixture requirements
remain independent of the Store's enabled fee contexts.

Effective policy must ultimately bind these exact fee-context facts to the actual
Published Store configuration and its independent approval/publication history.
Until that composition exists, V2 cannot materialize through the legacy V1
configuration adapter and silently lose this field. Draft preparation is usable
configuration progress, not effective fee policy or complete Tax coverage.

The ordinary V2 Draft configuration workflow is locally delivered in
[WP-2421](../work-packages/WP-2421.md): the existing Store Setup editor saves and
refreshes explicit contexts, rejects withdrawn classifications, and recovers
immutable originals. Actual Session/IAM/Catalog/PostgreSQL and controlled rendered
browser evidence are recorded there. This does not establish an effective
Published fee policy; the independent approval/publication binding remains open.

The selected effective-policy implementation reuses StoreConfigurationVersion,
its full authoring/review/publication JSON and existing Store-scoped lifecycle.
Old configurations retain their exact 32-key interpretation. A new optional
closed `setupBasis` extension carries profile StoreSetupConfigurationBasisV2,
Tenant, immutable Setup identity/revision/full snapshot digest and the three
complete fee-context selections. It enters the same whole-configuration review
and publication digest; no separate fee approval or fee default is introduced.
New V2 materialization computes the Setup digest from the actual parsed source.
The legacy materializer continues refusing V2 input.

Published content must verify the genuine same-Tenant/Brand/Store immutable Setup
revision and its Committed original against the basis and all fee selections;
an embedded declaration is insufficient. Existing full JSON is authoritative
for these content facts, as it is for schedule/exception content. The selected
implementation adds a Store-owned INSERT coherence guard without creating a fee
table or relational rate column. Consumers retain explicit missing-policy
behavior for legacy configurations. This is an implementation selection; actual
Submit, independent approval, publication and current/history/recovery evidence
remain required before effective-policy delivery.

For V2, a real Submit freezes a StoreConfigurationContentV2 semantic preimage.
It retains configuration identity, author, creation time, all business fields
and Setup basis, and excludes only lifecycle, approvedByReference,
approvalEvidenceReference, publicationReference, liveGateEvidenceReference and
updatedAt. These six fields do not yet exist as actual approval/publication facts
at Submit. V1 retains its original complete-configuration digest. V2 approval,
release and current reads must separately verify the excluded metadata against
actual Publishing and Live Gate records; semantic equality does not authorize
metadata substitution or renew historic validation evidence.

The selected V2 Publishing lifecycle identity reuses the server-allocated complete
configuration identity and must actually be created by the public Publishing
Command at Submit. Approve must consume that recorded Submit and a genuinely
independent Actor, never construct a substitute Submit. Published independent
provenance requires a Publishing-owned release-linked historical read: the
existing current independent approval reader accepts only an Approved head, so
it cannot be treated as proof after Publish. That remaining public contract is
a repository dependency, not an external evidence gate.

The ordinary V2 command intent contains authenticated Tenant/Brand/Store/Actor,
a stable operation reference and the exact expected complete-configuration head.
The head binds configuration identity/version and the canonical full state digest,
including lifecycle metadata; it is distinct from the semantic Publishing digest.
Materialize additionally pins the saved Setup identity/revision/full snapshot
digest and a reason. The server obtains the actual held Setup source and allocates
new configuration identity and timestamps only on fresh execution. Browser input
never supplies approval, release or qualification facts.

Keep the existing five-action authoring history and its original fixed JSON intent
hash unchanged. New ordinary recovery uses a distinct append-only original
terminal source because an Abandoned request is not a configuration state or a
new latest revision. Record the actual successful authoring operation and original
input in the same transaction as its Audit and terminal receipt. Preserve both the
ordinary command digest and the original authoring digest; do not reconstruct the
original input from server-prepared output metadata. Resolve pins the original
Actor, scope, action, operation and intent without sending business payload.
An absent lookup is unresolved; only a committed, audited Abandoned terminal
prevents a late writer. Fresh authority and identifiers run after original
arbitration and exact current-head CAS. Existing original recovery does not
renew today's eligibility or execute a replacement submission.
