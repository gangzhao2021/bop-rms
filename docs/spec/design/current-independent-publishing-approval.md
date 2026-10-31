# Current recorded independent approval source

[WP-2421 milestone56](../work-packages/WP-2421.md) adds the owning Publishing
query `resolveCurrentIndependentApproval`. It is a prerequisite for later full
Option content approval composition. It proves the recorded review/approval
relationship; it does not qualify the current Option graph or grant publication.
The independent submitter/approver rule follows the existing
[Option publication policy governance](./option-set-publication-policy-source.md).
Generic existing mutation behavior remains compatible. Policy governance approval
and Option content approval are distinct records and cannot substitute for one another.

## Expected pins and owning provenance

The closed request contains expected family, lifecycle, configuration type,
purpose, snapshot reference/digest, required check codes and a server-sampled
observation instant. It accepts no approval, Pass, Ready or caller source body.
Canonical UUIDv7/digest/code/instant checks and descriptor-safe closed objects
and bounded dense arrays refuse getters, duplicates, unknown fields and empty or
more than32 check codes before opening a transaction. Codes are detached/sorted.
Only the authorized server composition chooses the required set; the client
cannot weaken that choice by asking for fewer checks.

The captured owner Tenant and Brand/Store scope constrain every SQL read. The
existing current approval reader acquires the Publishing SHARE source lock,
retained through the caller's transaction, and requires the latest lifecycle
head to remain Approved. Published, Archived, later Draft, missing or foreign
heads never fall back to an older approval.

The new query retrieves exactly three adjacent original records: the preceding
CreateDraft, SubmitReview and Approve. It checks each normalized original intent
hash and the owning row's Audit ID column, exact versions and transition rules,
current-record links, family/snapshot/purpose/scope, User audit action/target/
classification, evidence equality and timestamp ordering. Submitter and approver
must be different User references. An edited preceding Draft is permitted only
as the actual owning recorded version immediately before the review; this query
does not reconstruct or certify unrelated earlier authoring history.

The original validation and approval must bind that exact snapshot. The recorded
validation code set must equal the complete server-selected expected set, not
merely contain one matching code. Both original evidence windows remain effective
at observation, exclusive at their endpoints. The result expires at the earlier
validation/approval deadline; reading it never renews an original evidence window.
Recorded Pass/code metadata is not a new execution of those checks.

## Minimal proof and remaining current checks

The detached frozen result binds Tenant/scope, lifecycle/family/configuration/
purpose, snapshot, exact Draft/review/approval operation IDs, review/approval
versions, minimal submitter/approver references and evidence IDs/code set. It
includes the source fingerprint, trusted observation and earliest validUntil.
`recordedIndependence` is Verified; `currentValidation`, `referenceEligibility`
and `eligibility` remain NotEvaluated. No Audit payload, prose, Media/reference
graph, price amounts or user detail is emitted by this internal source.

This read capability does not authorize the caller. The server must hold current
Actor, purpose and every field permission, bind the exact current full content/
configuration and actual current policy/topology/reference evidence, and repeat
this owning query after tentative work before COMMIT. A source lock prevents
other transaction writes; it cannot prevent the caller's own head advancement.
The caller must abort its outer UoW on any refusal. The query alone has no captured
clock, callback deadline enforcement, live IAM or complete validation holder;
those belong to the subsequent server composition. It does not satisfy the
[full Option seal](./option-set-content-seal-writer.md)'s five checks automatically.
Actual activation must reacquire current sources and permissions.

## Verification boundary

Focused tests use a synthetic SQL transport with canonical owning records,
including recomputed intent hashes for deliberately malformed history. The
existing first isolated Publishing SQL scenario gains a separate Brand lifecycle
created/reviewed/approved through the actual owning writer. It verifies exact
independent provenance, no-write preservation, self-approval denial by the stronger
query, foreign scopes, wrong pins/codes, corrupted transport hashes and exclusive
evidence deadlines. Old generic same-Actor writes/reads retain their established
behavior. Controlled owning Publish in the same outer transaction advances the
head and Audit; a repeat query refuses and outer rollback restores exact Publishing,
Audit record and Audit-chain state. Old scenario assertions remain intact.

SQL, original history, source lock, owning mutations/Audit and rollback execute
locally. Actor references, authority and validation Pass/business snapshot facts
are synthetic. This is not actual qualified Option content approval, a complete
reference/current Published resolver, normal HTTP/browser UI, System activation,
production IAM/UAT, formal release or project completion. No DDL, ACL, Event,
module dependency, normal route or existing mutation rule changes.
