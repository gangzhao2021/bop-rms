# Product validation InternalCode current source

WP-2421 milestone120 implements the Section68.9 item2 requirement using the owning Catalog source. This is a bounded software decision under the accepted Product contract, not a new qualification policy.

## Authority and read boundary

The existing Product parser requires a normalized valid InternalCode. Migration1100 enforces unique `(brand_id, internal_code)` without lifecycle or case exemptions. The actual current candidate source binds the complete current Draft to the original Product root, content and configuration digests before reading code status.

The owning lifecycle reader already holds the exclusive `CatalogProductSource:<Brand>` advisory transaction barrier before code/Product locks. The code query reuses this barrier and the same outer Tenant/Brand/Actor transaction and RLS context. It reads only bounded self-match and no-other-Product booleans from Catalog's own Product table. Complete current field authority is held before and after both the initial query and final recheck. A changed self-match, malformed result, changed uniqueness, failed current authority or original lease expiry refuses the operation. There is no new lock order, migration, permission grammar or foreign-domain table access.

The pure `bindCatalogProductValidationCandidate` binds content only and cannot manufacture uniqueness evidence. The distinct `CatalogCurrentProductValidationCandidate` adds the actual owning `InternalCode` check, without returning the code or conflicting Product identifiers in the internal observation.

## Ordinary Validate composition

The existing candidate/scope binding requires original root, digests, intent, typed current policy and exclusive lease. The complete independent receipt must contain the explicit `InternalCode: Pass` placeholder, matching the existing UniqueScope composition rule; conflicting supplied code decisions refuse instead of being reinterpreted. The actual source replaces only that check, and Catalog recomputes HardErrorsCleared together with the no-Active-SKU necessary condition from milestone119. It preserves all other independent outcomes, evidence reference/version, warnings and Actor/Reason.

Code uniqueness Pass is evidence for this check only. It does not prove target-scope SKU publishability, processed Media, reference validation, the remaining full validation rules, sellability or System activation readiness. The native permission/failed-use/query/original five-second/CAS/Audit/Outbox guards and original source-free idempotent recovery remain required.

## Evidence boundary

Synthetic source tests cover conflict false, missing or malformed SQL results, foreign self, final changed result, current field denial and original expiry. Conflict false cannot be seeded as duplicate actual Product rows without violating the existing physical unique constraint; no constraint bypass is authorized or used.

The existing isolated native HTTP/SQL acceptance observes real owning query results and the exact Brand advisory lock on the same backend before and after consumer work. It withdraws synthetic current field authority immediately after an actual query and requires no tentative write or state change. Original lost-response replay must perform zero code queries. Actual SQL/native IAM/HTTP/CAS/rollback/recovery are distinguished from synthetic governance, field-authority and remaining validation fixtures. Milestone120 actual SQL selections passed: independent-approval/native helper 1/1 (three other cases filtered) with the added code query assertions, and complete-editor-content 1/1 (three other cases filtered) covering both actual Recipe consumers. The latter consumers validate the closed code member separately and retain exact comparison of the remaining pure content envelope. They infer no Recipe or Store qualification from code Pass.

The ownership scanner accepts only the exact bounded code SQL, exact bound Brand/code/Product arguments and named current-candidate function. Ten new scanner cases cover the permitted read plus foreign table, unbounded query, wrong/extra arguments, other function, dynamic SQL, alias and duplication refusals. Full scan and existing ownership/permission tests passed. Source12, candidate merge28, existing UniqueScope16/publication49, unchanged candidate22/baseline13 and affected Recipe target14 cases are recorded with distinct fresh/reused runs; final two API Recipe consumers95 and the earlier other candidate/native/constructor tests passed with test-inclusive types, builds, lint and formatting. Full commands, earlier failures and repairs, timestamps and input hashes are retained in the coordinating WP and overnight summary.

Product publication and Store capability management remain in progress. Complete current rule producers, topology/timing/screens, owning activation integration, real Store/Provider/Future Trigger/UAT/release evidence are separate outstanding work. No full repository verification or whole-project completion is implied.
