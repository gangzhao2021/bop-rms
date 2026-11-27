# Option full-content policy assessment

WP-2421 milestone52 supplements the accepted Section71.4–71.5 full Option
content rules with a bounded candidate assessment. It uses the existing full
Catalog parser and mechanical graph solver, and the independent owning
[Option publication policy](./option-set-publication-policy-source.md).
[WP-2421](../work-packages/WP-2421.md) records scope, failures and verification.

## Repository software decisions

DEC-WP2421-OPTION-CONTENT-01 defines the following complete-content checks for
every supplied graph node, including nodes absent from a successful witness:

- Policy-required locales must have Set names and names for every retained
  Option, including Inactive and Archived Options. Optional descriptions remain
  optional; this step does not establish Brand-supported locale/field requirements.
- Required Media applies to every non-Archived Option, including Inactive
  Options. Existing Media requires alt text in every policy-required locale,
  even under Optional Media policy. Presence, pinned IDs and alt text do not
  certify Media readiness, ownership, rendition, legal rights or availability.
- Each node's content period and the policy must include the proposed activation
  instant. Starts are inclusive; ends are exclusive. UTC instants come from the
  existing IANA-zone/offset-aware effective-period parser. This is an instant
  assessment, not a whole-interval applicability or topology proof.
- The complete exact triggered graph must be mechanically satisfiable under the
  existing solver. Missing exact child, ambiguous version, complexity limit or
  exhausted bounded search remains Indeterminate. Known unsatisfiability and
  content conflicts are HardError. Warning override never promotes either result.

Archived Set candidates are refused by the existing full-content parser.
A policy with NotRequired content approval does not create approval evidence.
No descriptions, operational facts, asset facts or implicit defaults are invented.
These are reviewable repository rules owned by Catalog; Publishing owns the
policy and its independent governance. No additional real business fact is inferred.

## Identity and limited result

The public Catalog binding is closed and pins Tenant, Brand, root Set/version,
expected aggregate revision, source/content/configuration/full graph digests,
original intent, original observation, finite exclusive window and proposed
activation instant. Revisions are positive int32; windows are at most30 seconds;
activation cannot precede observation. Every graph node is detached and parsed,
with existing graph/search limits; future content metadata and identity drift
refuse. Policy must currently apply to the scoped Tenant/Brand, and the window
cannot extend past its end.

The minimal assessment includes bounded check codes, graph/root and policy pins,
mechanical status/reason/search count, original intent/window and a canonical
assessment digest. It includes no names, descriptions, Media IDs, full reference
graph or selected witness. PassForAssessedRules is only a candidate rule result.
Source authority, Brand fields, reference eligibility, Media readiness, scope
topology, independent approval and sale remain NotEvaluated; publishValidation
remains Incomplete. HardError takes precedence when another check is Indeterminate.

## Same-transaction current-policy composition

The API creates the actual milestone51 provider directly from captured server
Tenant/Brand/Actor/clock and current field authority. It offers no injectable
client policy or readiness port. It acquires the public owning policy in the
same caller transaction, checks exact Set/policy/version/request/response pins,
and uses the earliest candidate and owning policy lease. The original observation
cap is never renewed; actual policy observation is recorded separately.

Graph and binding are detached before acquisition. One callback is allowed;
monotonic clock, exclusive expiry, captured query and poisoned transaction checks
apply before and after callback and after owning final source verification.
Recursive failure poisons the outer hold even if caught. Work errors and current
policy/authority final refusal must abort the caller's outer unit of work.
Catalog assessment digest covers its limited result; API currentAssessmentDigest
additionally pins that digest, original observation and actual policy publication
reference. Neither digest is a validation or approval record.

The supplied graph is still a candidate. Actual owning current Draft/frozen graph,
Media/Pricing/Inventory/Recipe references, Brand field requirements, exact
scope/topology, independent content approval, seal admission and Publishing
release linkage remain required software work. Scheduled activation must acquire
and validate all current sources and permissions again at actual activation;
a prospective assessment cannot authorize a future System operation.

## Evidence boundary

Catalog unit cases exercise full candidate rules and negative pins. API tests
explicitly use a synthetic holder protocol to exercise composition failures.
Milestone51 actual local isolated SQL/current-policy provenance/locks/rollback
evidence is reused only for unchanged acquisition sources. This milestone does
not claim a new actual combined SQL journey, ordinary HTTP/browser editing,
production IAM, scheduler, Store activation, UAT or project completion.
