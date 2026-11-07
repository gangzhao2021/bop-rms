# Product validation: elapsed EffectivePeriod prerequisite

WP-2421 Milestone127 mirrors the existing Catalog `Publish` / `ActivateScheduled` time rule
in owning current Candidate validation: a finite half-open period with `effectiveUntil <= now`
records `EffectivePeriod` and `HardErrorsCleared` HardError. Accepted Section68.9 requires a
valid EffectivePeriod. The original owning parser still checks IANA time zone, UTC instant,
local time/offset coherence and strict interval order. No retrospective legality, Store calendar,
grace period or additional scheduling policy is inferred.

The rule runs only after exact current Candidate/UniqueScope/intent/content/configuration/policy
and full receipt binding. It uses the original monotonic server validation instant, preserves
all current sources, permissions, original leases and COMMIT guards, and never promotes an
open or not-yet-ended period to an independent validation Pass. Warning Actor/Reason remains
unchanged; a warning acknowledgement rendered incompatible by a new HardError refuses rather
than becoming an override. Unknown/malformed inputs stay unavailable. The existing immediate
publication and actual System activation revalidation remain mandatory and unchanged.

The ordinary native HTTP/SQL acceptance crosses an original period end after actual owning
UniqueScope acquisition and before the current Candidate merge, using a controlled clock still
inside the unchanged native/source deadline. An already ended period at the initial UniqueScope
observation still refuses through the existing owner. The fixture uses an actual owning
current Product candidate, Active SKU, complete Valid/Invalid Variant mapping, no Option binding
and known Brand scope. Other full checks, field holders, identities and policy governance remain
synthetic. Exact per-check behavior is proven separately by Catalog tests; the existing SQL
revision stores the overall decision and evidence identity only. Actual source/HTTP/SQL,
late rollback, current permission and original source-free recovery evidence must be reported
separately after execution. No real Store/Provider/UAT/release qualification is implied.

Full Product validation/current topology/target-scope SKU/Media and ordinary release pages,
System integration and Store initial management remain open. This necessary time rule alone
cannot close them or complete the project.

## Local evidence on 2026-10-02

Final existing native selection5461 passed1/1 with3 other tests filtered,120.77s body/123.24s total.
The seventh fixture observes actual scope assessment before original expiry and unchanged owning
merge after expiry, with only EffectivePeriod/HardErrorsCleared failing; ordinary HTTP persists
overall HardError/root2. Current write denial and original zero-source/no-new-state recovery
retain that result. Six prior fixtures keep their original rollback/expiry assertions. No additional
ended-period post-write rollback or scheduled activation is claimed. The first attempt80286
returned503 before writing because the period had already ended at the initial UniqueScope
observation; that existing refusal was preserved and only the test phase was corrected.

Final Catalog candidate64 cases/types/build and API two consumer suites69 cases pass. Earlier
UniqueScope/publication65 cases on unchanged final production inputs are reused. Actual scope
and merge observers return their original results without supplying checks or changing source
provenance. Controlled clock, remaining checks, business identities and field/governance holders
remain synthetic; full source, UI, Store/Provider and release gates remain open.
