import { parseIndependentPublishingApprovalRequest } from "../../contracts/independent-approval-source.js";
import {
  parsePublishingOptionSetPublicationPolicy,
  publishingOptionSetPublicationPolicyDigest,
  optionSetPolicyConfigurationType,
} from "../../contracts/option-set-publication-policy.js";
import {
  parsePublishingProductPublicationPolicy,
  publishingProductPublicationPolicyDigest,
  productPolicyConfigurationType,
} from "../../contracts/product-publication-policy.js";
import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
} from "@bop/audit";
import type { CommitPublishingMutationInput } from "../../application/ports/publishing-ports.js";
import {
  evaluatePublishingTransition,
  publishingOperations,
} from "../../domain/evaluate-publishing-transition.js";
import {
  createPublishingLifecycleRecord,
  createPublishingReleaseRecord,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  createPublishingScope,
  parsePublishingReference,
  parsePublishingCode,
  parsePublishingInstant,
  parsePublishingVersion,
  samePublishingScope,
  PublishingContractError,
  type PublishingScope,
} from "../../contracts/publishing.js";
export interface PublishingTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface PublishingTransactionRunner {
  run<T>(work: (tx: PublishingTransaction) => Promise<T>): Promise<T>;
}
const fail = (): never => {
  throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
};
function rows(value: unknown): readonly Record<string, unknown>[] {
  if (!value || typeof value !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(value, "rows");
  if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length > 1024) return fail();
  return d.value;
}
function normalize(input: CommitPublishingMutationInput): CommitPublishingMutationInput {
  if (!publishingOperations.includes(input.operation)) return fail();
  const next = createPublishingLifecycleRecord(input.next);
  const descriptor = Object.getOwnPropertyDescriptor(input, "productPolicyContent");
  let policy;
  if (descriptor) {
    if (!("value" in descriptor) || !descriptor.enumerable || input.operation !== "CreateDraft")
      return fail();
    policy = parsePublishingProductPublicationPolicy(descriptor.value);
    if (
      next.configurationType !== productPolicyConfigurationType ||
      next.purposeCode !== productPolicyConfigurationType ||
      next.scope.kind !== "Brand" ||
      policy.brandReference !== String(next.scope.brandReference) ||
      policy.familyReference !== next.familyReference ||
      policy.policyReference !== next.snapshotReference ||
      publishingProductPublicationPolicyDigest(policy) !== next.snapshotDigest
    )
      return fail();
  }
  const optionDescriptor = Object.getOwnPropertyDescriptor(input, "optionSetPolicyContent");
  let optionPolicy;
  if (optionDescriptor) {
    if (
      !("value" in optionDescriptor) ||
      !optionDescriptor.enumerable ||
      input.operation !== "CreateDraft"
    )
      return fail();
    optionPolicy = parsePublishingOptionSetPublicationPolicy(optionDescriptor.value);
    if (
      next.configurationType !== optionSetPolicyConfigurationType ||
      next.purposeCode !== optionSetPolicyConfigurationType ||
      next.scope.kind !== "Brand" ||
      optionPolicy.brandReference !== String(next.scope.brandReference) ||
      optionPolicy.familyReference !== next.familyReference ||
      optionPolicy.policyReference !== next.snapshotReference ||
      publishingOptionSetPublicationPolicyDigest(optionPolicy) !== next.snapshotDigest
    )
      return fail();
  }
  if (descriptor && optionDescriptor) return fail();
  if (
    (next.configurationType === optionSetPolicyConfigurationType ||
      next.purposeCode === optionSetPolicyConfigurationType) &&
    (next.configurationType !== optionSetPolicyConfigurationType ||
      next.purposeCode !== optionSetPolicyConfigurationType ||
      next.scope.kind !== "Brand")
  )
    return fail();
  return Object.freeze({
    ...(policy === undefined ? {} : { productPolicyContent: policy }),
    ...(optionPolicy === undefined ? {} : { optionSetPolicyContent: optionPolicy }),
    operation: input.operation,
    expectedVersion: parsePublishingVersion(input.expectedVersion),
    idempotencyKey: parsePublishingReference(input.idempotencyKey),
    current: input.current === null ? null : createPublishingLifecycleRecord(input.current),
    next,
    release: input.release === null ? null : createPublishingReleaseRecord(input.release),
    supersededReleaseId:
      input.supersededReleaseId === null
        ? null
        : parsePublishingReference(input.supersededReleaseId),
    rollbackTargetReleaseId:
      input.rollbackTargetReleaseId === null
        ? null
        : parsePublishingReference(input.rollbackTargetReleaseId),
    validationEvidence:
      input.validationEvidence === null
        ? null
        : createPublishingValidationEvidence(input.validationEvidence),
    approvalEvidence:
      input.approvalEvidence === null
        ? null
        : createPublishingApprovalEvidence(input.approvalEvidence),
    audit: validateAuditRecord(input.audit, Date.parse(input.audit.occurredAt)),
  });
}
const auditActions = {
  CreateDraft: "PUBLISHING_DRAFT_CREATED",
  SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
  Approve: "PUBLISHING_REVIEW_APPROVED",
  Publish: "PUBLISHING_RELEASE_PUBLISHED",
  Archive: "PUBLISHING_RELEASE_ARCHIVED",
  Rollback: "PUBLISHING_RELEASE_ROLLED_BACK",
} as const;
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const digest = (value: CommitPublishingMutationInput) =>
  "sha256:" +
  sha256Hex(canonicalizeRfc8785({ ...value, audit: { ...value.audit, auditId: null } }));
