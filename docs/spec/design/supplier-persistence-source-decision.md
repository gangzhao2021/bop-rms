# DEC-PROC-SOURCE-01 — Supplier persistence and public source coverage

Status: Proposed, awaiting Owner acceptance. Prepared2026-09-28 under the Owner's
whole-project implementation request. This proposal is reviewable repository work;
it does not self-accept a change to ADR-0031 or Handoff Section94.2.

## Observed gap and authority

WP-2131 delivered Supplier Domain/Application/UI contracts but explicitly excluded
persistence/migrations. Current @rms/procurement owns schema=null/tables=[] and has
no database adapters. Recipe's accepted88.22 read model requires Supplier evidence
through a public owning feed. WP-2404's actual Recipe/Inventory/Catalog sources
cannot supply Procurement facts or use synthetic empty history as real completeness.

[ADR-0031](../../adr/ADR-0031-migration-catalog-namespace-bootstrap-ownership.md)
and accepted Section94.2 define a closed namespace set. Current registry ends at
1900-rms-inventory; no Procurement band exists. DEC-PILOT-INV-01 authorized Inventory
only, not a general right to allocate other owners. A narrow accepted supplement
is required before dependent schema/registry/ownership implementation.

## Concrete proposed acceptance

1. Append unused2000-rms-procurement to the canonical closed registry and runner
   expectation, with schema rms_procurement and sole write owner @rms/procurement.
   Preserve all existing migration IDs, contents, order and checksums. Namespace
   grants no runtime permissions or foreign table access.
2. Authorize internal Supplier persistence continuing WP-2131: stable scoped root,
   append-only aggregate snapshots and qualification/review history, operation
   replay records, exact expected-version fencing and atomic Audit. Root identity
   and supplierCode uniqueness include Tenant/Brand. Lifecycle transitions use
   existing accepted Supplier rules; qualification review must append new owning
   history rather than mutate any previously captured/version-pinned evidence.
3. Authorize procurement_supplier_v1 owner list/detail projection, durable generation
   and checkpoint, current source/version fences and permission masking. Qualification
   eligibility resolves exact effective periods at the requested UTC instant. No
   Offering/PO/performance summaries become zero when their authorized feeds are
   unavailable. Contacts, addresses and certificate/evidence fields remain restricted;
   purpose, separate permissions, retention/encryption controls apply before activation.
4. Authorize a public Supplier Recipe coverage capability: fixed Tenant/Brand, explicit
   Actor/purpose/current authorization, complete immutable source identities/digests,
   qualification/review/lifecycle/validity coverage and held-current callback through
   publication COMMIT. It returns only bounded internal identity/digest metadata;
   it does not expose Supplier PII or certify professional/legal/safety validity.
5. Explicit owned initial table candidates: supplier, supplier_version,
   supplier_qualification_version, supplier_operation_record,
   supplier_projection_generation, supplier_projection_row,
   supplier_projection_checkpoint, supplier_recipe_source_capture. Final table
   semantics and each exact manifest/read/write/classification/retention entry are
   recorded by WP-2405 before implementation. No other business table is admitted.
6. Use explicit synthetic Supplier/professional/authority facts in real isolated
   PostgreSQL acceptance. Verify scope RLS, history immutability, replay/concurrency,
   authorization rollback, exact integer/time behavior and public Recipe consumer
   integration. Missing actual Supplier/qualification/Store facts stay unavailable.

## External actions and phase

This supplement authorizes repository implementation and isolated verification only.
Procurement Phase3 feature/runtime activation remains gated by its accepted phase
and feature commitments. Live Supplier onboarding, actual professional evidence,
PO/Requisition/Offering/price changes, scheduler/event transport, external services,
roles/ACL/schema deployment, commit/push/merge and release are outside this decision.
Existing local runtime and retained WP-2402/WP-2403/WP-2404 candidates stay preserved.

## Review and rollback

WP-2405 is prepared on a clean baseline03ad510 in a separate managed worktree. Its
initial changes are documentation only. After acceptance, update ADR/index/registry
and brief explicitly; build only the owning scope and collect affected evidence.
No pending lower-namespace migration is inserted:2000 follows the current1900 band.
Live activation still requires the actual then-current catalog/recovery/backup review.
Rollback removes an unapplied isolated candidate; no runner history repair or
applied migration rewriting is permitted. Full pnpm verify is the assembled release/
merge milestone, alongside exact-head CI where required.
