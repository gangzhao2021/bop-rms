import type { RecordedReleasedIndependentPublishingApproval } from "../../contracts/released-independent-approval-source.js";
import {
  parsePublishingOptionPricePublicationPolicy,
  publishingOptionPricePublicationPolicyDigest,
  optionPricePolicyConfigurationType,
  optionPriceRuleConfigurationType,
  optionPriceRulePublicationPurpose,
  type CurrentOptionPricePublicationPolicy,
  type OptionPriceRuleReviewHeldSource,
  type OptionPriceRuleReviewSourceResult,
} from "../../contracts/option-price-publication-policy.js";
import { parsePublishingOptionSetCurrentQualification } from "../../contracts/option-set-current-qualification.js";
import {
  parsePublishingOptionSetReviewPolicy,
  parsePublishingOptionSetApprovalWaiver,
  type PublishingOptionSetReviewPolicy,
  type PublishingOptionSetApprovalWaiver,
  type PublishingOptionSetCurrentRelease,
  type PublishingOptionSetReferencedCurrentRelease,
} from "../../contracts/option-set-approval-waiver.js";
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
  parsePublishingDigest,
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
  const priceDescriptor = Object.getOwnPropertyDescriptor(input, "optionPricePolicyContent");
  let pricePolicy;
  if (priceDescriptor) {
    if (
      !("value" in priceDescriptor) ||
      !priceDescriptor.enumerable ||
      input.operation !== "CreateDraft" ||
      descriptor ||
      optionDescriptor
    )
      return fail();
    pricePolicy = parsePublishingOptionPricePublicationPolicy(priceDescriptor.value);
    if (
      next.configurationType !== optionPricePolicyConfigurationType ||
      next.purposeCode !== optionPricePolicyConfigurationType ||
      next.scope.kind !== "Brand" ||
      pricePolicy.brandReference !== String(next.scope.brandReference) ||
      pricePolicy.familyReference !== next.familyReference ||
      pricePolicy.policyReference !== next.snapshotReference ||
      publishingOptionPricePublicationPolicyDigest(pricePolicy) !== next.snapshotDigest
    )
      return fail();
  }
  if (
    (next.configurationType === optionPricePolicyConfigurationType ||
      next.purposeCode === optionPricePolicyConfigurationType) &&
    (next.configurationType !== optionPricePolicyConfigurationType ||
      next.purposeCode !== optionPricePolicyConfigurationType ||
      next.scope.kind !== "Brand")
  )
    return fail();

  const qualificationDescriptor = Object.getOwnPropertyDescriptor(
    input,
    "optionSetCurrentQualification",
  );
  const qualification = qualificationDescriptor
    ? parsePublishingOptionSetCurrentQualification(
        "value" in qualificationDescriptor && qualificationDescriptor.enumerable
          ? qualificationDescriptor.value
          : null,
      )
    : undefined;
  if (
    qualification &&
    (input.operation !== "Publish" ||
      next.configurationType !== "CATALOG_OPTION_SET" ||
      next.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION" ||
      input.current === null ||
      qualification.operationReference !== input.idempotencyKey ||
      input.audit.actor.type !== "User" ||
      qualification.actorReference !== input.audit.actor.reference ||
      qualification.familyReference !== next.familyReference ||
      qualification.lifecycleReference !== next.lifecycleId ||
      qualification.expectedLifecycleVersion !== input.expectedVersion ||
      qualification.snapshotReference !== next.snapshotReference ||
      qualification.snapshotDigest !== next.snapshotDigest ||
      !samePublishingScope(qualification.scope, next.scope) ||
      qualification.validationEvidenceReference !== next.validationEvidenceReference ||
      qualification.approvalEvidenceReference !== next.approvalEvidenceReference ||
      qualification.checkedAt > input.audit.occurredAt ||
      qualification.validUntil <= input.audit.occurredAt)
  )
    return fail();
  const reviewDescriptor = Object.getOwnPropertyDescriptor(input, "optionSetReviewPolicy");
  const waiverDescriptor = Object.getOwnPropertyDescriptor(input, "optionSetApprovalWaiver");
  const reviewPolicy = reviewDescriptor
    ? parsePublishingOptionSetReviewPolicy(
        "value" in reviewDescriptor && reviewDescriptor.enumerable ? reviewDescriptor.value : null,
      )
    : undefined;
  const waiver = waiverDescriptor
    ? parsePublishingOptionSetApprovalWaiver(
        "value" in waiverDescriptor && waiverDescriptor.enumerable ? waiverDescriptor.value : null,
      )
    : undefined;
  if (
    reviewPolicy &&
    (input.operation !== "SubmitReview" ||
      !equal(reviewPolicy.reviewLifecycle, next) ||
      !equal(reviewPolicy.validationEvidence, input.validationEvidence) ||
      reviewPolicy.reviewOperationReference !== input.idempotencyKey ||
      reviewPolicy.submittedAt !== input.audit.occurredAt ||
      input.audit.actor.type !== "User" ||
      reviewPolicy.submittedActorReference !== input.audit.actor.reference)
  )
    return fail();
  if (waiver?.currentQualification && !equal(waiver.currentQualification, qualification))
    return fail();
  if (
    waiver &&
    (input.operation !== "Publish" ||
      !equal(waiver.reviewPolicy.reviewLifecycle, input.current) ||
      !equal(waiver.reviewPolicy.validationEvidence, input.validationEvidence) ||
      input.approvalEvidence !== null ||
      next.approvalEvidenceReference !== null ||
      waiver.recordedAt !== input.audit.occurredAt)
  )
    return fail();
  if (
    (next.configurationType === optionSetPolicyConfigurationType ||
      next.purposeCode === optionSetPolicyConfigurationType) &&
    (next.configurationType !== optionSetPolicyConfigurationType ||
      next.purposeCode !== optionSetPolicyConfigurationType ||
      next.scope.kind !== "Brand")
  )
    return fail();
  return Object.freeze({
    ...(qualification === undefined ? {} : { optionSetCurrentQualification: qualification }),
    ...(reviewPolicy === undefined ? {} : { optionSetReviewPolicy: reviewPolicy }),
    ...(waiver === undefined ? {} : { optionSetApprovalWaiver: waiver }),
    ...(policy === undefined ? {} : { productPolicyContent: policy }),
    ...(optionPolicy === undefined ? {} : { optionSetPolicyContent: optionPolicy }),
    ...(pricePolicy === undefined ? {} : { optionPricePolicyContent: pricePolicy }),
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
/** Detached owning record parsing; parsing alone does not prove persistence or permission. */
export function parseRecordedPublishingMutation(value: unknown): CommitPublishingMutationInput {
  let count = 0;
  function copy(input: unknown, depth: number): unknown {
    if (++count > 65536 || depth > 32) return fail();
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) return fail();
      return input;
    }
    if (
      !input ||
      typeof input !== "object" ||
      (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype)
    )
      return fail();
    const descriptors = Object.getOwnPropertyDescriptors(input),
      keys = Reflect.ownKeys(input);
    if (Array.isArray(input)) {
      if (keys.length !== input.length + 1) return fail();
      return Object.freeze(
        Array.from({ length: input.length }, (_, index) => {
          const d = descriptors[String(index)];
          if (!d?.enumerable || !("value" in d)) return fail();
          return copy(d.value, depth + 1);
        }),
      );
    }
    return Object.freeze(
      Object.fromEntries(
        keys.map((key) => {
          if (typeof key !== "string") return fail();
          const d = descriptors[key];
          if (!d?.enumerable || !("value" in d)) return fail();
          return [key, copy(d.value, depth + 1)];
        }),
      ),
    );
  }
  const detached = copy(value, 0);
  if (!detached || typeof detached !== "object" || Array.isArray(detached)) return fail();
  const fields = [
    "operation",
    "expectedVersion",
    "idempotencyKey",
    "current",
    "next",
    "release",
    "supersededReleaseId",
    "rollbackTargetReleaseId",
    "validationEvidence",
    "approvalEvidence",
    "audit",
    "optionSetCurrentQualification",
    "optionSetReviewPolicy",
    "optionSetApprovalWaiver",
    "optionSetPolicyContent",
    "optionPricePolicyContent",
    "productPolicyContent",
  ];
  if (Object.keys(detached).some((key) => !fields.includes(key))) return fail();
  return normalize(detached as CommitPublishingMutationInput);
}
/** Same canonical identity used by the owning mutation table; audit allocation is excluded. */
export function publishingRecordedMutationDigest(value: unknown) {
  return parsePublishingDigest(digest(parseRecordedPublishingMutation(value)));
}

