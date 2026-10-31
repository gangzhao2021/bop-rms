# Current Option Draft and publication policy assessment

[WP-2421 milestone54](../work-packages/WP-2421.md) composes the
[actual current singleton Draft graph](./current-option-set-draft-graph.md) with
[the current policy assessment](./option-set-content-policy-assessment.md).
Catalog owns content/provenance; Publishing owns policy/governance. API uses
only their accepted public sources and the caller's existing transaction.

## Inputs and authority

Server options capture Tenant, Brand, User Actor, clock and separate current
read/policy field authorities. The request has exactly graphRequest,
policyRequest, originalIntentDigest and activationAt. Graph request pins the
expected current Set/version/revision/three digests and original observation
window; policy request pins Set/policy/version and the same original observation.
No caller graph, assessment, binding or readiness is accepted.

The graph source holds actual current Draft provenance and field authority;
only then does the composition derive the content-policy binding from its
actual full graph/pins. The policy source holds actual current owning policy
and original independent policy governance. Both receive the same outer
transaction identity. No private SQL, write, route, or synthetic production
source is installed by this factory. A trigger edge still refuses until an
actual owning CurrentPublished child producer exists.

## Continuity and output

The original observation and original intent remain immutable. Each clock
sample must be monotonic and within the earliest original/root/policy exclusive
window; proposed activation must satisfy policy/content intervals and be at or
after the actual source observation. A future activation request does not hold
qualification until that future instant: the System scheduler must acquire
current sources and repeat full activation checks then.

The nested policy callback completes inside the held graph callback. Policy
reread runs after tentative work; the outer graph reread runs after policy
completion. Changed own-transaction policy/root content, current authority
refusal, expiry, backward clock, replaced query, recursive admission, callback
failure or invalid completion refuses. Failure poisons this provider/transaction
identity even when a nested rejection is caught. The caller must abort its
outer unit of work; scope providers to one authorized request/UoW.

The frozen minimal result includes the limited Catalog assessment, separate
currentRootEvidence, original observation, effective finite window and canonical
digest. It excludes full graph, names/descriptions, media IDs and witness.
Root evidence is CurrentDraftRootOnly. The existing Catalog sourceAuthority
remains NotEvaluated rather than implying all graph/reference facts are current.
Reference eligibility, Media readiness, Brand field requirements, topology,
independent content approval and sale remain unassessed. All five full seal
checks and twelve Product validation requirements remain mandatory.
Policy governance approval is distinct from Option content approval.

## Evidence limits

Focused unit tests use synthetic public reader and policy-holder protocols,
with the real full parser/rule assessment and composition. The existing fourth
isolated Publishing SQL scenario adds actual owning full Option creation and
separately independently approved policy publication, then combines actual
current sources in one caller transaction. Missing locale/media rules produce
HardError while the observation performs no writes. Late refusal follows
SELECT-observed controlled root mutation and actual owning policy Archive/Audit;
outer rollback restores exact Catalog, Publishing, Audit chain and Outbox rows.

Authority, Actors and referenced business facts are explicitly synthetic;
SQL storage, original history/provenance, held-source barriers and rollback
are actual local execution. Controlled root UPDATE is not owning publication.
This evidence does not establish full Option/Product publication, ordinary
HTTP/browser UI, production IAM, Store activation, UAT or project completion.