/** Internal owner capability; authorize each request before commit. Bind runner to caller UoW. */
export function createPostgresPublishingMutationStore(
  runner: PublishingTransactionRunner,
  tenantReference: string,
  scopeInput: PublishingScope,
) {
  const tenant = parsePublishingReference(tenantReference),
    scope = createPublishingScope(scopeInput);
  const scoped = [tenant, scope.brandReference, scope.storeReference];
  return Object.freeze({
    /** Exact historical recovery, not current approval/release authority.
     * Caller authorizes and retains this operation fence through dependent work.
     */
    async resolveOperation(
      input: Readonly<{
        operationReference: string;
        familyReference: string;
        lifecycleReference: string;
        configurationType: string;
        purposeCode: string;
        observedAt: string;
      }>,
    ) {
      try {
        const operation = parsePublishingReference(input.operationReference);
        const family = parsePublishingReference(input.familyReference);
        const lifecycle = parsePublishingReference(input.lifecycleReference);
        const configurationType = parsePublishingCode(input.configurationType);
        const purposeCode = parsePublishingCode(input.purposeCode);
        const observedAt = parsePublishingInstant(input.observedAt);
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenant, scope.brandReference, scope.storeReference ?? ""],
          );
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "PublishingOperation:" + tenant + ":" + scope.brandReference + ":" + operation,
          ]);
          const found = rows(
            await tx.query(
              "SELECT mutation_json,intent_hash,audit_id FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND operation_id=$4",
              [...scoped, operation],
            ),
          );
          if (!found.length) return null;
          const row = found[0];
          if (found.length !== 1 || !row) return fail();
          const original = normalize(row.mutation_json as CommitPublishingMutationInput);
          if (
            original.idempotencyKey !== operation ||
            row.intent_hash !== digest(original) ||
            row.audit_id !== original.audit.auditId ||
            original.next.familyReference !== family ||
            original.next.lifecycleId !== lifecycle ||
            original.next.configurationType !== configurationType ||
            original.next.purposeCode !== purposeCode ||
            !samePublishingScope(original.next.scope, scope) ||
            (original.current !== null && !samePublishingScope(original.current.scope, scope)) ||
            original.next.changedAt > observedAt ||
            original.audit.occurredAt > observedAt ||
            original.audit.occurredAt < original.next.changedAt ||
            original.audit.actor.type !== "User" ||
            original.audit.brandId !== scope.brandReference ||
            (original.audit.storeId ?? null) !== scope.storeReference ||
            original.audit.targetType !== "PublishingLifecycle" ||
            original.audit.targetId !== lifecycle ||
            original.audit.dataClassification !== "Confidential" ||
            original.audit.actionCode !== auditActions[original.operation] ||
            !evaluatePublishingTransition({
              operation: original.operation,
              expectedVersion: original.expectedVersion,
              current: original.current,
              next: original.next,
            }).allowed
          )
            return fail();
          return original;
        });
      } catch {
        return fail();
      }
    },
    /** Owner recovery input, not approval/release authority. No historical fallback.
     * Caller must authorize and retain this transaction while preparing mutations.
     */
    async resolveCurrentLifecycleMutation(
      input: Readonly<{
        familyReference: string;
        lifecycleReference: string;
        configurationType: string;
        purposeCode: string;
        observedAt: string;
      }>,
    ) {
      try {
        const family = parsePublishingReference(input.familyReference);
        const lifecycle = parsePublishingReference(input.lifecycleReference);
        const configurationType = parsePublishingCode(input.configurationType);
        const purposeCode = parsePublishingCode(input.purposeCode);
        const observedAt = parsePublishingInstant(input.observedAt);
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenant, scope.brandReference, scope.storeReference ?? ""],
          );
          await tx.query("LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE MODE", []);
          const row = rows(
            await tx.query(
              "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND lifecycle_id=$4 ORDER BY lifecycle_version DESC LIMIT 1",
              [...scoped, lifecycle],
            ),
          )[0];
          if (!row) return null;
          const head = normalize(row.mutation_json as CommitPublishingMutationInput);
          if (
            row.intent_hash !== digest(head) ||
            head.next.lifecycleId !== lifecycle ||
            head.next.familyReference !== family ||
            head.next.configurationType !== configurationType ||
            head.next.purposeCode !== purposeCode ||
            !samePublishingScope(head.next.scope, scope) ||
            head.next.changedAt > observedAt ||
            head.audit.occurredAt > observedAt ||
            head.audit.actionCode !== auditActions[head.operation] ||
            head.audit.brandId !== scope.brandReference ||
            (head.audit.storeId ?? null) !== scope.storeReference ||
            !evaluatePublishingTransition({
              operation: head.operation,
              expectedVersion: head.expectedVersion,
              current: head.current,
              next: head.next,
            }).allowed
          )
            return fail();
          return head;
        });
      } catch {
        return fail();
      }
    },
    /** Pre-publication approval only; caller authorizes and retains outer transaction.
     * Latest lifecycle state must still be Approved; no fallback to earlier approval.
     */
    async resolveCurrentApproval(
      input: Readonly<{
        familyReference: string;
        lifecycleReference: string;
        configurationType: string;
        purposeCode: string;
        observedAt: string;
      }>,
    ) {
      try {
        const family = parsePublishingReference(input.familyReference);
        const lifecycle = parsePublishingReference(input.lifecycleReference);
        const configurationType = parsePublishingCode(input.configurationType);
        const purposeCode = parsePublishingCode(input.purposeCode);
        const observedAt = parsePublishingInstant(input.observedAt);
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenant, scope.brandReference, scope.storeReference ?? ""],
          );
          await tx.query("LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE MODE", []);
          const row = rows(
            await tx.query(
              "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND lifecycle_id=$4 ORDER BY lifecycle_version DESC LIMIT 1",
              [...scoped, lifecycle],
            ),
          )[0];
          if (!row) return fail();
          const head = normalize(row.mutation_json as CommitPublishingMutationInput);
          const approval = head.approvalEvidence,
            next = head.next;
          if (
            row.intent_hash !== digest(head) ||
            head.operation !== "Approve" ||
            next.state !== "Approved" ||
            next.lifecycleId !== lifecycle ||
            next.familyReference !== family ||
            next.configurationType !== configurationType ||
            next.purposeCode !== purposeCode ||
            !samePublishingScope(next.scope, scope) ||
            next.changedAt > observedAt ||
            head.audit.occurredAt > observedAt ||
            approval === null ||
            approval.evidenceReference !== next.approvalEvidenceReference ||
            approval.reviewLifecycleId !== lifecycle ||
            approval.reviewVersion + 1 !== next.version ||
            approval.snapshotReference !== next.snapshotReference ||
            approval.snapshotDigest !== next.snapshotDigest ||
            !samePublishingScope(approval.scope, scope) ||
            approval.approvedAt > observedAt ||
            approval.validUntil <= observedAt ||
            head.audit.actor.type !== "User" ||
            approval.approvedActorReference !== head.audit.actor.reference
          )
            return fail();
          return Object.freeze({
            lifecycle: next,
            approvalEvidence: approval,
            auditReference: parsePublishingReference(head.audit.auditId),
            observedAt,
          });
        });
      } catch {
        return fail();
      }
    },
    /** Recorded independent approval only. Current owner/field authority and full
     * validation must be held separately; bind runner to caller UoW and reread
     * after tentative work. No historical fallback or publication admission. */
    async resolveCurrentIndependentApproval(value: unknown) {
      try {
        const input = parseIndependentPublishingApprovalRequest(value);
        return await runner.run(async (tx) => {
          const owner = createPostgresPublishingMutationStore(
              { run: (work) => work(tx) },
              tenant,
              scope,
            ),
            approved = await owner.resolveCurrentApproval(input),
            version = approved.lifecycle.version,
            history = rows(
              await tx.query(
                "SELECT mutation_json,intent_hash,audit_id FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND lifecycle_id=$4 AND lifecycle_version IN ($5,$6,$7) ORDER BY lifecycle_version ASC LIMIT 4",
                [...scoped, input.lifecycleReference, version - 2, version - 1, version],
              ),
            );
          if (version < 3 || history.length !== 3) return fail();
          const normalized = history.map((row) => {
            const m = normalize(row.mutation_json as CommitPublishingMutationInput);
            if (row.intent_hash !== digest(m) || row.audit_id !== m.audit.auditId) return fail();
            const a = m.audit,
              n = m.next;
            if (
              !samePublishingScope(n.scope, scope) ||
              n.lifecycleId !== input.lifecycleReference ||
              n.familyReference !== input.familyReference ||
              n.configurationType !== input.configurationType ||
              n.purposeCode !== input.purposeCode ||
              n.snapshotReference !== input.snapshotReference ||
              n.snapshotDigest !== input.snapshotDigest ||
              a.brandId !== scope.brandReference ||
              (a.storeId ?? null) !== scope.storeReference ||
              a.actor.type !== "User" ||
              a.targetType !== "PublishingLifecycle" ||
              a.targetId !== n.lifecycleId ||
              a.dataClassification !== "Confidential" ||
              a.actionCode !== auditActions[m.operation] ||
              a.occurredAt < n.changedAt ||
              a.occurredAt > input.observedAt ||
              n.createdAt > n.changedAt ||
              m.release !== null ||
              m.supersededReleaseId !== null ||
              m.rollbackTargetReleaseId !== null
            )
              return fail();
            return m;
          });
          const [draft, review, approval] = normalized;
          if (
            !draft ||
            !review ||
            !approval ||
            draft.operation !== "CreateDraft" ||
            draft.next.state !== "Draft" ||
            draft.next.version !== version - 2 ||
            draft.validationEvidence !== null ||
            draft.approvalEvidence !== null ||
            review.operation !== "SubmitReview" ||
            review.next.version !== version - 1 ||
            approval.operation !== "Approve" ||
            approval.next.version !== version ||
            review.audit.actor.type !== "User" ||
            approval.audit.actor.type !== "User" ||
            review.audit.actor.reference === approval.audit.actor.reference ||
            !equal(review.current, draft.next) ||
            !equal(approval.current, review.next) ||
            !equal(approval.next, approved.lifecycle) ||
            !equal(approval.approvalEvidence, approved.approvalEvidence) ||
            review.approvalEvidence !== null ||
            approval.validationEvidence !== null ||
            review.audit.occurredAt < draft.audit.occurredAt ||
            approval.audit.occurredAt < review.audit.occurredAt ||
            !evaluatePublishingTransition({
              operation: draft.operation,
              expectedVersion: draft.expectedVersion,
              current: draft.current,
              next: draft.next,
            }).allowed ||
            !evaluatePublishingTransition({
              operation: review.operation,
              expectedVersion: review.expectedVersion,
              current: review.current,
              next: review.next,
            }).allowed ||
            !evaluatePublishingTransition({
              operation: approval.operation,
              expectedVersion: approval.expectedVersion,
              current: approval.current,
              next: approval.next,
            }).allowed
          )
            return fail();
          const validation = review.validationEvidence,
            evidence = approval.approvalEvidence;
          if (
            !validation ||
            !evidence ||
            validation.evidenceReference !== review.next.validationEvidenceReference ||
            validation.evidenceReference !== approval.next.validationEvidenceReference ||
            validation.snapshotReference !== input.snapshotReference ||
            validation.snapshotDigest !== input.snapshotDigest ||
            !samePublishingScope(validation.scope, scope) ||
            validation.checkedAt > review.audit.occurredAt ||
            validation.validUntil <= input.observedAt ||
            validation.validUntil <= approval.audit.occurredAt ||
            evidence.approvedAt < review.audit.occurredAt ||
            evidence.approvedAt > approval.audit.occurredAt ||
            !equal([...validation.checkCodes].sort(), input.requiredCheckCodes)
          )
            return fail();
          const body = Object.freeze({
            profile: "CurrentIndependentPublishingApprovalV1" as const,
            tenantReference: tenant,
            scope,
            familyReference: input.familyReference,
            lifecycleReference: input.lifecycleReference,
            configurationType: input.configurationType,
            purposeCode: input.purposeCode,
            snapshotReference: input.snapshotReference,
            snapshotDigest: input.snapshotDigest,
            approvedLifecycleVersion: version,
            reviewVersion: review.next.version,
            draftOperationReference: draft.idempotencyKey,
            reviewOperationReference: review.idempotencyKey,
            approvalOperationReference: approval.idempotencyKey,
            requestedByActorReference: review.audit.actor.reference,
            approvedByActorReference: evidence.approvedActorReference,
            validationEvidenceReference: validation.evidenceReference,
            approvalEvidenceReference: evidence.evidenceReference,
            validationCheckCodes: Object.freeze([...validation.checkCodes].sort()),
            observedAt: input.observedAt,
            validUntil:
              validation.validUntil < evidence.validUntil
                ? validation.validUntil
                : evidence.validUntil,
            sourceDigest:
              "sha256:" +
              sha256Hex(
                canonicalizeRfc8785(
                  normalized.map((m) => ({
                    operationReference: m.idempotencyKey,
                    intentDigest: digest(m),
                    auditReference: m.audit.auditId,
                  })),
                ),
              ),
            recordedIndependence: "Verified" as const,
            currentValidation: "NotEvaluated" as const,
            referenceEligibility: "NotEvaluated" as const,
            eligibility: "NotEvaluated" as const,
          });
          return Object.freeze({
            ...body,
            digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
          });
        });
      } catch {
        return fail();
      }
    },
    /** Approved candidate plus original validation and current predecessor for Publish.
     * Caller authorizes and retains the transaction; missing predecessor is explicit.
     */
    async resolvePublicationCandidate(
      input: Readonly<{
        familyReference: string;
        lifecycleReference: string;
        configurationType: string;
        purposeCode: string;
        observedAt: string;
      }>,
    ) {
      try {
        return await runner.run(async (tx) => {
          const owner = createPostgresPublishingMutationStore(
            { run: async (work) => work(tx) },
            tenant,
            scope,
          );
          const approved = await owner.resolveCurrentApproval(input);
          const row = rows(
            await tx.query(
              "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND lifecycle_id=$4 AND lifecycle_version=$5",
              [...scoped, approved.lifecycle.lifecycleId, approved.approvalEvidence.reviewVersion],
            ),
          )[0];
          if (!row) return fail();
          const review = normalize(row.mutation_json as CommitPublishingMutationInput);
          const validation = review.validationEvidence;
          if (
            row.intent_hash !== digest(review) ||
            review.operation !== "SubmitReview" ||
            review.next.state !== "InReview" ||
            !samePublishingScope(review.next.scope, scope) ||
            review.next.familyReference !== approved.lifecycle.familyReference ||
            review.next.configurationType !== approved.lifecycle.configurationType ||
            review.next.purposeCode !== approved.lifecycle.purposeCode ||
            review.next.snapshotReference !== approved.lifecycle.snapshotReference ||
            review.next.snapshotDigest !== approved.lifecycle.snapshotDigest ||
            validation === null ||
            validation.evidenceReference !== approved.lifecycle.validationEvidenceReference ||
            validation.snapshotReference !== approved.lifecycle.snapshotReference ||
            validation.snapshotDigest !== approved.lifecycle.snapshotDigest ||
            !samePublishingScope(validation.scope, scope) ||
            validation.checkedAt > input.observedAt ||
            validation.validUntil <= input.observedAt
          )
            return fail();
          const previous = rows(
            await tx.query(
              "SELECT release_id FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND family_id=$4 AND release_id IS NOT NULL ORDER BY release_sequence DESC LIMIT 1",
              [...scoped, approved.lifecycle.familyReference],
            ),
          )[0];
          const previousRelease = previous
            ? (await owner.resolveCurrentRelease(input)).release
            : null;
          return Object.freeze({ ...approved, validationEvidence: validation, previousRelease });
        });
      } catch {
        return fail();
      }
    },
    /** Current source only; bind runner to the outer transaction to retain the read fence. */
    async resolveCurrentRelease(
      input: Readonly<{
        familyReference: string;
        configurationType: string;
        purposeCode: string;
        observedAt: string;
      }>,
    ) {
      try {
        const family = parsePublishingReference(input.familyReference);
        const configurationType = parsePublishingCode(input.configurationType);
        const purposeCode = parsePublishingCode(input.purposeCode);
        const observedAt = parsePublishingInstant(input.observedAt);
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenant, scope.brandReference, scope.storeReference ?? ""],
          );
          await tx.query("LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE MODE", []);
          const headRow = rows(
            await tx.query(
              "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND family_id=$4 AND release_id IS NOT NULL ORDER BY release_sequence DESC LIMIT 1",
              [...scoped, family],
            ),
          )[0];
          if (!headRow) return fail();
          const head = normalize(headRow.mutation_json as CommitPublishingMutationInput);
          const release = head.release;
          if (
            release === null ||
            headRow.intent_hash !== digest(head) ||
            !samePublishingScope(release.scope, scope) ||
            release.familyReference !== family ||
            release.configurationType !== configurationType ||
            release.purposeCode !== purposeCode ||
            release.createdAt > observedAt ||
            head.audit.occurredAt > observedAt ||
            head.validationEvidence === null ||
            head.approvalEvidence === null
          )
            return fail();
          const latestRow = rows(
            await tx.query(
              "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND lifecycle_id=$4 ORDER BY lifecycle_version DESC LIMIT 1",
              [...scoped, release.sourceLifecycleId],
            ),
          )[0];
          if (!latestRow) return fail();
          const latest = normalize(latestRow.mutation_json as CommitPublishingMutationInput);
          if (
            latestRow.intent_hash !== digest(latest) ||
            latest.next.state !== "Published" ||
            !equal(latest.next, head.next) ||
            latest.next.changedAt > observedAt ||
            !samePublishingScope(latest.next.scope, scope)
          )
            return fail();
          return Object.freeze({
            release,
            lifecycle: latest.next,
            validationEvidence: head.validationEvidence,
            approvalEvidence: head.approvalEvidence,
            auditReference: parsePublishingReference(head.audit.auditId),
            observedAt,
          });
        });
      } catch {
        return fail();
      }
    },
    /**
     * Resolve a recorded immutable release through the actual current owning family head.
     * Historical evidence remains separate: a later rollback has its own approval/release.
     * Authorize first and bind runner to the outer UoW to retain the source fence.
     */
    async resolveCurrentReleaseForReference(
      input: Readonly<{
        publicationReference: string;
        configurationType: string;
        purposeCode: string;
        observedAt: string;
      }>,
    ) {
      try {
        if (!input || typeof input !== "object") return fail();
        const prototype = Object.getPrototypeOf(input);
        if (prototype !== Object.prototype && prototype !== null) return fail();
        const keys = ["publicationReference", "configurationType", "purposeCode", "observedAt"];
        if (Reflect.ownKeys(input).length !== keys.length) return fail();
        const values = keys.map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(input, key);
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail();
          return descriptor.value;
        });
        const publication = parsePublishingReference(values[0]);
        const configurationType = parsePublishingCode(values[1]);
        const purposeCode = parsePublishingCode(values[2]);
        const observedAt = parsePublishingInstant(values[3]);
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenant, scope.brandReference, scope.storeReference ?? ""],
          );
          await tx.query("LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE MODE", []);
          const recordedRows = rows(
            await tx.query(
              "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND release_id=$4",
              [...scoped, publication],
            ),
          );
          if (recordedRows.length !== 1) return fail();
          const row = recordedRows[0];
          if (!row) return fail();
          const recorded = normalize(row.mutation_json as CommitPublishingMutationInput);
          const release = recorded.release;
          const validation = recorded.validationEvidence;
          const approval = recorded.approvalEvidence;
          if (
            release === null ||
            validation === null ||
            approval === null ||
            (recorded.operation !== "Publish" && recorded.operation !== "Rollback") ||
            release.kind !== recorded.operation ||
            row.intent_hash !== digest(recorded) ||
            release.releaseId !== publication ||
            !samePublishingScope(release.scope, scope) ||
            release.configurationType !== configurationType ||
            release.purposeCode !== purposeCode ||
            release.createdAt > observedAt ||
            recorded.audit.occurredAt > observedAt ||
            recorded.next.state !== "Published" ||
            recorded.next.lifecycleId !== release.sourceLifecycleId ||
            recorded.next.familyReference !== release.familyReference ||
            recorded.next.configurationType !== configurationType ||
            recorded.next.purposeCode !== purposeCode ||
            recorded.next.snapshotReference !== release.snapshotReference ||
            recorded.next.snapshotDigest !== release.snapshotDigest ||
            !samePublishingScope(recorded.next.scope, scope) ||
            validation.snapshotReference !== release.snapshotReference ||
            validation.snapshotDigest !== release.snapshotDigest ||
            validation.result !== "Pass" ||
            !samePublishingScope(validation.scope, scope) ||
            approval.snapshotReference !== release.snapshotReference ||
            approval.snapshotDigest !== release.snapshotDigest ||
            approval.decision !== "Accepted" ||
            !samePublishingScope(approval.scope, scope) ||
            recorded.next.validationEvidenceReference !== validation.evidenceReference ||
            recorded.next.approvalEvidenceReference !== approval.evidenceReference
          )
            return fail();
          const current = await createPostgresPublishingMutationStore(
            { run: async (work) => work(tx) },
            tenant,
            scope,
          ).resolveCurrentRelease({
            familyReference: release.familyReference,
            configurationType,
            purposeCode,
            observedAt,
          });
          if (
            current.release.snapshotReference !== release.snapshotReference ||
            current.release.snapshotDigest !== release.snapshotDigest
          )
            return fail();
          return Object.freeze({
            recorded: Object.freeze({
              release,
              validationEvidence: validation,
              approvalEvidence: approval,
              auditReference: parsePublishingReference(recorded.audit.auditId),
            }),
            current,
          });
        });
      } catch {
        return fail();
      }
    },
    async resolveCurrentProductPublicationPolicy(
      input: Readonly<{ policyReference: string; policyVersion: number; observedAt: string }>,
    ) {
      try {
        const d = Object.getOwnPropertyDescriptors(input),
          keys = Reflect.ownKeys(input);
        const fields = ["policyReference", "policyVersion", "observedAt"];
        if (
          Object.getPrototypeOf(input) !== Object.prototype ||
          keys.length !== 3 ||
          keys.some(
            (k) =>
              typeof k !== "string" ||
              !fields.includes(k) ||
              !d[k]?.enumerable ||
              !("value" in d[k]),
          )
        )
          return fail();
        const reference = parsePublishingReference(d.policyReference?.value),
          version = parsePublishingVersion(d.policyVersion?.value),
          observedAt = parsePublishingInstant(d.observedAt?.value);
        if (scope.kind !== "Brand") return fail();
        return await runner.run(async (tx) => {
          const isolation = rows(
            await tx.query("SELECT current_setting('transaction_isolation') AS isolation", []),
          );
          if (isolation.length !== 1 || isolation[0]?.isolation !== "read committed") return fail();
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenant, scope.brandReference],
          );
          await tx.query("LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE MODE", []);
          const records = rows(
            await tx.query(
              "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND operation_code='CreateDraft' AND mutation_json ? 'productPolicyContent' AND mutation_json#>>'{next,snapshotReference}'=$3 ORDER BY changed_at,lifecycle_version LIMIT 1025",
              [tenant, scope.brandReference, reference],
            ),
          );
          if (records.length === 0 || records.length > 1024) return fail();
          let content: ReturnType<typeof parsePublishingProductPublicationPolicy> | undefined;
          for (const row of records) {
            const m = normalize(row.mutation_json as CommitPublishingMutationInput),
              p = m.productPolicyContent;
            if (
              !p ||
              row.intent_hash !== digest(m) ||
              p.tenantReference !== tenant ||
              p.policyVersion !== version ||
              m.audit.occurredAt > observedAt ||
              (content && !equal(content, p))
            )
              return fail();
            content = p;
          }
          if (
            !content ||
            content.effectiveFrom > observedAt ||
            (content.effectiveUntil !== null && content.effectiveUntil <= observedAt)
          )
            return fail();
          const current = await createPostgresPublishingMutationStore(
            { run: (work) => work(tx) },
            tenant,
            scope,
          ).resolveCurrentRelease({
            familyReference: content.familyReference,
            configurationType: productPolicyConfigurationType,
            purposeCode: productPolicyConfigurationType,
            observedAt,
          });
          if (
            current.release.snapshotReference !== reference ||
            current.release.snapshotDigest !== publishingProductPublicationPolicyDigest(content)
          )
            return fail();
          return Object.freeze({ content, current, observedAt });
        });
      } catch {
        return fail();
      }
    },
    async resolveCurrentOptionSetPublicationPolicy(
      input: Readonly<{ policyReference: string; policyVersion: number; observedAt: string }>,
    ) {
      try {
        const d = Object.getOwnPropertyDescriptors(input),
          keys = Reflect.ownKeys(input);
        const fields = ["policyReference", "policyVersion", "observedAt"];
        if (
          Object.getPrototypeOf(input) !== Object.prototype ||
          keys.length !== 3 ||
          keys.some(
            (k) =>
              typeof k !== "string" ||
              !fields.includes(k) ||
              !d[k]?.enumerable ||
              !("value" in d[k]),
          )
        )
          return fail();
        const reference = parsePublishingReference(d.policyReference?.value),
          version = parsePublishingVersion(d.policyVersion?.value),
          observedAt = parsePublishingInstant(d.observedAt?.value);
        if (scope.kind !== "Brand") return fail();
        return await runner.run(async (tx) => {
          const isolation = rows(
            await tx.query("SELECT current_setting('transaction_isolation') AS isolation", []),
          );
          if (isolation.length !== 1 || isolation[0]?.isolation !== "read committed") return fail();
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenant, scope.brandReference],
          );
          await tx.query("LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE MODE", []);
          const records = rows(
            await tx.query(
              "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND operation_code='CreateDraft' AND mutation_json ? 'optionSetPolicyContent' AND mutation_json#>>'{next,snapshotReference}'=$3 ORDER BY changed_at,lifecycle_version LIMIT 1025",
              [tenant, scope.brandReference, reference],
            ),
          );
          if (records.length === 0 || records.length > 1024) return fail();
          let content: ReturnType<typeof parsePublishingOptionSetPublicationPolicy> | undefined;
          for (const row of records) {
            const m = normalize(row.mutation_json as CommitPublishingMutationInput),
              p = m.optionSetPolicyContent;
            if (
              !p ||
              row.intent_hash !== digest(m) ||
              p.tenantReference !== tenant ||
              p.policyVersion !== version ||
              m.audit.occurredAt > observedAt ||
              (content && !equal(content, p))
            )
              return fail();
            content = p;
          }
          if (
            !content ||
            content.effectiveFrom > observedAt ||
            (content.effectiveUntil !== null && content.effectiveUntil <= observedAt)
          )
            return fail();
          const current = await createPostgresPublishingMutationStore(
            { run: (work) => work(tx) },
            tenant,
            scope,
          ).resolveCurrentRelease({
            familyReference: content.familyReference,
            configurationType: optionSetPolicyConfigurationType,
            purposeCode: optionSetPolicyConfigurationType,
            observedAt,
          });
          if (
            current.release.snapshotReference !== reference ||
            current.release.snapshotDigest !== publishingOptionSetPublicationPolicyDigest(content)
          )
            return fail();
          // Published governance is backed by the original independent review/approval,
          // not by a matching evidence ID or the caller's policy DTO.
          const provenance = rows(
            await tx.query(
              "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND lifecycle_id=$3 AND operation_code IN ('SubmitReview','Approve') ORDER BY lifecycle_version LIMIT 1025",
              [tenant, scope.brandReference, current.release.sourceLifecycleId],
            ),
          ).map((row) => {
            const mutation = normalize(row.mutation_json as CommitPublishingMutationInput);
            if (row.intent_hash !== digest(mutation)) return fail();
            return mutation;
          });
          const review = provenance.find(
            (m) =>
              m.operation === "SubmitReview" &&
              m.next.version === current.approvalEvidence.reviewVersion,
          );
          const approved = provenance.find(
            (m) =>
              m.operation === "Approve" &&
              m.next.version === current.approvalEvidence.reviewVersion + 1,
          );
          if (
            !review ||
            !approved ||
            review.audit.actor.type !== "User" ||
            approved.audit.actor.type !== "User" ||
            review.audit.actor.reference === approved.audit.actor.reference ||
            approved.audit.actor.reference !== current.approvalEvidence.approvedActorReference ||
            !equal(review.validationEvidence, current.validationEvidence) ||
            !equal(approved.approvalEvidence, current.approvalEvidence) ||
            review.next.snapshotReference !== reference ||
            review.next.snapshotDigest !== current.release.snapshotDigest ||
            review.next.familyReference !== content.familyReference ||
            approved.next.familyReference !== content.familyReference ||
            review.next.configurationType !== optionSetPolicyConfigurationType ||
            review.next.purposeCode !== optionSetPolicyConfigurationType ||
            approved.next.configurationType !== optionSetPolicyConfigurationType ||
            approved.next.purposeCode !== optionSetPolicyConfigurationType ||
            current.validationEvidence.validUntil <= current.release.createdAt ||
            current.approvalEvidence.validUntil <= current.release.createdAt ||
            current.validationEvidence.checkedAt > current.release.createdAt ||
            current.approvalEvidence.approvedAt > current.release.createdAt
          )
            return fail();
          return Object.freeze({ content, current, observedAt });
        });
      } catch {
        return fail();
      }
    },
    async commit(input: CommitPublishingMutationInput) {
      try {
        const value = normalize(input),
          { next, audit } = value;
        if (
          !samePublishingScope(next.scope, scope) ||
          (value.current !== null && !samePublishingScope(value.current.scope, scope)) ||
          audit.brandId !== scope.brandReference ||
          (audit.storeId ?? null) !== scope.storeReference ||
          audit.actor.type !== "User" ||
          audit.targetType !== "PublishingLifecycle" ||
          audit.targetId !== next.lifecycleId ||
          audit.dataClassification !== "Confidential" ||
          audit.actionCode !== auditActions[value.operation] ||
          audit.occurredAt < next.changedAt
        )
          return fail();
        const actorReference = audit.actor.reference;
        const intent = digest(value);
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenant, scope.brandReference, scope.storeReference ?? ""],
          );
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "PublishingOperation:" +
              tenant +
              ":" +
              scope.brandReference +
              ":" +
              value.idempotencyKey,
          ]);
          const original = rows(
            await tx.query(
              "SELECT mutation_json,intent_hash,audit_id FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND operation_id=$4",
              [...scoped, value.idempotencyKey],
            ),
          )[0];
          if (original) {
            const prior = normalize(original.mutation_json as CommitPublishingMutationInput);
            if (original.intent_hash !== intent || digest(prior) !== intent) return fail();
            return Object.freeze({ auditReference: parsePublishingReference(original.audit_id) });
          }
          await tx.query(
            "LOCK TABLE bop_publishing.publishing_mutation_record IN ROW EXCLUSIVE MODE",
            [],
          );
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "PublishingFamily:" +
              tenant +
              ":" +
              scope.brandReference +
              ":" +
              (scope.storeReference ?? "Brand") +
              ":" +
              next.familyReference,
          ]);
          const found = rows(
            await tx.query(
              "SELECT mutation_json FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND lifecycle_id=$4 ORDER BY lifecycle_version DESC LIMIT 1025",
              [...scoped, next.lifecycleId],
            ),
          );
          const history = found.map((r) =>
            normalize(r.mutation_json as CommitPublishingMutationInput),
          );
          const previous = history[0]?.next ?? null;
          if (
            !equal(previous, value.current) ||
            !evaluatePublishingTransition({
              operation: value.operation,
              expectedVersion: value.expectedVersion,
              current: previous,
              next,
            }).allowed
          )
            return fail();
          const expectedValidation =
            value.operation === "SubmitReview" ||
            value.operation === "Publish" ||
            value.operation === "Rollback";
          const expectedApproval =
            value.operation === "Approve" ||
            value.operation === "Publish" ||
            value.operation === "Rollback";
          if (
            (value.validationEvidence !== null) !== expectedValidation ||
            (value.approvalEvidence !== null) !== expectedApproval
          )
            return fail();
          for (const evidence of [value.validationEvidence, value.approvalEvidence]) {
            if (
              evidence !== null &&
              (!samePublishingScope(evidence.scope, scope) ||
                evidence.snapshotReference !== next.snapshotReference ||
                evidence.snapshotDigest !== next.snapshotDigest ||
                audit.occurredAt >= evidence.validUntil)
            )
              return fail();
          }
          if (
            value.validationEvidence &&
            (value.validationEvidence.checkedAt > audit.occurredAt ||
              value.validationEvidence.evidenceReference !== next.validationEvidenceReference)
          )
            return fail();
          if (
            value.approvalEvidence &&
            (value.approvalEvidence.approvedAt > audit.occurredAt ||
              value.approvalEvidence.evidenceReference !== next.approvalEvidenceReference ||
              value.approvalEvidence.reviewLifecycleId !== next.lifecycleId)
          )
            return fail();
          if (value.operation === "Approve") {
            if (
              value.approvalEvidence === null ||
              value.approvalEvidence.approvedActorReference !== actorReference ||
              value.approvalEvidence.reviewVersion !== previous?.version
            )
              return fail();
          }
          if (
            next.configurationType === optionSetPolicyConfigurationType &&
            value.operation === "Approve"
          ) {
            const review = history.find(
              (m) =>
                m.operation === "SubmitReview" &&
                m.next.version === value.approvalEvidence?.reviewVersion,
            );
            if (
              !review ||
              review.audit.actor.type !== "User" ||
              review.audit.actor.reference === actorReference
            )
              return fail();
          }
          if (value.operation === "Publish" || value.operation === "Rollback") {
            const submitted = history.find(
              (r) =>
                r.operation === "SubmitReview" &&
                r.next.validationEvidenceReference === next.validationEvidenceReference,
            );
            const approved = history.find(
              (r) =>
                r.operation === "Approve" &&
                r.next.approvalEvidenceReference === next.approvalEvidenceReference,
            );
            if (
              !submitted ||
              !approved ||
              !equal(submitted.validationEvidence, value.validationEvidence) ||
              !equal(approved.approvalEvidence, value.approvalEvidence)
            )
              return fail();
          }
          const release = value.release;
          if (
            (release !== null) !==
            (value.operation === "Publish" || value.operation === "Rollback")
          )
            return fail();
          if (release !== null) {
            const headRow = rows(
              await tx.query(
                "SELECT mutation_json FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND family_id=$4 AND release_id IS NOT NULL ORDER BY release_sequence DESC LIMIT 1",
                [...scoped, next.familyReference],
              ),
            )[0];
            const head = headRow
              ? normalize(headRow.mutation_json as CommitPublishingMutationInput).release
              : null;
            if (
              !samePublishingScope(release.scope, scope) ||
              release.familyReference !== next.familyReference ||
              release.configurationType !== next.configurationType ||
              release.purposeCode !== next.purposeCode ||
              release.sourceLifecycleId !== next.lifecycleId ||
              release.snapshotReference !== next.snapshotReference ||
              release.snapshotDigest !== next.snapshotDigest ||
              release.kind !== value.operation ||
              release.createdAt !== audit.occurredAt ||
              release.sequence !== (head?.sequence ?? 0) + 1 ||
              release.previousReleaseId !== (head?.releaseId ?? null) ||
              value.supersededReleaseId !== (head?.releaseId ?? null)
            )
              return fail();
            if (value.operation === "Rollback") {
              if (!head || value.rollbackTargetReleaseId === null) return fail();
              const targetRow = rows(
                await tx.query(
                  "SELECT mutation_json FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND family_id=$4 AND release_id=$5",
                  [...scoped, next.familyReference, value.rollbackTargetReleaseId],
                ),
              )[0];
              const target = targetRow
                ? normalize(targetRow.mutation_json as CommitPublishingMutationInput).release
                : null;
              if (
                !target ||
                target.sequence >= head.sequence ||
                target.createdAt >= release.createdAt ||
                target.snapshotReference !== release.snapshotReference ||
                target.snapshotDigest !== release.snapshotDigest
              )
                return fail();
            } else if (value.rollbackTargetReleaseId !== null) return fail();
          } else if (value.supersededReleaseId !== null || value.rollbackTargetReleaseId !== null)
            return fail();
          if (
            next.configurationType === productPolicyConfigurationType &&
            next.purposeCode === productPolicyConfigurationType &&
            value.operation === "CreateDraft"
          ) {
            if (scope.kind !== "Brand") return fail();
            await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
              "PublishingProductPolicy:" +
                tenant +
                ":" +
                scope.brandReference +
                ":" +
                next.snapshotReference,
            ]);
            const registered = rows(
              await tx.query(
                "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND operation_code='CreateDraft' AND mutation_json ? 'productPolicyContent' AND (mutation_json#>>'{next,snapshotReference}'=$3 OR family_id=$4) ORDER BY changed_at,lifecycle_version LIMIT 1025",
                [tenant, scope.brandReference, next.snapshotReference, next.familyReference],
              ),
            );
            if (registered.length > 1024) return fail();
            const policies = registered.map((r) => {
              const m = normalize(r.mutation_json as CommitPublishingMutationInput);
              if (r.intent_hash !== digest(m) || !m.productPolicyContent) return fail();
              return m.productPolicyContent;
            });
            const same = policies.filter((p) => p.policyReference === next.snapshotReference);
            if (
              same.some(
                (p) =>
                  p.familyReference !== next.familyReference ||
                  publishingProductPublicationPolicyDigest(p) !== next.snapshotDigest,
              )
            )
              return fail();
            const policy = value.productPolicyContent ?? same[0];
            if (!policy || policy.tenantReference !== tenant) return fail();
            if (same.length === 0) {
              const versions = policies
                .filter((p) => p.familyReference === next.familyReference)
                .map((p) => p.policyVersion);
              const max = versions.length === 0 ? 0 : Math.max(...versions);
              if (policy.policyVersion !== max + 1) return fail();
            }
          }
          if (
            next.configurationType === optionSetPolicyConfigurationType &&
            next.purposeCode === optionSetPolicyConfigurationType &&
            value.operation === "CreateDraft"
          ) {
            if (scope.kind !== "Brand") return fail();
            await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
              "PublishingOptionSetPolicy:" +
                tenant +
                ":" +
                scope.brandReference +
                ":" +
                next.snapshotReference,
            ]);
            const registered = rows(
              await tx.query(
                "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND operation_code='CreateDraft' AND (mutation_json#>>'{next,snapshotReference}'=$3 OR family_id=$4) ORDER BY changed_at,lifecycle_version LIMIT 1025",
                [tenant, scope.brandReference, next.snapshotReference, next.familyReference],
              ),
            );
            if (registered.length > 1024) return fail();
            const registrations = registered.map((r) => {
              const m = normalize(r.mutation_json as CommitPublishingMutationInput);
              if (
                r.intent_hash !== digest(m) ||
                m.next.configurationType !== optionSetPolicyConfigurationType ||
                m.next.purposeCode !== optionSetPolicyConfigurationType
              )
                return fail();
              return m;
            });
            const policies = registrations.flatMap((m) =>
              m.optionSetPolicyContent ? [m.optionSetPolicyContent] : [],
            );
            // A rollback lifecycle may reuse the immutable body without registering
            // it again. Its snapshot must still match an actual typed original.
            for (const m of registrations) {
              if (
                !m.optionSetPolicyContent &&
                !policies.some(
                  (p) =>
                    p.familyReference === m.next.familyReference &&
                    p.policyReference === m.next.snapshotReference &&
                    publishingOptionSetPublicationPolicyDigest(p) === m.next.snapshotDigest,
                )
              )
                return fail();
            }
            const same = policies.filter((p) => p.policyReference === next.snapshotReference);
            if (
              same.some(
                (p) =>
                  p.familyReference !== next.familyReference ||
                  publishingOptionSetPublicationPolicyDigest(p) !== next.snapshotDigest,
              )
            )
              return fail();
            const policy = value.optionSetPolicyContent ?? same[0];
            if (!policy || policy.tenantReference !== tenant) return fail();
            if (same.length === 0) {
              const versions = policies
                .filter((p) => p.familyReference === next.familyReference)
                .map((p) => p.policyVersion);
              const max = versions.length === 0 ? 0 : Math.max(...versions);
              if (policy.policyVersion !== max + 1) return fail();
            }
          }
          await appendAuditRecordInTransaction(tx, audit);
          await tx.query(
            "INSERT INTO bop_publishing.publishing_mutation_record (tenant_id,brand_id,store_id,family_id,lifecycle_id,lifecycle_version,operation_id,operation_code,actor_id,audit_id,intent_hash,release_id,release_sequence,changed_at,mutation_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)",
            [
              ...scoped,
              next.familyReference,
              next.lifecycleId,
              next.version,
              value.idempotencyKey,
              value.operation,
              actorReference,
              audit.auditId,
              intent,
              release?.releaseId ?? null,
              release?.sequence ?? null,
              next.changedAt,
              value,
            ],
          );
          return Object.freeze({ auditReference: parsePublishingReference(audit.auditId) });
        });
      } catch {
        return fail();
      }
    },
  });
}