export function createPostgresPublishingMutationStore(
  runner: PublishingTransactionRunner,
  tenantReference: string,
  scopeInput: PublishingScope,
  options?: Readonly<{ optionSetPolicyFamilyReference: string }>,
) {
  const tenant = parsePublishingReference(tenantReference),
    scope = createPublishingScope(scopeInput);
  const scoped = [tenant, scope.brandReference, scope.storeReference];
  const brandConfigurationRun = runner.run;
  // Server composition chooses this family. It is never request authorization or a SQL trust fact.
  const configuredFamily =
    options === undefined
      ? undefined
      : (() => {
          if (
            Object.getPrototypeOf(options) !== Object.prototype ||
            Reflect.ownKeys(options).length !== 1
          )
            return fail();
          const d = Object.getOwnPropertyDescriptor(options, "optionSetPolicyFamilyReference");
          return parsePublishingReference(d && "value" in d && d.enumerable ? d.value : null);
        })();
  const owner = (tx: PublishingTransaction) =>
    createPostgresPublishingMutationStore(
      { run: (work) => work(tx) },
      tenant,
      scope,
      configuredFamily === undefined
        ? undefined
        : { optionSetPolicyFamilyReference: configuredFamily },
    );
  async function protectedRun<T>(work: (tx: PublishingTransaction) => Promise<T>): Promise<T> {
    try {
      return await runner.run(work);
    } catch {
      return fail();
    }
  }
  function closedInput(input: unknown, fields: readonly string[]) {
    if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype)
      return fail();
    const d = Object.getOwnPropertyDescriptors(input),
      keys = Reflect.ownKeys(input);
    if (
      keys.length !== fields.length ||
      fields.some((k) => !Object.hasOwn(d, k)) ||
      keys.some(
        (k) =>
          typeof k !== "string" || !fields.includes(k) || !d[k]?.enumerable || !("value" in d[k]),
      )
    )
      return fail();
  }
  async function configuredPolicy(tx: PublishingTransaction, observedAt: string) {
    if (configuredFamily === undefined || scope.kind !== "Brand") return fail();
    const published = await owner(tx).resolveCurrentRelease({
      familyReference: configuredFamily,
      configurationType: optionSetPolicyConfigurationType,
      purposeCode: optionSetPolicyConfigurationType,
      observedAt,
    });
    const registered = rows(
      await tx.query(
        "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND operation_code='CreateDraft' AND mutation_json ? 'optionSetPolicyContent' AND mutation_json#>>'{next,snapshotReference}'=$3 ORDER BY changed_at,lifecycle_version LIMIT 1025",
        [tenant, scope.brandReference, published.release.snapshotReference],
      ),
    );
    if (!registered.length || registered.length > 1024) return fail();
    const bodies = registered.map((row) => {
      const m = normalize(row.mutation_json as CommitPublishingMutationInput);
      if (row.intent_hash !== digest(m) || !m.optionSetPolicyContent) return fail();
      return m.optionSetPolicyContent;
    });
    const content = bodies[0];
    if (!content || bodies.some((p) => !equal(p, content))) return fail();
    const held = await owner(tx).resolveCurrentOptionSetPublicationPolicy({
      policyReference: content.policyReference,
      policyVersion: content.policyVersion,
      observedAt,
    });
    if (held.content.familyReference !== configuredFamily) return fail();
    return held;
  }
  async function verifyOriginalReviewPolicy(
    tx: PublishingTransaction,
    binding: PublishingOptionSetReviewPolicy,
    originalReview: boolean,
  ) {
    if (
      scope.kind !== "Brand" ||
      binding.tenantReference !== tenant ||
      !samePublishingScope(binding.reviewLifecycle.scope, scope)
    )
      return fail();
    const row = rows(
      await tx.query(
        "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND release_id=$3",
        [tenant, scope.brandReference, binding.policyReleaseReference],
      ),
    );
    if (row.length !== 1 || !row[0]) return fail();
    const published = normalize(row[0].mutation_json as CommitPublishingMutationInput);
    const policy = binding.policyContent;
    const approval = published.approvalEvidence;
    const validation = published.validationEvidence;
    if (
      row[0].intent_hash !== digest(published) ||
      (published.operation !== "Publish" && published.operation !== "Rollback") ||
      published.next.state !== "Published" ||
      !published.release ||
      !approval ||
      !validation ||
      approval.decision !== "Accepted" ||
      validation.result !== "Pass" ||
      approval.reviewLifecycleId !== published.next.lifecycleId ||
      approval.reviewVersion !== (published.current?.version ?? 0) - 1 ||
      !samePublishingScope(approval.scope, scope) ||
      !samePublishingScope(validation.scope, scope) ||
      approval.snapshotReference !== policy.policyReference ||
      validation.snapshotReference !== policy.policyReference ||
      approval.snapshotDigest !== binding.policySnapshotDigest ||
      validation.snapshotDigest !== binding.policySnapshotDigest ||
      approval.evidenceReference !== published.next.approvalEvidenceReference ||
      validation.evidenceReference !== published.next.validationEvidenceReference ||
      published.next.configurationType !== optionSetPolicyConfigurationType ||
      published.next.purposeCode !== optionSetPolicyConfigurationType ||
      published.release.familyReference !== policy.familyReference ||
      published.release.sequence !== binding.policyReleaseSequence ||
      published.release.snapshotReference !== policy.policyReference ||
      published.release.snapshotDigest !== binding.policySnapshotDigest ||
      published.release.createdAt > binding.submittedAt ||
      validation.validUntil <= published.release.createdAt ||
      approval.validUntil <= published.release.createdAt ||
      validation.checkedAt > published.release.createdAt ||
      approval.approvedAt > published.release.createdAt ||
      !evaluatePublishingTransition({
        operation: published.operation,
        expectedVersion: published.expectedVersion,
        current: published.current,
        next: published.next,
      }).allowed
    )
      return fail();
    const provenance = rows(
      await tx.query(
        "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND lifecycle_id=$3 ORDER BY lifecycle_version LIMIT 1025",
        [tenant, scope.brandReference, published.next.lifecycleId],
      ),
    ).map((row) => {
      const m = normalize(row.mutation_json as CommitPublishingMutationInput);
      if (row.intent_hash !== digest(m)) return fail();
      return m;
    });
    // A later lifecycle may reuse an immutable body registered by this governing family.
    // Its independent review/approval still comes from the actual release lifecycle above.
    const publicationClock = published.release.createdAt;
    const registrations = rows(
      await tx.query(
        "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND family_id=$3 AND operation_code='CreateDraft' AND mutation_json ? 'optionSetPolicyContent' AND mutation_json#>>'{next,snapshotReference}'=$4 AND changed_at<=$5 ORDER BY changed_at,lifecycle_version LIMIT 1025",
        [
          tenant,
          scope.brandReference,
          policy.familyReference,
          policy.policyReference,
          publicationClock,
        ],
      ),
    )
      .map((row) => {
        const m = normalize(row.mutation_json as CommitPublishingMutationInput);
        if (
          row.intent_hash !== digest(m) ||
          !m.optionSetPolicyContent ||
          !equal(m.optionSetPolicyContent, policy) ||
          m.next.snapshotDigest !== binding.policySnapshotDigest
        )
          return fail();
        return m;
      })
      .filter((m) => m.audit.occurredAt <= publicationClock);
    const created = registrations[0];
    const reviewed = provenance.find(
      (m) => m.operation === "SubmitReview" && m.next.version === approval.reviewVersion,
    );
    const approved = provenance.find(
      (m) => m.operation === "Approve" && m.next.version === approval.reviewVersion + 1,
    );
    if (
      !created ||
      !reviewed ||
      !approved ||
      !equal(reviewed.validationEvidence, validation) ||
      !equal(approved.approvalEvidence, approval) ||
      reviewed.audit.actor.type !== "User" ||
      approved.audit.actor.type !== "User" ||
      reviewed.audit.actor.reference === approved.audit.actor.reference ||
      approved.audit.actor.reference !== approval.approvedActorReference ||
      !equal(approved.next, published.current) ||
      !samePublishingScope(policyScope(policy.brandReference), scope)
    )
      return fail();
    if (originalReview) {
      const found = rows(
        await tx.query(
          "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND operation_id=$3",
          [tenant, scope.brandReference, binding.reviewOperationReference],
        ),
      );
      if (found.length !== 1 || !found[0]) return fail();
      const review = normalize(found[0].mutation_json as CommitPublishingMutationInput);
      if (
        found[0].intent_hash !== digest(review) ||
        review.operation !== "SubmitReview" ||
        !equal(review.optionSetReviewPolicy, binding) ||
        !equal(review.next, binding.reviewLifecycle) ||
        !equal(review.validationEvidence, binding.validationEvidence) ||
        review.audit.actor.type !== "User" ||
        review.audit.actor.reference !== binding.submittedActorReference ||
        review.audit.occurredAt !== binding.submittedAt
      )
        return fail();
    }
  }
  function policyScope(brandReference: string) {
    return createPublishingScope({ kind: "Brand", brandReference, storeReference: null });
  }
  async function verifyHeldPolicy(
    tx: PublishingTransaction,
    binding: PublishingOptionSetReviewPolicy,
    observedAt: string,
  ) {
    const held = await configuredPolicy(tx, observedAt);
    if (
      !equal(held.content, binding.policyContent) ||
      held.current.release.releaseId !== binding.policyReleaseReference ||
      held.current.release.sequence !== binding.policyReleaseSequence ||
      held.current.release.snapshotDigest !== binding.policySnapshotDigest
    )
      return fail();
    await verifyOriginalReviewPolicy(tx, binding, false);
  }
  function qualificationHistory(
    value: CommitPublishingMutationInput,
    history: readonly CommitPublishingMutationInput[],
  ) {
    const q = value.optionSetCurrentQualification;
    if (!q || q.tenantReference !== tenant || !value.current) return fail();
    const latest = history[0],
      review = history.find(
        (m) => m.operation === "SubmitReview" && m.idempotencyKey === q.reviewOperationReference,
      ),
      approved =
        q.approvalOperationReference === null
          ? null
          : history.find(
              (m) => m.operation === "Approve" && m.idempotencyKey === q.approvalOperationReference,
            );
    if (
      !latest ||
      latest.idempotencyKey !== q.latestMutationOperationReference ||
      !equal(latest.next, value.current) ||
      !review?.optionSetReviewPolicy ||
      !review.validationEvidence ||
      review.validationEvidence.checkedAt > review.audit.occurredAt ||
      review.validationEvidence.validUntil <= review.audit.occurredAt ||
      !equal(review.validationEvidence, value.validationEvidence) ||
      review.next.lifecycleId !== q.lifecycleReference ||
      review.next.familyReference !== q.familyReference ||
      review.next.snapshotReference !== q.snapshotReference ||
      review.next.snapshotDigest !== q.snapshotDigest ||
      !equal([...review.validationEvidence.checkCodes].sort(), q.checkCodes) ||
      !samePublishingScope(review.next.scope, q.scope) ||
      review.audit.actor.type !== "User"
    )
      return fail();
    const binding = review.optionSetReviewPolicy;
    if (
      binding.policyContent.policyReference !== q.policyReference ||
      binding.policyContent.policyVersion !== q.policyVersion ||
      binding.policySnapshotDigest !== q.policyContentDigest ||
      binding.policyReleaseReference !== q.policyPublicationReference
    )
      return fail();
    if (q.approvalOperationReference === null) {
      if (
        !value.optionSetApprovalWaiver?.currentQualification ||
        !equal(value.optionSetApprovalWaiver.currentQualification, q) ||
        !equal(value.optionSetApprovalWaiver.reviewPolicy, binding) ||
        binding.policyContent.approvalPolicy !== "NotRequired" ||
        latest.idempotencyKey !== review.idempotencyKey ||
        value.current.state !== "InReview" ||
        value.approvalEvidence !== null
      )
        return fail();
    } else {
      if (
        value.optionSetApprovalWaiver ||
        !approved?.approvalEvidence ||
        approved.audit.actor.type !== "User" ||
        approved.audit.actor.reference === review.audit.actor.reference ||
        approved.audit.actor.reference !== approved.approvalEvidence.approvedActorReference ||
        approved.approvalEvidence.approvedAt > approved.audit.occurredAt ||
        approved.approvalEvidence.validUntil <= approved.audit.occurredAt ||
        approved.approvalEvidence.approvedAt < review.audit.occurredAt ||
        approved.approvalEvidence.reviewVersion !== review.next.version ||
        approved.approvalEvidence.reviewLifecycleId !== q.lifecycleReference ||
        approved.approvalEvidence.snapshotReference !== q.snapshotReference ||
        approved.approvalEvidence.snapshotDigest !== q.snapshotDigest ||
        !samePublishingScope(approved.approvalEvidence.scope, q.scope) ||
        !equal(approved.current, review.next) ||
        !equal(approved.next, value.current) ||
        !equal(approved.approvalEvidence, value.approvalEvidence) ||
        approved.approvalEvidence.evidenceReference !== q.approvalEvidenceReference ||
        latest.idempotencyKey !== approved.idempotencyKey ||
        value.current.state !== "Approved"
      )
        return fail();
    }
    return binding;
  }
  async function verifyRecordedQualification(
    tx: PublishingTransaction,
    value: CommitPublishingMutationInput,
  ) {
    if (!value.optionSetCurrentQualification) return;
    const found = rows(
      await tx.query(
        "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND lifecycle_id=$4 AND lifecycle_version <= $5 ORDER BY lifecycle_version DESC LIMIT 1025",
        [...scoped, value.next.lifecycleId, value.expectedVersion],
      ),
    );
    const history = found.map((row) => {
      const original = normalize(row.mutation_json as CommitPublishingMutationInput);
      if (
        row.intent_hash !== digest(original) ||
        original.next.lifecycleId !== value.next.lifecycleId ||
        !samePublishingScope(original.next.scope, scope)
      )
        return fail();
      return original;
    });
    const binding = qualificationHistory(value, history);
    await verifyOriginalReviewPolicy(tx, binding, value.optionSetApprovalWaiver !== undefined);
  }
  let brandConfigurationWriteActive = false,
    brandConfigurationWritePoisoned = false;
  return Object.freeze({
    /** Publishing admission only. The ordinary host retains the actual borrowed
     * transaction, current authority/reference guards and COMMIT finalization. */
    async withBrandConfigurationWrite<T>(
      input: Readonly<{ familyReference: string }>,
      work: (actualHeldTx: PublishingTransaction) => Promise<T>,
    ): Promise<T> {
      if (brandConfigurationWriteActive) {
        brandConfigurationWritePoisoned = true;
        return fail();
      }
      const familyReference = (() => {
          try {
            closedInput(input, ["familyReference"]);
            return parsePublishingReference(input.familyReference);
          } catch {
            return fail();
          }
        })(),
        run = brandConfigurationRun;
      if (
        scope.kind !== "Brand" ||
        String(familyReference) !== String(scope.brandReference) ||
        typeof work !== "function" ||
        typeof run !== "function" ||
        runner.run !== run ||
        brandConfigurationWritePoisoned
      )
        return fail();
      brandConfigurationWriteActive = true;
      let calls = 0,
        completed = false;
      try {
        const result = await run.call(runner, async (tx: PublishingTransaction) => {
          if (++calls !== 1) {
            brandConfigurationWritePoisoned = true;
            return fail();
          }
          const query = tx.query;
          const check = () => {
            if (
              !brandConfigurationWriteActive ||
              brandConfigurationWritePoisoned ||
              runner.run !== run ||
              tx.query !== query ||
              typeof query !== "function"
            )
              return fail();
          };
          check();
          const isolation = rows(
            await query.call(
              tx,
              "SELECT current_setting('transaction_isolation') AS isolation",
              [],
            ),
          );
          check();
          if (isolation.length !== 1 || isolation[0]?.isolation !== "read committed") return fail();
          await query.call(
            tx,
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenant, scope.brandReference],
          );
          check();
          await query.call(
            tx,
            "LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE ROW EXCLUSIVE MODE",
            [],
          );
          check();
          const value = await work(tx);
          check();
          completed = true;
          return value;
        });
        if (calls !== 1 || !completed || runner.run !== run || brandConfigurationWritePoisoned)
          return fail();
        return result as T;
      } catch {
        brandConfigurationWritePoisoned = true;
        return fail();
      } finally {
        brandConfigurationWriteActive = false;
      }
    },
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
              optionSetApprovalWaived: original.optionSetApprovalWaiver !== undefined,
              expectedVersion: original.expectedVersion,
              current: original.current,
              next: original.next,
            }).allowed
          )
            return fail();
          await verifyRecordedQualification(tx, original);
          if (original.optionSetApprovalWaiver)
            await verifyOriginalReviewPolicy(
              tx,
              original.optionSetApprovalWaiver.reviewPolicy,
              true,
            );
          if (original.optionSetReviewPolicy)
            await verifyOriginalReviewPolicy(tx, original.optionSetReviewPolicy, false);
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
              optionSetApprovalWaived: head.optionSetApprovalWaiver !== undefined,
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
    /** Recorded fixed Option Review identity, never current policy/qualification or a renewed lease.
     * Required InReview and expired historical evidence remain readable. The caller supplies
     * fresh actual authority and retains this shared owning source until outer COMMIT. */
    async resolveRecordedOptionSetReviewForLifecycle(
      input: Readonly<{ familyReference: string; lifecycleReference: string; observedAt: string }>,
    ) {
      closedInput(input, ["familyReference", "lifecycleReference", "observedAt"]);
      const family = parsePublishingReference(input.familyReference),
        lifecycle = parsePublishingReference(input.lifecycleReference),
        observedAt = parsePublishingInstant(input.observedAt);
      if (scope.kind !== "Brand") return fail();
      return protectedRun(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
          [tenant, scope.brandReference],
        );
        await tx.query("LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE MODE", []);
        const records = rows(
          await tx.query(
            "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND lifecycle_id=$3 ORDER BY lifecycle_version ASC LIMIT 1025",
            [tenant, scope.brandReference, lifecycle],
          ),
        );
        const history = records.map((row) => {
          const m = parseRecordedPublishingMutation(row.mutation_json);
          if (
            row.intent_hash !== digest(m) ||
            m.next.familyReference !== family ||
            m.next.lifecycleId !== lifecycle ||
            m.next.configurationType !== "CATALOG_OPTION_SET" ||
            m.next.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION" ||
            !samePublishingScope(m.next.scope, scope) ||
            m.audit.brandId !== scope.brandReference ||
            (m.audit.storeId ?? null) !== null ||
            m.audit.actor.type !== "User" ||
            m.audit.targetType !== "PublishingLifecycle" ||
            m.audit.targetId !== lifecycle ||
            m.audit.actionCode !== auditActions[m.operation] ||
            m.audit.occurredAt > observedAt ||
            m.audit.occurredAt < m.next.changedAt ||
            m.next.changedAt > observedAt
          )
            return fail();
          return m;
        });
        let previous: CommitPublishingMutationInput | null = null;
        for (const m of history) {
          if (
            (previous !== null &&
              (m.next.changedAt < previous.next.changedAt ||
                m.audit.occurredAt < previous.audit.occurredAt)) ||
            !equal(m.current, previous?.next ?? null) ||
            m.next.version !== (previous?.next.version ?? 0) + 1 ||
            !evaluatePublishingTransition({
              operation: m.operation,
              optionSetApprovalWaived: m.optionSetApprovalWaiver !== undefined,
              expectedVersion: m.expectedVersion,
              current: m.current,
              next: m.next,
            }).allowed
          )
            return fail();
          previous = m;
        }
        const latest = history[history.length - 1],
          reviews = history.filter((m) => m.operation === "SubmitReview");
        if (!latest || reviews.length === 0) return null;
        if (reviews.length !== 1) return fail();
        const review = reviews[0];
        if (
          !review ||
          review.audit.actor.type !== "User" ||
          review.next.state !== "InReview" ||
          !review.validationEvidence
        )
          return fail();
        const validation = review.validationEvidence;
        if (
          validation.result !== "Pass" ||
          validation.evidenceReference !== review.next.validationEvidenceReference ||
          validation.snapshotReference !== review.next.snapshotReference ||
          validation.snapshotDigest !== review.next.snapshotDigest ||
          !samePublishingScope(validation.scope, scope) ||
          validation.checkedAt > review.audit.occurredAt ||
          validation.validUntil <= review.audit.occurredAt ||
          latest.next.snapshotReference !== review.next.snapshotReference ||
          latest.next.snapshotDigest !== review.next.snapshotDigest ||
          latest.next.validationEvidenceReference !== validation.evidenceReference
        )
          return fail();
        const approvals = history.filter((m) => m.operation === "Approve");
        if (approvals.length > 1) return fail();
        const approval = approvals[0];
        if (approval) {
          const evidence = approval.approvalEvidence;
          if (
            !evidence ||
            approval.audit.actor.type !== "User" ||
            approval.audit.actor.reference === review.audit.actor.reference ||
            evidence.decision !== "Accepted" ||
            evidence.approvedActorReference !== approval.audit.actor.reference ||
            evidence.reviewLifecycleId !== lifecycle ||
            evidence.reviewVersion !== review.next.version ||
            evidence.evidenceReference !== approval.next.approvalEvidenceReference ||
            evidence.snapshotReference !== review.next.snapshotReference ||
            evidence.snapshotDigest !== review.next.snapshotDigest ||
            !samePublishingScope(evidence.scope, scope) ||
            evidence.approvedAt < review.audit.occurredAt ||
            evidence.approvedAt > approval.audit.occurredAt ||
            evidence.validUntil <= approval.audit.occurredAt ||
            !equal(approval.current, review.next)
          )
            return fail();
        }
        return Object.freeze({
          profile: "RecordedOptionSetReviewForLifecycleV1" as const,
          reviewOperationReference: review.idempotencyKey,
          reviewLifecycle: review.next,
          submittedActorReference: review.audit.actor.reference,
          submittedAt: review.audit.occurredAt,
          originalValidationEvidence: validation,
          reviewPolicy: review.optionSetReviewPolicy ?? null,
          latestLifecycle: latest.next,
          latestMutationOperationReference: latest.idempotencyKey,
          approvalOperationReference: approval?.idempotencyKey ?? null,
          originalApprovalEvidence: approval?.approvalEvidence ?? null,
          observedAt,
          sourceLease: "RequiresCurrentOuterTransactionAuthority" as const,
        });
      });
    },
    /** Fixed Option candidate: original decisions are historical facts, not a
     * renewed lease. Caller must hold fresh current authorization/source guards. */
    async resolveCurrentOptionSetPublicationCandidate(
      input: Readonly<{ familyReference: string; lifecycleReference: string; observedAt: string }>,
    ) {
      closedInput(input, ["familyReference", "lifecycleReference", "observedAt"]);
      const family = parsePublishingReference(input.familyReference),
        lifecycle = parsePublishingReference(input.lifecycleReference),
        observedAt = parsePublishingInstant(input.observedAt);
      if (scope.kind !== "Brand") return fail();
      return protectedRun(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
          [tenant, scope.brandReference],
        );
        await tx.query(
          "LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE ROW EXCLUSIVE MODE",
          [],
        );
        const found = rows(
          await tx.query(
            "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND lifecycle_id=$3 ORDER BY lifecycle_version DESC LIMIT 1025",
            [tenant, scope.brandReference, lifecycle],
          ),
        );
        const history = found.map((row) => {
          const original = normalize(row.mutation_json as CommitPublishingMutationInput);
          if (
            row.intent_hash !== digest(original) ||
            original.next.familyReference !== family ||
            original.next.lifecycleId !== lifecycle ||
            original.next.configurationType !== "CATALOG_OPTION_SET" ||
            original.next.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION" ||
            !samePublishingScope(original.next.scope, scope) ||
            original.audit.occurredAt > observedAt
          )
            return fail();
          return original;
        });
        const latest = history[0],
          review = history.find((m) => m.operation === "SubmitReview");
        if (
          !latest ||
          !review?.optionSetReviewPolicy ||
          !review.validationEvidence ||
          review.validationEvidence.checkedAt > review.audit.occurredAt ||
          review.validationEvidence.validUntil <= review.audit.occurredAt ||
          review.audit.actor.type !== "User"
        )
          return fail();
        const approval = latest.operation === "Approve" ? latest.approvalEvidence : null;
        if (approval) {
          if (
            latest.next.state !== "Approved" ||
            latest.audit.actor.type !== "User" ||
            latest.audit.actor.reference === review.audit.actor.reference ||
            latest.audit.actor.reference !== approval.approvedActorReference ||
            approval.approvedAt > latest.audit.occurredAt ||
            approval.validUntil <= latest.audit.occurredAt ||
            approval.approvedAt < review.audit.occurredAt ||
            !equal(latest.current, review.next) ||
            approval.reviewVersion !== review.next.version ||
            approval.reviewLifecycleId !== lifecycle ||
            approval.evidenceReference !== latest.next.approvalEvidenceReference ||
            approval.snapshotReference !== latest.next.snapshotReference ||
            approval.snapshotDigest !== latest.next.snapshotDigest ||
            !samePublishingScope(approval.scope, scope)
          )
            return fail();
        } else if (
          latest.operation !== "SubmitReview" ||
          latest.next.state !== "InReview" ||
          review.optionSetReviewPolicy.policyContent.approvalPolicy !== "NotRequired"
        )
          return fail();
        if (
          latest.next.snapshotReference !== review.next.snapshotReference ||
          latest.next.snapshotDigest !== review.next.snapshotDigest ||
          latest.next.validationEvidenceReference !== review.validationEvidence.evidenceReference
        )
          return fail();
        await verifyHeldPolicy(tx, review.optionSetReviewPolicy, observedAt);
        const predecessor = rows(
          await tx.query(
            "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND family_id=$3 AND release_id IS NOT NULL ORDER BY release_sequence DESC LIMIT 1",
            [tenant, scope.brandReference, family],
          ),
        );
        const row = predecessor[0];
        let previousRelease: ReturnType<typeof createPublishingReleaseRecord> | null = null;
        if (row) {
          const prior = normalize(row.mutation_json as CommitPublishingMutationInput);
          if (
            row.intent_hash !== digest(prior) ||
            !prior.release ||
            prior.release.createdAt > observedAt
          )
            return fail();
          previousRelease = prior.release;
        }
        return Object.freeze({
          profile: "CurrentOptionSetPublicationCandidateV1" as const,
          lifecycle: latest.next,
          latestMutationOperationReference: latest.idempotencyKey,
          reviewOperationReference: review.idempotencyKey,
          approvalOperationReference: approval ? latest.idempotencyKey : null,
          originalValidationEvidence: review.validationEvidence,
          originalApprovalEvidence: approval,
          reviewPolicy: review.optionSetReviewPolicy,
          previousRelease,
          observedAt,
          sourceLease: "RequiresCurrentOuterTransactionAuthority" as const,
        });
      });
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
    /** Recorded independence behind the actual current Published release. Authorize
     * separately and bind the runner to the caller UoW; its existing release SHARE
     * fence is retained. Historical business deadlines are checked at the original
     * Approve/Publish instants, never renewed or required to remain live today. */
    async resolveCurrentReleaseIndependentApproval(
      value: unknown,
    ): Promise<RecordedReleasedIndependentPublishingApproval> {
      try {
        const input = parseIndependentPublishingApprovalRequest(value);
        return await runner.run(async (tx) => {
          const owner = createPostgresPublishingMutationStore(
            { run: (work) => work(tx) },
            tenant,
            scope,
          );
          const currentRelease = await owner.resolveCurrentRelease({
            familyReference: input.familyReference,
            configurationType: input.configurationType,
            purposeCode: input.purposeCode,
            observedAt: input.observedAt,
          });
          const released = currentRelease.lifecycle;
          if (
            released.lifecycleId !== input.lifecycleReference ||
            released.snapshotReference !== input.snapshotReference ||
            released.snapshotDigest !== input.snapshotDigest ||
            currentRelease.release.sourceLifecycleId !== input.lifecycleReference ||
            currentRelease.release.snapshotReference !== input.snapshotReference ||
            currentRelease.release.snapshotDigest !== input.snapshotDigest ||
            released.version !== 4
          )
            return fail();
          // Only the actual Create1/Submit2/Approve3/Publish4 chain is supported.
          // The original creator and submitter retain separate actor identities.
          const history = rows(
            await tx.query(
              "SELECT mutation_json,intent_hash,audit_id FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND lifecycle_id=$4 AND lifecycle_version <= $5 ORDER BY lifecycle_version ASC LIMIT 5",
              [...scoped, input.lifecycleReference, released.version],
            ),
          );
          if (history.length !== 4) return fail();
          const normalized = history.map((row, index) => {
            const m = normalize(row.mutation_json as CommitPublishingMutationInput);
            const a = m.audit,
              n = m.next;
            if (
              row.intent_hash !== digest(m) ||
              row.audit_id !== a.auditId ||
              n.version !== index + 1 ||
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
              !evaluatePublishingTransition({
                operation: m.operation,
                expectedVersion: m.expectedVersion,
                current: m.current,
                next: n,
              }).allowed
            )
              return fail();
            return m;
          });
          const [created, reviewed, approved, published] = normalized;
          if (!created || !reviewed || !approved || !published) return fail();
          for (let i = 0; i < normalized.length; i++) {
            const m = normalized[i],
              previous = normalized[i - 1];
            if (
              !m ||
              (i === 0
                ? m.current !== null
                : !previous ||
                  !equal(m.current, previous.next) ||
                  m.audit.occurredAt < previous.audit.occurredAt)
            )
              return fail();
            if (
              i < normalized.length - 3 &&
              (m.operation !== "CreateDraft" ||
                m.next.state !== "Draft" ||
                m.validationEvidence !== null ||
                m.approvalEvidence !== null)
            )
              return fail();
            if (
              i < normalized.length - 1 &&
              (m.release !== null ||
                m.supersededReleaseId !== null ||
                m.rollbackTargetReleaseId !== null)
            )
              return fail();
          }
          const validation = reviewed.validationEvidence,
            approval = approved.approvalEvidence;
          if (
            reviewed.operation !== "SubmitReview" ||
            reviewed.next.state !== "InReview" ||
            reviewed.approvalEvidence !== null ||
            approved.operation !== "Approve" ||
            approved.next.state !== "Approved" ||
            approved.validationEvidence !== null ||
            published.operation !== "Publish" ||
            !equal(published.next, released) ||
            !equal(published.release, currentRelease.release) ||
            published.audit.auditId !== currentRelease.auditReference ||
            validation === null ||
            approval === null ||
            !equal(validation, currentRelease.validationEvidence) ||
            !equal(approval, currentRelease.approvalEvidence) ||
            !equal(published.validationEvidence, validation) ||
            !equal(published.approvalEvidence, approval) ||
            created.audit.actor.type !== "User" ||
            reviewed.audit.actor.type !== "User" ||
            approved.audit.actor.type !== "User" ||
            created.audit.actor.reference === approved.audit.actor.reference ||
            reviewed.audit.actor.reference === approved.audit.actor.reference ||
            approval.approvedActorReference !== approved.audit.actor.reference ||
            approval.reviewLifecycleId !== input.lifecycleReference ||
            approval.reviewVersion !== reviewed.next.version ||
            approved.next.version !== released.version - 1 ||
            validation.evidenceReference !== reviewed.next.validationEvidenceReference ||
            validation.evidenceReference !== approved.next.validationEvidenceReference ||
            approval.evidenceReference !== approved.next.approvalEvidenceReference ||
            validation.snapshotReference !== input.snapshotReference ||
            validation.snapshotDigest !== input.snapshotDigest ||
            approval.snapshotReference !== input.snapshotReference ||
            approval.snapshotDigest !== input.snapshotDigest ||
            !samePublishingScope(validation.scope, scope) ||
            !samePublishingScope(approval.scope, scope) ||
            validation.checkedAt > reviewed.audit.occurredAt ||
            validation.validUntil <= reviewed.audit.occurredAt ||
            validation.validUntil <= approved.audit.occurredAt ||
            approval.approvedAt < reviewed.audit.occurredAt ||
            approval.approvedAt > approved.audit.occurredAt ||
            approval.validUntil <= approved.audit.occurredAt ||
            validation.validUntil <= currentRelease.release.createdAt ||
            approval.validUntil <= currentRelease.release.createdAt ||
            validation.validUntil <= published.audit.occurredAt ||
            approval.validUntil <= published.audit.occurredAt ||
            approval.approvedAt > currentRelease.release.createdAt ||
            validation.checkedAt > currentRelease.release.createdAt ||
            currentRelease.release.createdAt !== published.next.changedAt ||
            currentRelease.release.kind !== published.operation ||
            !equal([...validation.checkCodes].sort(), input.requiredCheckCodes)
          )
            return fail();
          const body = Object.freeze({
            profile: "RecordedReleasedIndependentPublishingApprovalV1" as const,
            tenantReference: tenant,
            scope,
            familyReference: input.familyReference,
            lifecycleReference: input.lifecycleReference,
            configurationType: input.configurationType,
            purposeCode: input.purposeCode,
            snapshotReference: input.snapshotReference,
            snapshotDigest: input.snapshotDigest,
            currentRelease,
            approvedLifecycleVersion: approved.next.version,
            reviewVersion: reviewed.next.version,
            draftOperationReference: created.idempotencyKey,
            reviewOperationReference: reviewed.idempotencyKey,
            approvalOperationReference: approved.idempotencyKey,
            authoredByActorReference: parsePublishingReference(created.audit.actor.reference),
            requestedByActorReference: parsePublishingReference(reviewed.audit.actor.reference),
            approvedByActorReference: approval.approvedActorReference,
            validationEvidenceReference: validation.evidenceReference,
            approvalEvidenceReference: approval.evidenceReference,
            validationCheckCodes: Object.freeze([...validation.checkCodes].sort()),
            observedAt: input.observedAt,
            sourceDigest: parsePublishingDigest(
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
            ),
            recordedIndependence: "Verified" as const,
            currentValidation: "NotEvaluated" as const,
            referenceEligibility: "NotEvaluated" as const,
            eligibility: "NotEvaluated" as const,
          });
          return Object.freeze({
            ...body,
            digest: parsePublishingDigest("sha256:" + sha256Hex(canonicalizeRfc8785(body))),
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
    /** Prepare from the configured actual governance source; caller authorizes and retains this outer transaction. */
    async resolveOptionSetReviewPolicy(
      input: Readonly<{
        reviewOperationReference: string;
        reviewLifecycle: unknown;
        validationEvidence: unknown;
        submittedActorReference: string;
        submittedAt: string;
      }>,
    ): Promise<PublishingOptionSetReviewPolicy> {
      closedInput(input, [
        "reviewOperationReference",
        "reviewLifecycle",
        "validationEvidence",
        "submittedActorReference",
        "submittedAt",
      ]);
      const at = parsePublishingInstant(input.submittedAt);
      return protectedRun(async (tx) => {
        const held = await configuredPolicy(tx, at);
        return parsePublishingOptionSetReviewPolicy({
          profile: "PublishingOptionSetReviewPolicyV1",
          tenantReference: tenant,
          policyContent: held.content,
          policyReleaseReference: held.current.release.releaseId,
          policyReleaseSequence: held.current.release.sequence,
          policySnapshotDigest: held.current.release.snapshotDigest,
          reviewOperationReference: input.reviewOperationReference,
          reviewLifecycle: input.reviewLifecycle,
          validationEvidence: input.validationEvidence,
          submittedActorReference: input.submittedActorReference,
          submittedAt: at,
        });
      });
    },
    async resolveOptionSetApprovalWaiver(
      input: Readonly<{ familyReference: string; lifecycleReference: string; observedAt: string }>,
    ): Promise<PublishingOptionSetApprovalWaiver> {
      closedInput(input, ["familyReference", "lifecycleReference", "observedAt"]);
      const at = parsePublishingInstant(input.observedAt);
      return protectedRun(async (tx) => {
        const review = await owner(tx).resolveCurrentLifecycleMutation({
          familyReference: input.familyReference,
          lifecycleReference: input.lifecycleReference,
          configurationType: "CATALOG_OPTION_SET",
          purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
          observedAt: at,
        });
        if (!review || review.operation !== "SubmitReview" || !review.optionSetReviewPolicy)
          return fail();
        await verifyOriginalReviewPolicy(tx, review.optionSetReviewPolicy, true);
        await verifyHeldPolicy(tx, review.optionSetReviewPolicy, at);
        return parsePublishingOptionSetApprovalWaiver({
          profile: "PublishingOptionSetApprovalWaiverV1",
          reviewPolicy: review.optionSetReviewPolicy,
          recordedAt: at,
        });
      });
    },
    /** Publication presence only; absence is confirmed by owning SQL, never by
     * catching a failed qualification. Bind the runner to the authorized host. */
    async resolveCurrentOptionSetPublicationStatus(
      input: Readonly<{ familyReference: string; observedAt: string }>,
    ): Promise<
      | Readonly<{
          outcome: "Absent";
          latestRecordedLifecycle: CommitPublishingMutationInput["next"] | null;
          lastReleaseReference: null;
          observedAt: string;
        }>
      | Readonly<{
          outcome: "NotCurrentlyPublished";
          lifecycle: CommitPublishingMutationInput["next"];
          lastReleaseReference: string;
          observedAt: string;
        }>
      | Readonly<{
          outcome: "Published";
          proof: PublishingOptionSetCurrentRelease;
          observedAt: string;
        }>
    > {
      closedInput(input, ["familyReference", "observedAt"]);
      const family = parsePublishingReference(input.familyReference),
        at = parsePublishingInstant(input.observedAt);
      if (scope.kind !== "Brand") return fail();
      return protectedRun(async (tx) => {
        const queryPort = tx.query;
        const query = async (sql: string, values: readonly unknown[]) => {
          if (tx.query !== queryPort) return fail();
          const result = await queryPort.call(tx, sql, values);
          if (tx.query !== queryPort) return fail();
          return result;
        };
        await query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
          [tenant, scope.brandReference],
        );
        await query("LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE MODE", []);
        await query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
          "PublishingFamily:" + tenant + ":" + scope.brandReference + ":Brand:" + family,
        ]);
        const select =
          "SELECT tenant_id,brand_id,store_id,family_id,lifecycle_id,lifecycle_version::text,operation_id,operation_code,actor_id,audit_id,intent_hash,release_id,release_sequence::text,to_char(changed_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') changed_at,mutation_json FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND family_id=$3";
        const statusRows = (result: unknown) => {
          const found = rows(result);
          if (
            Object.getPrototypeOf(found) !== Array.prototype ||
            found.length > 1 ||
            Reflect.ownKeys(found).length !== found.length + 1
          )
            return fail();
          return Array.from({ length: found.length }, (_, index) => {
            const descriptor = Object.getOwnPropertyDescriptor(found, String(index));
            if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
            const row: unknown = descriptor.value;
            closedInput(row, [
              "tenant_id",
              "brand_id",
              "store_id",
              "family_id",
              "lifecycle_id",
              "lifecycle_version",
              "operation_id",
              "operation_code",
              "actor_id",
              "audit_id",
              "intent_hash",
              "release_id",
              "release_sequence",
              "changed_at",
              "mutation_json",
            ]);
            return Object.freeze(
              Object.fromEntries(
                Object.entries(Object.getOwnPropertyDescriptors(row)).map(([key, d]) => [
                  key,
                  d.value,
                ]),
              ),
            );
          });
        };
        const decode = (row: Record<string, unknown>) => {
          closedInput(row, [
            "tenant_id",
            "brand_id",
            "store_id",
            "family_id",
            "lifecycle_id",
            "lifecycle_version",
            "operation_id",
            "operation_code",
            "actor_id",
            "audit_id",
            "intent_hash",
            "release_id",
            "release_sequence",
            "changed_at",
            "mutation_json",
          ]);
          const m = parseRecordedPublishingMutation(row.mutation_json),
            next = m.next;
          const actorReference = m.audit.actor.type === "System" ? null : m.audit.actor.reference;
          if (
            row.tenant_id !== tenant ||
            row.brand_id !== scope.brandReference ||
            row.store_id !== null ||
            row.family_id !== family ||
            row.lifecycle_id !== next.lifecycleId ||
            row.lifecycle_version !== String(next.version) ||
            row.operation_id !== m.idempotencyKey ||
            row.operation_code !== m.operation ||
            row.actor_id !== actorReference ||
            row.audit_id !== m.audit.auditId ||
            row.intent_hash !== digest(m) ||
            row.changed_at !== next.changedAt ||
            row.release_id !== (m.release?.releaseId ?? null) ||
            row.release_sequence !== (m.release === null ? null : String(m.release.sequence)) ||
            next.familyReference !== family ||
            next.configurationType !== "CATALOG_OPTION_SET" ||
            next.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION" ||
            !samePublishingScope(next.scope, scope) ||
            (m.current !== null && !samePublishingScope(m.current.scope, scope)) ||
            next.changedAt > at ||
            m.audit.occurredAt > at ||
            m.audit.occurredAt < next.changedAt ||
            m.audit.brandId !== scope.brandReference ||
            (m.audit.storeId ?? null) !== null ||
            m.audit.targetType !== "PublishingLifecycle" ||
            m.audit.targetId !== next.lifecycleId ||
            m.audit.actionCode !== auditActions[m.operation] ||
            m.audit.dataClassification !== "Confidential" ||
            !evaluatePublishingTransition({
              operation: m.operation,
              optionSetApprovalWaived: m.optionSetApprovalWaiver !== undefined,
              expectedVersion: m.expectedVersion,
              current: m.current,
              next,
            }).allowed
          )
            return fail();
          if (
            m.release !== null &&
            (m.release.familyReference !== family ||
              m.release.sourceLifecycleId !== next.lifecycleId ||
              m.release.configurationType !== next.configurationType ||
              m.release.purposeCode !== next.purposeCode ||
              m.release.snapshotReference !== next.snapshotReference ||
              m.release.snapshotDigest !== next.snapshotDigest ||
              !samePublishingScope(m.release.scope, scope) ||
              m.release.createdAt > at)
          )
            return fail();
          return m;
        };
        const familyRows = statusRows(
          await query(
            select + " ORDER BY changed_at DESC,lifecycle_version DESC,operation_id DESC LIMIT 1",
            [tenant, scope.brandReference, family],
          ),
        );
        if (familyRows.length > 1) return fail();
        const latestFamily = familyRows[0] ? decode(familyRows[0]) : null;
        const releaseRows = statusRows(
          await query(
            select + " AND release_id IS NOT NULL ORDER BY release_sequence DESC LIMIT 1",
            [tenant, scope.brandReference, family],
          ),
        );
        if (releaseRows.length > 1) return fail();
        const releaseRow = releaseRows[0];
        if (!releaseRow)
          return Object.freeze({
            outcome: "Absent" as const,
            latestRecordedLifecycle: latestFamily?.next ?? null,
            lastReleaseReference: null,
            observedAt: at,
          });
        if (!latestFamily) return fail();
        const head = decode(releaseRow),
          release = head.release;
        if (!release || head.next.state !== "Published") return fail();
        const lifecycle = await owner(tx).resolveCurrentLifecycleMutation({
          familyReference: family,
          lifecycleReference: release.sourceLifecycleId,
          configurationType: "CATALOG_OPTION_SET",
          purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
          observedAt: at,
        });
        if (
          !lifecycle ||
          lifecycle.next.version < head.next.version ||
          (lifecycle.next.version === head.next.version && !equal(lifecycle.next, head.next)) ||
          tx.query !== queryPort
        )
          return fail();
        if (lifecycle.next.state !== "Published") {
          if (lifecycle.next.state !== "Archived" && lifecycle.next.state !== "Superseded")
            return fail();
          await verifyRecordedQualification(tx, head);
          return Object.freeze({
            outcome: "NotCurrentlyPublished" as const,
            lifecycle: lifecycle.next,
            lastReleaseReference: release.releaseId,
            observedAt: at,
          });
        }
        const proof = await owner(tx).resolveCurrentOptionSetRelease({
          familyReference: family,
          observedAt: at,
        });
        if (
          tx.query !== queryPort ||
          !equal(proof.release, release) ||
          !equal(proof.lifecycle, lifecycle.next)
        )
          return fail();
        return Object.freeze({ outcome: "Published" as const, proof, observedAt: at });
      });
    },
    async resolveCurrentOptionSetRelease(
      input: Readonly<{ familyReference: string; observedAt: string }>,
    ): Promise<PublishingOptionSetCurrentRelease> {
      closedInput(input, ["familyReference", "observedAt"]);
      const family = parsePublishingReference(input.familyReference),
        at = parsePublishingInstant(input.observedAt);
      if (scope.kind !== "Brand") return fail();
      return protectedRun(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
          [tenant, scope.brandReference],
        );
        await tx.query("LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE MODE", []);
        const found = rows(
          await tx.query(
            "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND family_id=$3 AND release_id IS NOT NULL ORDER BY release_sequence DESC LIMIT 1",
            [tenant, scope.brandReference, family],
          ),
        );
        const row = found[0];
        if (!row) return fail();
        const head = normalize(row.mutation_json as CommitPublishingMutationInput);
        await verifyRecordedQualification(tx, head);
        if (!head.optionSetApprovalWaiver) {
          const proof = await owner(tx).resolveCurrentRelease({
            familyReference: family,
            configurationType: "CATALOG_OPTION_SET",
            purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
            observedAt: at,
          });
          return Object.freeze({
            ...proof,
            approvalDisposition: "Approved" as const,
            waiver: null,
          });
        }
        const release = head.release;
        if (
          row.intent_hash !== digest(head) ||
          !release ||
          head.operation !== "Publish" ||
          release.familyReference !== family ||
          release.configurationType !== "CATALOG_OPTION_SET" ||
          release.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION" ||
          head.next.state !== "Published" ||
          !samePublishingScope(head.next.scope, scope) ||
          release.createdAt > at ||
          release.sourceLifecycleId !== head.next.lifecycleId ||
          release.snapshotReference !== head.next.snapshotReference ||
          release.snapshotDigest !== head.next.snapshotDigest ||
          !samePublishingScope(release.scope, scope) ||
          !head.validationEvidence ||
          head.approvalEvidence !== null ||
          head.audit.occurredAt !== head.optionSetApprovalWaiver.recordedAt ||
          release.createdAt !== head.audit.occurredAt ||
          !evaluatePublishingTransition({
            operation: head.operation,
            expectedVersion: head.expectedVersion,
            current: head.current,
            next: head.next,
            optionSetApprovalWaived: true,
          }).allowed
        )
          return fail();
        const latest = await owner(tx).resolveCurrentLifecycleMutation({
          familyReference: family,
          lifecycleReference: release.sourceLifecycleId,
          configurationType: "CATALOG_OPTION_SET",
          purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
          observedAt: at,
        });
        if (!latest || !equal(latest.next, head.next)) return fail();
        await verifyOriginalReviewPolicy(tx, head.optionSetApprovalWaiver.reviewPolicy, true);
        return Object.freeze({
          release,
          lifecycle: head.next,
          validationEvidence: head.validationEvidence,
          approvalEvidence: null,
          approvalDisposition: "PolicyWaived" as const,
          waiver: head.optionSetApprovalWaiver,
          auditReference: parsePublishingReference(head.audit.auditId),
          observedAt: at,
        });
      });
    },
    async resolveCurrentOptionSetReleaseForReference(
      input: Readonly<{ publicationReference: string; observedAt: string }>,
    ): Promise<PublishingOptionSetReferencedCurrentRelease> {
      closedInput(input, ["publicationReference", "observedAt"]);
      const publication = parsePublishingReference(input.publicationReference),
        at = parsePublishingInstant(input.observedAt);
      if (scope.kind !== "Brand") return fail();
      return protectedRun(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
          [tenant, scope.brandReference],
        );
        await tx.query("LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE MODE", []);
        const found = rows(
          await tx.query(
            "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND release_id=$3",
            [tenant, scope.brandReference, publication],
          ),
        );
        if (found.length !== 1 || !found[0]) return fail();
        const original = normalize(found[0].mutation_json as CommitPublishingMutationInput);
        if (
          found[0].intent_hash !== digest(original) ||
          !original.release ||
          original.release.createdAt > at ||
          original.next.configurationType !== "CATALOG_OPTION_SET" ||
          original.next.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION" ||
          original.release.releaseId !== publication ||
          original.release.familyReference !== original.next.familyReference ||
          original.release.sourceLifecycleId !== original.next.lifecycleId ||
          original.release.snapshotReference !== original.next.snapshotReference ||
          original.release.snapshotDigest !== original.next.snapshotDigest ||
          original.release.configurationType !== original.next.configurationType ||
          original.release.purposeCode !== original.next.purposeCode ||
          !samePublishingScope(original.release.scope, scope) ||
          original.release.kind !== original.operation ||
          original.release.createdAt !== original.audit.occurredAt ||
          original.audit.occurredAt > at
        )
          return fail();
        const current = await owner(tx).resolveCurrentOptionSetRelease({
          familyReference: original.next.familyReference,
          observedAt: at,
        });
        if (
          current.release.snapshotReference !== original.release.snapshotReference ||
          current.release.snapshotDigest !== original.release.snapshotDigest
        )
          return fail();
        await verifyRecordedQualification(tx, original);
        if (!original.optionSetApprovalWaiver) {
          const approval = original.approvalEvidence,
            validation = original.validationEvidence;
          if (
            !approval ||
            !validation ||
            original.next.state !== "Published" ||
            !samePublishingScope(original.next.scope, scope) ||
            !equal(original.release.scope, scope) ||
            original.release.releaseId !== publication ||
            original.release.kind !== original.operation ||
            original.release.createdAt !== original.audit.occurredAt ||
            original.audit.occurredAt > at ||
            !evaluatePublishingTransition({
              operation: original.operation,
              expectedVersion: original.expectedVersion,
              current: original.current,
              next: original.next,
            }).allowed ||
            approval.decision !== "Accepted" ||
            validation.result !== "Pass" ||
            (!original.optionSetCurrentQualification &&
              (approval.validUntil <= original.release.createdAt ||
                validation.validUntil <= original.release.createdAt)) ||
            approval.approvedAt > original.release.createdAt ||
            validation.checkedAt > original.release.createdAt ||
            !samePublishingScope(approval.scope, scope) ||
            !samePublishingScope(validation.scope, scope) ||
            approval.snapshotDigest !== original.release.snapshotDigest ||
            validation.snapshotDigest !== original.release.snapshotDigest ||
            approval.snapshotReference !== original.release.snapshotReference ||
            validation.snapshotReference !== original.release.snapshotReference ||
            approval.evidenceReference !== original.next.approvalEvidenceReference ||
            validation.evidenceReference !== original.next.validationEvidenceReference
          )
            return fail();
          return Object.freeze({
            recorded: Object.freeze({
              release: original.release,
              lifecycle: original.next,
              validationEvidence: validation,
              approvalEvidence: approval,
              auditReference: parsePublishingReference(original.audit.auditId),
              approvalDisposition: "Approved" as const,
              waiver: null,
            }),
            current,
            observedAt: at,
          });
        }
        const validation = original.validationEvidence;
        if (
          !validation ||
          original.approvalEvidence !== null ||
          !evaluatePublishingTransition({
            operation: original.operation,
            expectedVersion: original.expectedVersion,
            current: original.current,
            next: original.next,
            optionSetApprovalWaived: true,
          }).allowed
        )
          return fail();
        await verifyOriginalReviewPolicy(tx, original.optionSetApprovalWaiver.reviewPolicy, true);
        return Object.freeze({
          recorded: Object.freeze({
            release: original.release,
            lifecycle: original.next,
            validationEvidence: validation,
            approvalEvidence: null,
            approvalDisposition: "PolicyWaived" as const,
            waiver: original.optionSetApprovalWaiver,
            auditReference: parsePublishingReference(original.audit.auditId),
          }),
          current,
          observedAt: at,
        });
      });
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
          await verifyRecordedQualification(tx, head);
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
          await verifyRecordedQualification(tx, recorded);
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
    /** Fixed OptionPrice rule review source. Borrow the outer transaction: acquire
     * Publishing before reading/locking Pricing. Absence is not abandonment. */
    async withOptionPriceReview<T>(
      input: Readonly<{ familyReference: string; mode: "Read" | "Write" }>,
      work: (held: OptionPriceRuleReviewHeldSource) => Promise<T>,
    ): Promise<T> {
      closedInput(input, ["familyReference", "mode"]);
      const familyReference = parsePublishingReference(input.familyReference),
        mode = input.mode;
      if (
        (mode !== "Read" && mode !== "Write") ||
        scope.kind !== "Brand" ||
        typeof work !== "function"
      )
        return fail();
      return protectedRun(async (tx) => {
        const query = tx.query;
        if (typeof query !== "function") return fail();
        const isolation = rows(
          await query.call(tx, "SELECT current_setting('transaction_isolation') AS isolation", []),
        );
        if (isolation.length !== 1 || isolation[0]?.isolation !== "read committed") return fail();
        await query.call(
          tx,
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
          [tenant, scope.brandReference],
        );
        await query.call(
          tx,
          mode === "Write"
            ? "LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE ROW EXCLUSIVE MODE"
            : "LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE MODE",
          [],
        );
        let active = true,
          reading = false,
          poisoned = false,
          lastObservedAt: ReturnType<typeof parsePublishingInstant> | undefined;
        const check = () => {
          if (!active || poisoned || tx.query !== query) return fail();
        };
        const held = Object.freeze({
          async readForDraft(
            value: Readonly<{
              snapshotReference: string;
              snapshotDigest: string;
              observedAt: string;
            }>,
          ): Promise<OptionPriceRuleReviewSourceResult> {
            try {
              check();
              if (reading) return fail();
              reading = true;
              closedInput(value, ["snapshotReference", "snapshotDigest", "observedAt"]);
              const snapshotReference = parsePublishingReference(value.snapshotReference),
                snapshotDigest = parsePublishingDigest(value.snapshotDigest),
                observedAt = parsePublishingInstant(value.observedAt);
              if (lastObservedAt !== undefined && observedAt < lastObservedAt) return fail();
              lastObservedAt = observedAt;
              const found = rows(
                await query.call(
                  tx,
                  "SELECT mutation_json,intent_hash,audit_id FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND family_id=$3 AND mutation_json#>>'{next,configurationType}'=$4 AND mutation_json#>>'{next,purposeCode}'=$5 AND mutation_json#>>'{next,snapshotReference}'=$6 AND mutation_json#>>'{next,snapshotDigest}'=$7 ORDER BY changed_at,lifecycle_version LIMIT 1025",
                  [
                    tenant,
                    scope.brandReference,
                    familyReference,
                    optionPriceRuleConfigurationType,
                    optionPriceRulePublicationPurpose,
                    snapshotReference,
                    snapshotDigest,
                  ],
                ),
              );
              check();
              const records = found.map((row) => {
                const record = parseRecordedPublishingMutation(row.mutation_json),
                  n = record.next,
                  audit = record.audit;
                if (
                  row.intent_hash !== digest(record) ||
                  row.audit_id !== audit.auditId ||
                  n.familyReference !== familyReference ||
                  n.configurationType !== optionPriceRuleConfigurationType ||
                  n.purposeCode !== optionPriceRulePublicationPurpose ||
                  n.snapshotReference !== snapshotReference ||
                  n.snapshotDigest !== snapshotDigest ||
                  !samePublishingScope(n.scope, scope) ||
                  audit.brandId !== scope.brandReference ||
                  (audit.storeId ?? null) !== null ||
                  audit.actor.type !== "User" ||
                  audit.targetType !== "PublishingLifecycle" ||
                  audit.targetId !== n.lifecycleId ||
                  audit.dataClassification !== "Confidential" ||
                  audit.actionCode !== auditActions[record.operation] ||
                  audit.occurredAt < n.changedAt ||
                  audit.occurredAt > observedAt ||
                  n.changedAt > observedAt ||
                  record.release !== null ||
                  record.supersededReleaseId !== null ||
                  record.rollbackTargetReleaseId !== null
                )
                  return fail();
                return record;
              });
              const common = { familyReference, snapshotReference, snapshotDigest, observedAt };
              if (records.length === 0)
                return Object.freeze({ outcome: "Absent" as const, ...common });
              const groups = new Map<string, CommitPublishingMutationInput[]>();
              for (const record of records) {
                const group = groups.get(record.next.lifecycleId) ?? [];
                if (group.some((prior) => prior.next.version === record.next.version))
                  return fail();
                group.push(record);
                groups.set(record.next.lifecycleId, group);
              }
              const candidates = [...groups.values()].map((group) => {
                group.sort((left, right) => left.next.version - right.next.version);
                const draft = group[0];
                if (
                  !draft ||
                  draft.operation !== "CreateDraft" ||
                  draft.next.state !== "Draft" ||
                  draft.next.version !== 1 ||
                  draft.current !== null ||
                  draft.validationEvidence !== null ||
                  draft.approvalEvidence !== null
                )
                  return fail();
                let previous: CommitPublishingMutationInput | undefined,
                  review: CommitPublishingMutationInput | null = null,
                  approval: CommitPublishingMutationInput | null = null;
                for (const record of group) {
                  if (
                    previous &&
                    (!equal(record.current, previous.next) ||
                      record.audit.occurredAt < previous.audit.occurredAt)
                  )
                    return fail();
                  if (
                    !evaluatePublishingTransition({
                      operation: record.operation,
                      expectedVersion: record.expectedVersion,
                      current: record.current,
                      next: record.next,
                    }).allowed
                  )
                    return fail();
                  if (record.operation === "SubmitReview") {
                    if (
                      review ||
                      !record.validationEvidence ||
                      record.approvalEvidence !== null ||
                      record.validationEvidence.snapshotReference !== snapshotReference ||
                      record.validationEvidence.snapshotDigest !== snapshotDigest ||
                      !samePublishingScope(record.validationEvidence.scope, scope) ||
                      record.validationEvidence.evidenceReference !==
                        record.next.validationEvidenceReference ||
                      record.validationEvidence.checkedAt > record.audit.occurredAt ||
                      record.validationEvidence.validUntil <= record.audit.occurredAt
                    )
                      return fail();
                    review = record;
                  } else if (record.operation === "Approve") {
                    const evidence = record.approvalEvidence;
                    if (
                      approval ||
                      !review ||
                      !evidence ||
                      record.validationEvidence !== null ||
                      review.audit.actor.type !== "User" ||
                      draft.audit.actor.type !== "User" ||
                      record.audit.actor.type !== "User" ||
                      record.audit.actor.reference === review.audit.actor.reference ||
                      record.audit.actor.reference === draft.audit.actor.reference ||
                      evidence.approvedActorReference !== record.audit.actor.reference ||
                      evidence.reviewLifecycleId !== draft.next.lifecycleId ||
                      evidence.reviewVersion !== review.next.version ||
                      evidence.snapshotReference !== snapshotReference ||
                      evidence.snapshotDigest !== snapshotDigest ||
                      !samePublishingScope(evidence.scope, scope) ||
                      evidence.evidenceReference !== record.next.approvalEvidenceReference ||
                      evidence.approvedAt > record.audit.occurredAt ||
                      evidence.approvedAt < review.audit.occurredAt ||
                      evidence.validUntil <= record.audit.occurredAt ||
                      !review.validationEvidence ||
                      evidence.validUntil > review.validationEvidence.validUntil
                    )
                      return fail();
                    approval = record;
                  } else if (record.operation !== "CreateDraft" && record.operation !== "Archive")
                    return fail();
                  previous = record;
                }
                if (!previous) return fail();
                return { draft, review, approval, latest: previous };
              });
              const activeCandidates = candidates.filter((candidate) =>
                ["Draft", "InReview", "Approved"].includes(candidate.latest.next.state),
              );
              if (activeCandidates.length > 1) return fail();
              candidates.sort((left, right) =>
                left.latest.next.changedAt < right.latest.next.changedAt
                  ? 1
                  : left.latest.next.changedAt > right.latest.next.changedAt
                    ? -1
                    : 0,
              );
              const selected = activeCandidates[0] ?? candidates[0];
              if (
                !selected ||
                (activeCandidates.length === 0 &&
                  candidates[1]?.latest.next.changedAt === selected.latest.next.changedAt)
              )
                return fail();
              return Object.freeze({ outcome: "Recorded" as const, ...common, ...selected });
            } catch {
              poisoned = true;
              return fail();
            } finally {
              reading = false;
            }
          },
        });
        try {
          const result = await work(held);
          check();
          if (reading) return fail();
          return result;
        } finally {
          active = false;
        }
      });
    },
    async resolveCurrentOptionPricePublicationPolicy(
      input: Readonly<{ familyReference: string; observedAt: string }>,
    ): Promise<CurrentOptionPricePublicationPolicy> {
      try {
        const d = Object.getOwnPropertyDescriptors(input),
          keys = Reflect.ownKeys(input);
        const fields = ["familyReference", "observedAt"];
        if (
          Object.getPrototypeOf(input) !== Object.prototype ||
          keys.length !== 2 ||
          keys.some(
            (k) =>
              typeof k !== "string" ||
              !fields.includes(k) ||
              !d[k]?.enumerable ||
              !("value" in d[k]),
          )
        )
          return fail();
        const familyReference = parsePublishingReference(d.familyReference?.value),
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
          const current = await createPostgresPublishingMutationStore(
            { run: (work) => work(tx) },
            tenant,
            scope,
          ).resolveCurrentRelease({
            familyReference,
            configurationType: optionPricePolicyConfigurationType,
            purposeCode: optionPricePolicyConfigurationType,
            observedAt,
          });
          const reference = current.release.snapshotReference;
          const records = rows(
            await tx.query(
              "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND operation_code='CreateDraft' AND mutation_json ? 'optionPricePolicyContent' AND mutation_json#>>'{next,snapshotReference}'=$3 ORDER BY changed_at,lifecycle_version LIMIT 1025",
              [tenant, scope.brandReference, reference],
            ),
          );
          if (records.length === 0 || records.length > 1024) return fail();
          let content: ReturnType<typeof parsePublishingOptionPricePublicationPolicy> | undefined;
          for (const row of records) {
            const m = normalize(row.mutation_json as CommitPublishingMutationInput),
              p = m.optionPricePolicyContent;
            if (
              !p ||
              row.intent_hash !== digest(m) ||
              p.tenantReference !== tenant ||
              p.familyReference !== familyReference ||
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
          if (
            current.release.snapshotReference !== reference ||
            current.release.snapshotDigest !== publishingOptionPricePublicationPolicyDigest(content)
          )
            return fail();
          // Published governance is backed by the original independent review/approval,
          // not by a matching evidence ID or the caller's policy DTO.
          const provenance = rows(
            await tx.query(
              "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND lifecycle_id=$3 AND operation_code IN ('CreateDraft','SubmitReview','Approve') ORDER BY lifecycle_version LIMIT 1025",
              [tenant, scope.brandReference, current.release.sourceLifecycleId],
            ),
          ).map((row) => {
            const mutation = normalize(row.mutation_json as CommitPublishingMutationInput);
            if (row.intent_hash !== digest(mutation)) return fail();
            return mutation;
          });
          const draft = provenance.find(
            (m) => m.operation === "CreateDraft" && m.next.version === 1,
          );
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
            !draft ||
            !review ||
            !approved ||
            draft.audit.actor.type !== "User" ||
            approved.audit.actor.type !== "User" ||
            draft.audit.actor.reference === approved.audit.actor.reference ||
            draft.current !== null ||
            draft.next.lifecycleId !== current.release.sourceLifecycleId ||
            draft.next.familyReference !== content.familyReference ||
            draft.next.snapshotReference !== reference ||
            draft.next.snapshotDigest !== current.release.snapshotDigest ||
            draft.next.configurationType !== optionPricePolicyConfigurationType ||
            draft.next.purposeCode !== optionPricePolicyConfigurationType ||
            !samePublishingScope(draft.next.scope, scope) ||
            draft.audit.brandId !== scope.brandReference ||
            (draft.audit.storeId ?? null) !== null ||
            draft.audit.occurredAt > review.audit.occurredAt ||
            !equal(review.current, draft.next) ||
            !evaluatePublishingTransition({
              operation: "SubmitReview",
              expectedVersion: review.expectedVersion,
              current: draft.next,
              next: review.next,
            }).allowed ||
            !evaluatePublishingTransition({
              operation: "Approve",
              expectedVersion: approved.expectedVersion,
              current: review.next,
              next: approved.next,
            }).allowed ||
            (draft.optionPricePolicyContent !== undefined &&
              !equal(draft.optionPricePolicyContent, content)) ||
            review.audit.actor.type !== "User" ||
            review.audit.actor.reference === approved.audit.actor.reference ||
            approved.audit.actor.reference !== current.approvalEvidence.approvedActorReference ||
            !equal(review.validationEvidence, current.validationEvidence) ||
            !equal(approved.approvalEvidence, current.approvalEvidence) ||
            !equal(approved.current, review.next) ||
            review.next.lifecycleId !== current.release.sourceLifecycleId ||
            approved.next.lifecycleId !== current.release.sourceLifecycleId ||
            review.audit.occurredAt > current.release.createdAt ||
            approved.audit.occurredAt > current.release.createdAt ||
            !samePublishingScope(review.next.scope, scope) ||
            !samePublishingScope(approved.next.scope, scope) ||
            review.next.snapshotReference !== reference ||
            review.next.snapshotDigest !== current.release.snapshotDigest ||
            review.next.familyReference !== content.familyReference ||
            approved.next.familyReference !== content.familyReference ||
            approved.next.snapshotReference !== reference ||
            approved.next.snapshotDigest !== current.release.snapshotDigest ||
            review.next.state !== "InReview" ||
            approved.next.state !== "Approved" ||
            review.audit.brandId !== scope.brandReference ||
            approved.audit.brandId !== scope.brandReference ||
            (review.audit.storeId ?? null) !== null ||
            (approved.audit.storeId ?? null) !== null ||
            review.next.configurationType !== optionPricePolicyConfigurationType ||
            review.next.purposeCode !== optionPricePolicyConfigurationType ||
            approved.next.configurationType !== optionPricePolicyConfigurationType ||
            approved.next.purposeCode !== optionPricePolicyConfigurationType ||
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
            value.optionSetCurrentQualification ||
              (next.configurationType === "RECEIPT_TEMPLATE" &&
                next.purposeCode === "RECEIPT_ISSUANCE" &&
                scope.kind === "Store")
              ? "LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE ROW EXCLUSIVE MODE"
              : "LOCK TABLE bop_publishing.publishing_mutation_record IN ROW EXCLUSIVE MODE",
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
              optionSetApprovalWaived: value.optionSetApprovalWaiver !== undefined,
              expectedVersion: value.expectedVersion,
              current: previous,
              next,
            }).allowed
          )
            return fail();
          if (value.optionSetReviewPolicy) {
            if (value.optionSetReviewPolicy.tenantReference !== tenant) return fail();
            await verifyHeldPolicy(tx, value.optionSetReviewPolicy, audit.occurredAt);
          }
          if (value.optionSetApprovalWaiver) {
            await verifyOriginalReviewPolicy(tx, value.optionSetApprovalWaiver.reviewPolicy, true);
            await verifyHeldPolicy(
              tx,
              value.optionSetApprovalWaiver.reviewPolicy,
              audit.occurredAt,
            );
          }
          const expectedValidation =
            value.operation === "SubmitReview" ||
            value.operation === "Publish" ||
            value.operation === "Rollback";
          const expectedApproval =
            value.operation === "Approve" ||
            (value.operation === "Publish" && value.optionSetApprovalWaiver === undefined) ||
            value.operation === "Rollback";
          if (
            (value.validationEvidence !== null) !== expectedValidation ||
            (value.approvalEvidence !== null) !== expectedApproval
          )
            return fail();
          if (value.optionSetCurrentQualification) {
            const binding = qualificationHistory(value, history);
            await verifyHeldPolicy(tx, binding, audit.occurredAt);
          }
          for (const evidence of [value.validationEvidence, value.approvalEvidence]) {
            if (
              evidence !== null &&
              (!samePublishingScope(evidence.scope, scope) ||
                evidence.snapshotReference !== next.snapshotReference ||
                evidence.snapshotDigest !== next.snapshotDigest ||
                (!value.optionSetCurrentQualification && audit.occurredAt >= evidence.validUntil))
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
            (next.configurationType === optionSetPolicyConfigurationType ||
              next.configurationType === optionPricePolicyConfigurationType) &&
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
            if (next.configurationType === optionPricePolicyConfigurationType) {
              const originalDraft = history.find(
                (m) => m.operation === "CreateDraft" && m.next.version === 1,
              );
              if (
                !originalDraft ||
                originalDraft.audit.actor.type !== "User" ||
                originalDraft.audit.actor.reference === actorReference ||
                !equal(review.current, originalDraft.next)
              )
                return fail();
            }
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
              (!approved && !value.optionSetApprovalWaiver) ||
              !equal(submitted.validationEvidence, value.validationEvidence) ||
              (value.optionSetApprovalWaiver
                ? !equal(
                    submitted.optionSetReviewPolicy,
                    value.optionSetApprovalWaiver.reviewPolicy,
                  )
                : !equal(approved?.approvalEvidence, value.approvalEvidence))
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
          if (
            next.configurationType === optionPricePolicyConfigurationType &&
            next.purposeCode === optionPricePolicyConfigurationType &&
            value.operation === "CreateDraft"
          ) {
            if (scope.kind !== "Brand") return fail();
            await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
              "PublishingOptionPricePolicy:" +
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
                m.next.configurationType !== optionPricePolicyConfigurationType ||
                m.next.purposeCode !== optionPricePolicyConfigurationType
              )
                return fail();
              return m;
            });
            const policies = registrations.flatMap((m) =>
              m.optionPricePolicyContent ? [m.optionPricePolicyContent] : [],
            );
            // A rollback lifecycle may reuse the immutable body without registering
            // it again. Its snapshot must still match an actual typed original.
            for (const m of registrations) {
              if (
                !m.optionPricePolicyContent &&
                !policies.some(
                  (p) =>
                    p.familyReference === m.next.familyReference &&
                    p.policyReference === m.next.snapshotReference &&
                    publishingOptionPricePublicationPolicyDigest(p) === m.next.snapshotDigest,
                )
              )
                return fail();
            }
            const same = policies.filter((p) => p.policyReference === next.snapshotReference);
            if (
              same.some(
                (p) =>
                  p.familyReference !== next.familyReference ||
                  publishingOptionPricePublicationPolicyDigest(p) !== next.snapshotDigest,
              )
            )
              return fail();
            const policy = value.optionPricePolicyContent ?? same[0];
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
          if (
            value.optionSetReviewPolicy ||
            value.optionSetApprovalWaiver ||
            value.optionSetCurrentQualification
          ) {
            const binding =
              value.optionSetReviewPolicy ??
              value.optionSetApprovalWaiver?.reviewPolicy ??
              (value.optionSetCurrentQualification
                ? qualificationHistory(value, history)
                : undefined);
            if (!binding) return fail();
            // The SHARE fence still holds; expiry can change without a competing writer.
            const clock = rows(
              await tx.query(
                "SELECT date_trunc('milliseconds',clock_timestamp()) AS observed_at",
                [],
              ),
            );
            const raw = clock[0]?.observed_at;
            const now = parsePublishingInstant(raw instanceof Date ? raw.toISOString() : raw);
            if (
              clock.length !== 1 ||
              now < audit.occurredAt ||
              Date.parse(now) - Date.parse(audit.occurredAt) > 30000 ||
              binding.policyContent.effectiveFrom > now ||
              (binding.policyContent.effectiveUntil !== null &&
                binding.policyContent.effectiveUntil <= now) ||
              (value.optionSetCurrentQualification
                ? value.optionSetCurrentQualification.validUntil <= now
                : binding.validationEvidence.validUntil <= now)
            )
              return fail();
          }
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
