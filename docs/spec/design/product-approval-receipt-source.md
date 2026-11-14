# Owning Product approval receipt and current observation

WP-2421 preserves the independent Product decision required by accepted Sections68.9/73.5. This is separate from Generic Publishing approval of Brand/configuration policy. Existing Catalog Approve binds the Actor, submitted review and content/configuration/scope/period/current-policy tuple. Its snapshot preserved an approval reference but omitted the full approval's original time and expiration; that reference cannot supply renewed validity.

## Immutable receipt

Forward migration1100_009 adds Catalog-owned append-only `product_approval_receipt`, linked to the actual original Approve operation. It records exact Tenant/Brand/Product/version, original intent, original publication/result-root versions, Catalog recording time and the full approval including original approvedAt/validUntil. It has a canonical digest and bounded snapshot. Receipt IDs cannot be reassigned. Forced Tenant/Brand RLS refuses Store-scoped access; UPDATE/DELETE are denied. No prior receipt or applied migration is edited or backfilled.

The actual owning Approve writer appends this receipt inside existing CAS/publication/root/source-commit/Audit/Outbox transaction. It binds the independent User Actor to the recorded Approve and original requester/review. Invalid receipts, late authority or append failure roll back the entire operation, including the Audit chain head. Original replay returns its original publication/aggregate and adds no receipt. The full stored approval retains original expiry; replay neither grants current eligibility nor restores a canceled review.

Parsing is closed, copies descriptors without invoking accessors and rejects identity/digest/tuple mismatches. The pure builder validates structure and binding; arbitrary supplied values grant no authority. Normal approval preparation must obtain the decision/validity under current policy and Actor permission, rather than interpreting a DTO or fixture as an independent decision.

## Held current read

`withCurrentApproval` extends the owning publication source with separate mandatory `CATALOG_PRODUCT_APPROVAL_SOURCE` authority and full approval/review/Actor/expiry/content-identity fields. It requires current `catalog.manage` plus configured `catalog.product.approval.read`. Ordinary history authority does not substitute. This contract installs no runtime permission grant.

The query holds the existing Brand Product source barrier through callback and outer COMMIT. It checks actual latest Approved/Scheduled state, Draft version and expected current root/publication, immutable receipt, original Approve/SubmitReview revisions, operation/commit links and recorded Actor identities. Requester and approver must differ; review/body/scope/period/policy tuples agree. Missing receipts, canceled/changed state, foreign scope, incoherence or original expiry refuse. Old references without full receipts remain unavailable; historical expiration is not invented.

Observations bind current root/publication and caller-intent identity, so a Scheduled root is not confused with the receipt's original root. The requested lease is at most30 seconds and narrows to original approval expiry. Clock, observation and original validity are checked around caller work and final authority. A transaction runner that skips or replaces the actual callback result is rejected. Current authority and the source fence remain held until outer COMMIT.

Results retain `currentPolicy: NotEvaluated` and `eligibility: NotEvaluated`. Full publication composition must hold the actual current typed policy, compare required-approval/body identity, revalidate all twelve checks and satisfy topology/current caller permissions. Recorded approval does not substitute. Reschedule with a different period requires a new independently approved timing tuple; this source refuses the old period. The ordinary timing-review producer remains pending.

## Evidence and next assembly

Contract tests cover original validity, independent identity, Scheduled continuity, changed tuples/root/version, cancellation, expiry, descriptors and unknown fields. Actual isolated SQL uses owning Validate/SubmitReview/independent Approve commands, stores/reads the receipt and makes SchedulePublish consume this source in one outer transaction. It covers self approval, original replay after later state, actual fence, late authority/expiry/Outbox rollback, immutable rows and Tenant/Brand/Store isolation including foreign Tenant INSERT denial. Existing old publication/System scheduler remains compatible. Filtered results, shared223 gate, failures/repairs and input fingerprints remain in [WP-2421](../work-packages/history-WP-2421-01.md#overnight-owning-product-approval-receipt--2026-09-30-continuation).

Initial Draft metadata, validation outcomes, approval proposal/expiration and current Actor/field/policy holders are synthetic test inputs. Actual commands/SQL persist the local independent decision; this is not real human/UAT/professional evidence. Normal approval preparation/current-policy/field composition and UI remain incomplete. No new event type, frozen dependency, ordinary API/page, external action, sale authorization, complete Product/Store acceptance or root pnpm verify is claimed.

The [current approval/policy composition](./product-approval-policy-composition.md) now joins this actual owning receipt source with the actual typed Publishing policy under one Actor and outer transaction. SchedulePublish consumes both in the expanded local SQL case. Original validity and each owner fence remain intact. This advances the Required-policy match only; complete validation, ordinary approval preparation/timing and normal pages remain pending.

The [owning original decision preparation](./product-approval-decision-source.md) now produces original identity/time/validity from an authenticated Approve, actual current InReview/policy and an explicit server operational ceiling. It is exercised by a new cycle in actual SQL; the earlier supplied-expiry case retains its original synthetic-input boundary. Ordinary runtime/current validation/timing/pages remain pending.
