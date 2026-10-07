import {
  parsePublishingOptionPricePublicationPolicy,
  publishingOptionPricePublicationPolicyDigest,
  optionPricePolicyConfigurationType,
  type PublishingOptionPricePublicationPolicy,
} from "../contracts/option-price-publication-policy.js";
import {
  parsePublishingOptionSetCurrentQualification,
  type PublishingOptionSetCurrentQualification,
} from "../contracts/option-set-current-qualification.js";
import {
  parsePublishingOptionSetReviewPolicy,
  parsePublishingOptionSetApprovalWaiver,
  type PublishingOptionSetReviewPolicy,
  type PublishingOptionSetApprovalWaiver,
} from "../contracts/option-set-approval-waiver.js";
import {
  parsePublishingOptionSetPublicationPolicy,
  publishingOptionSetPublicationPolicyDigest,
  optionSetPolicyConfigurationType,
  type PublishingOptionSetPublicationPolicy,
} from "../contracts/option-set-publication-policy.js";
import {
  parsePublishingProductPublicationPolicy,
  publishingProductPublicationPolicyDigest,
  productPolicyConfigurationType,
  type PublishingProductPublicationPolicy,
} from "../contracts/product-publication-policy.js";
import { canonicalizeRfc8785, validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import {
  parseBusinessAction,
  revalidateTenantContext,
  type BusinessAction,
  type PermissionDecision,
  type PermissionResourceScope,
} from "@bop/permission";
import {
  parseBrandAdministrationContext,
  type TenantContext,
  type BrandAdministrationContext,
} from "@bop/tenant";
import {
  createPublishingApprovalEvidence,
  createPublishingLifecycleRecord,
  createPublishingReleaseRecord,
  createPublishingValidationEvidence,
  parsePublishingCode,
  parsePublishingInstant,
  parsePublishingReference,
  parsePublishingVersion,
  samePublishingScope,
  type PublishingApprovalEvidence,
  type PublishingCode,
  type PublishingLifecycleRecord,
  type PublishingReference,
  type PublishingReleaseRecord,
  type PublishingScope,
  type PublishingValidationEvidence,
  type PublishingVersion,
} from "../contracts/publishing.js";
import {
  evaluatePublishingTransition,
  publishingOperations,
  type PublishingOperation,
} from "../domain/evaluate-publishing-transition.js";
import type {
  PublishingPorts,
  BrandAdministrationPublishingPorts,
  PublishingAuthorizationRequest,
} from "./ports/publishing-ports.js";

export const publishingServiceErrorCodes = [
  "PUBLISHING_MUTATION_INVALID",
  "PUBLISHING_PERMISSION_DENIED",
  "PUBLISHING_VALIDATION_DENIED",
  "PUBLISHING_APPROVAL_DENIED",
  "PUBLISHING_RELEASE_DENIED",
  "PUBLISHING_COMMIT_FAILED",
  "PUBLISHING_SCHEDULE_UNSUPPORTED",
] as const;
export type PublishingServiceErrorCode = (typeof publishingServiceErrorCodes)[number];

export class PublishingServiceError extends Error {
  readonly code: PublishingServiceErrorCode;

  constructor(code: PublishingServiceErrorCode) {
    super("publishing operation is unavailable");
    this.name = "PublishingServiceError";
    this.code = code;
  }
}

const actions: Readonly<Record<PublishingOperation, BusinessAction>> = {
  CreateDraft: parseBusinessAction("publishing.draft.create"),
  SubmitReview: parseBusinessAction("publishing.review.submit"),
  Approve: parseBusinessAction("publishing.review.approve"),
  Publish: parseBusinessAction("publishing.release.publish"),
  Archive: parseBusinessAction("publishing.release.archive"),
  Rollback: parseBusinessAction("publishing.release.rollback"),
};

const auditCodes: Readonly<Record<PublishingOperation, PublishingCode>> = {
  CreateDraft: parsePublishingCode("PUBLISHING_DRAFT_CREATED"),
  SubmitReview: parsePublishingCode("PUBLISHING_REVIEW_SUBMITTED"),
  Approve: parsePublishingCode("PUBLISHING_REVIEW_APPROVED"),
  Publish: parsePublishingCode("PUBLISHING_RELEASE_PUBLISHED"),
  Archive: parsePublishingCode("PUBLISHING_RELEASE_ARCHIVED"),
  Rollback: parsePublishingCode("PUBLISHING_RELEASE_ROLLED_BACK"),
};

function fail(code: PublishingServiceErrorCode): never {
  throw new PublishingServiceError(code);
}

function validateMutationEnvelope(
  input: unknown,
  contextKey: "tenantContext" | "administrationContext" = "tenantContext",
): void {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    fail("PUBLISHING_MUTATION_INVALID");
  const required = [
    contextKey,
    "operation",
    "expectedVersion",
    "current",
    "next",
    "idempotencyKey",
    "auditId",
    "correlationId",
    "occurredAt",
    "sourceChannel",
  ];
  const allowed = new Set([
    ...required,
    "validationEvidence",
    "approvalEvidence",
    "release",
    "previousRelease",
    "rollbackTarget",
    "productPolicyContent",
    "optionSetPolicyContent",
    "optionPricePolicyContent",
    "optionSetReviewPolicy",
    "optionSetApprovalWaiver",
    "optionSetCurrentQualification",
  ]);
  const keys = Reflect.ownKeys(input);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    required.some((field) => !keys.includes(field)) ||
    keys.some((field) => typeof field !== "string" || !allowed.has(field)) ||
    keys.some((field) => {
      if (typeof field !== "string") return true;
      const descriptor = descriptors[field];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    fail("PUBLISHING_MUTATION_INVALID");
}

function exactContext(
  context: TenantContext | BrandAdministrationContext,
  scope: PublishingScope,
): boolean {
  return (
    ("profile" in context ? scope.kind === "Brand" : context.scopeKind === scope.kind) &&
    context.brand.brandReference === scope.brandReference &&
    (context.store?.storeReference ?? null) === scope.storeReference
  );
}

function permissionScope(scope: PublishingScope): PermissionResourceScope {
  return Object.freeze({
    kind: scope.kind,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  });
}

function accepted(
  decision: PermissionDecision,
  action: BusinessAction,
  scope: PublishingScope,
): boolean {
  return (
    Object.isFrozen(decision) &&
    decision.effect === "Allow" &&
    decision.action === action &&
    decision.scopeKind === scope.kind
  );
}

function sameSnapshot(
  record: PublishingLifecycleRecord,
  evidence: Pick<
    PublishingValidationEvidence | PublishingApprovalEvidence,
    "snapshotReference" | "snapshotDigest" | "scope"
  >,
): boolean {
  return (
    record.snapshotReference === evidence.snapshotReference &&
    record.snapshotDigest === evidence.snapshotDigest &&
    samePublishingScope(record.scope, evidence.scope)
  );
}

function evidenceCurrent(occurredAt: string, checkedAt: string, validUntil: string): boolean {
  const at = Date.parse(occurredAt);
  return Date.parse(checkedAt) <= at && at < Date.parse(validUntil);
}

function validateValidation(
  input: PublishingValidationEvidence | undefined,
  record: PublishingLifecycleRecord,
  occurredAt: string,
  historical = false,
): PublishingValidationEvidence {
  if (input === undefined) return fail("PUBLISHING_VALIDATION_DENIED");
  let evidence: PublishingValidationEvidence;
  try {
    evidence = createPublishingValidationEvidence(input);
  } catch {
    return fail("PUBLISHING_VALIDATION_DENIED");
  }
  if (
    !sameSnapshot(record, evidence) ||
    (historical
      ? evidence.checkedAt > occurredAt
      : !evidenceCurrent(occurredAt, evidence.checkedAt, evidence.validUntil))
  )
    return fail("PUBLISHING_VALIDATION_DENIED");
  return evidence;
}

function validateApproval(
  input: PublishingApprovalEvidence | undefined,
  review: PublishingLifecycleRecord,
  expectedReviewVersion: number,
  occurredAt: string,
  historical = false,
): PublishingApprovalEvidence {
  if (input === undefined) return fail("PUBLISHING_APPROVAL_DENIED");
  let evidence: PublishingApprovalEvidence;
  try {
    evidence = createPublishingApprovalEvidence(input);
  } catch {
    return fail("PUBLISHING_APPROVAL_DENIED");
  }
  if (
    evidence.reviewLifecycleId !== review.lifecycleId ||
    evidence.reviewVersion !== expectedReviewVersion ||
    !sameSnapshot(review, evidence) ||
    (historical
      ? evidence.approvedAt > occurredAt
      : !evidenceCurrent(occurredAt, evidence.approvedAt, evidence.validUntil))
  )
    return fail("PUBLISHING_APPROVAL_DENIED");
  return evidence;
}

function sameReleaseFamily(
  record: PublishingLifecycleRecord,
  release: PublishingReleaseRecord,
): boolean {
  return (
    record.familyReference === release.familyReference &&
    record.configurationType === release.configurationType &&
    record.purposeCode === release.purposeCode &&
    samePublishingScope(record.scope, release.scope)
  );
}

function validatePreviousRelease(
  previous: PublishingReleaseRecord | undefined,
  next: PublishingLifecycleRecord,
): PublishingReleaseRecord | null {
  if (previous === undefined) return null;
  let release: PublishingReleaseRecord;
  try {
    release = createPublishingReleaseRecord(previous);
  } catch {
    return fail("PUBLISHING_RELEASE_DENIED");
  }
  if (!sameReleaseFamily(next, release)) return fail("PUBLISHING_RELEASE_DENIED");
  return release;
}

function validateRelease(input: {
  operation: "Publish" | "Rollback";
  release: PublishingReleaseRecord | undefined;
  next: PublishingLifecycleRecord;
  previous: PublishingReleaseRecord | null;
  rollbackTarget: PublishingReleaseRecord | undefined;
  occurredAt: string;
}): {
  release: PublishingReleaseRecord;
  rollbackTarget: PublishingReleaseRecord | null;
} {
  if (input.release === undefined) return fail("PUBLISHING_RELEASE_DENIED");
  let release: PublishingReleaseRecord;
  try {
    release = createPublishingReleaseRecord(input.release);
  } catch {
    return fail("PUBLISHING_RELEASE_DENIED");
  }
  const expectedSequence = input.previous === null ? 1 : input.previous.sequence + 1;
  if (
    !sameReleaseFamily(input.next, release) ||
    release.snapshotReference !== input.next.snapshotReference ||
    release.snapshotDigest !== input.next.snapshotDigest ||
    release.sourceLifecycleId !== input.next.lifecycleId ||
    release.kind !== input.operation ||
    release.sequence !== expectedSequence ||
    release.previousReleaseId !== (input.previous?.releaseId ?? null) ||
    release.createdAt !== input.occurredAt
  )
    return fail("PUBLISHING_RELEASE_DENIED");

  if (input.operation === "Publish") {
    if (input.rollbackTarget !== undefined) return fail("PUBLISHING_RELEASE_DENIED");
    return { release, rollbackTarget: null };
  }
  if (input.previous === null || input.rollbackTarget === undefined)
    return fail("PUBLISHING_RELEASE_DENIED");
  let target: PublishingReleaseRecord;
  try {
    target = createPublishingReleaseRecord(input.rollbackTarget);
  } catch {
    return fail("PUBLISHING_RELEASE_DENIED");
  }
  if (
    !sameReleaseFamily(input.next, target) ||
    target.releaseId === input.previous.releaseId ||
    target.sequence >= input.previous.sequence ||
    target.snapshotReference !== input.next.snapshotReference ||
    target.snapshotDigest !== input.next.snapshotDigest ||
    Date.parse(target.createdAt) >= Date.parse(input.occurredAt)
  )
    return fail("PUBLISHING_RELEASE_DENIED");
  return { release, rollbackTarget: target };
}

function createAudit(input: {
  operation: PublishingOperation;
  context: TenantContext | BrandAdministrationContext;
  lifecycle: PublishingLifecycleRecord;
  auditId: PublishingReference;
  correlationId: PublishingReference;
  occurredAt: string;
  sourceChannel: PublishingCode;
}): AppendAuditRecordInput {
  const actorReference = input.context.actor.actorReference;
  if (actorReference === null) return fail("PUBLISHING_MUTATION_INVALID");
  try {
    return validateAuditRecord({
      auditId: input.auditId,
      brandId: input.lifecycle.scope.brandReference,
      ...(input.lifecycle.scope.storeReference === null
        ? {}
        : { storeId: input.lifecycle.scope.storeReference }),
      actor: { type: "User", reference: actorReference },
      actionCode: auditCodes[input.operation],
      targetType: "PublishingLifecycle",
      targetId: input.lifecycle.lifecycleId,
      reasonCode: auditCodes[input.operation],
      correlationId: input.correlationId,
      occurredAt: input.occurredAt,
      sourceChannel: input.sourceChannel,
      dataClassification: "Confidential",
      retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
      retentionPolicyVersion: 1,
    });
  } catch {
    return fail("PUBLISHING_MUTATION_INVALID");
  }
}

export interface ExecutePublishingMutationInput {
  readonly optionSetCurrentQualification?: unknown;
  readonly optionSetReviewPolicy?: unknown;
  readonly optionSetApprovalWaiver?: unknown;
  readonly optionSetPolicyContent?: unknown;
  readonly optionPricePolicyContent?: unknown;
  readonly productPolicyContent?: unknown;
  readonly tenantContext: TenantContext;
  readonly operation: PublishingOperation;
  readonly expectedVersion: PublishingVersion;
  readonly current: PublishingLifecycleRecord | null;
  readonly next: PublishingLifecycleRecord;
  readonly validationEvidence?: PublishingValidationEvidence;
  readonly approvalEvidence?: PublishingApprovalEvidence;
  readonly release?: PublishingReleaseRecord;
  readonly previousRelease?: PublishingReleaseRecord;
  readonly rollbackTarget?: PublishingReleaseRecord;
  readonly idempotencyKey: PublishingReference;
  readonly auditId: PublishingReference;
  readonly correlationId: PublishingReference;
  readonly occurredAt: string;
  readonly sourceChannel: PublishingCode;
}

export interface ExecutePublishingMutationResult {
  readonly lifecycle: PublishingLifecycleRecord;
  readonly release: PublishingReleaseRecord | null;
  readonly auditReference: PublishingReference;
}

export type ExecuteBrandAdministrationPublishingMutationInput = Omit<
  ExecutePublishingMutationInput,
  | "tenantContext"
  | "optionSetCurrentQualification"
  | "optionSetReviewPolicy"
  | "optionSetApprovalWaiver"
  | "optionSetPolicyContent"
  | "optionPricePolicyContent"
  | "productPolicyContent"
> & {
  readonly administrationContext: BrandAdministrationContext;
  readonly optionSetCurrentQualification?: never;
  readonly optionSetReviewPolicy?: never;
  readonly optionSetApprovalWaiver?: never;
  readonly optionSetPolicyContent?: never;
  readonly optionPricePolicyContent?: never;
  readonly productPolicyContent?: never;
};
type MutationContext = TenantContext | BrandAdministrationContext;
type InternalAuthorizationRequest = Omit<PublishingAuthorizationRequest, "tenantContext"> & {
  readonly context: MutationContext;
};
interface InternalMutationPorts {
  readonly authorize: (request: InternalAuthorizationRequest) => Promise<PermissionDecision>;
  readonly unitOfWork: PublishingPorts["unitOfWork"];
}
export function executePublishingMutation(
  input: ExecutePublishingMutationInput,
  ports: PublishingPorts,
): Promise<ExecutePublishingMutationResult> {
  return executeMutation(
    input,
    {
      unitOfWork: ports.unitOfWork,
      authorize: ({ context, ...request }) => {
        if ("profile" in context) return fail("PUBLISHING_MUTATION_INVALID");
        return ports.authorization.authorize({
          ...request,
          tenantContext: revalidateTenantContext(context),
        });
      },
    },
    false,
  );
}
export function executeBrandAdministrationPublishingMutation(
  input: ExecuteBrandAdministrationPublishingMutationInput,
  ports: BrandAdministrationPublishingPorts,
): Promise<ExecutePublishingMutationResult> {
  return executeMutation(
    input,
    {
      unitOfWork: ports.unitOfWork,
      authorize: ({ context, ...request }) =>
        ports.authorization.authorize({
          ...request,
          administrationContext: parseBrandAdministrationContext(context),
        }),
    },
    true,
  );
}
async function executeMutation(
  input: ExecutePublishingMutationInput | ExecuteBrandAdministrationPublishingMutationInput,
  ports: InternalMutationPorts,
  administrative: boolean,
): Promise<ExecutePublishingMutationResult> {
  let context: MutationContext;
  let current: PublishingLifecycleRecord | null;
  let next: PublishingLifecycleRecord;
  let expectedVersion: PublishingVersion;
  let idempotencyKey: PublishingReference;
  let auditId: PublishingReference;
  let correlationId: PublishingReference;
  let occurredAt: string;
  let sourceChannel: PublishingCode;
  let optionSetReviewPolicy: PublishingOptionSetReviewPolicy | undefined;
  let optionSetApprovalWaiver: PublishingOptionSetApprovalWaiver | undefined;
  let optionSetPolicyContent: PublishingOptionSetPublicationPolicy | undefined;
  let optionPricePolicyContent: PublishingOptionPricePublicationPolicy | undefined;
  let productPolicyContent: PublishingProductPublicationPolicy | undefined;
  let optionSetCurrentQualification: PublishingOptionSetCurrentQualification | undefined;
  try {
    validateMutationEnvelope(input, administrative ? "administrationContext" : "tenantContext");
    if (
      administrative &&
      [
        "optionSetCurrentQualification",
        "optionSetReviewPolicy",
        "optionSetApprovalWaiver",
        "optionSetPolicyContent",
        "optionPricePolicyContent",
        "productPolicyContent",
        "rollbackTarget",
      ].some((key) => Object.hasOwn(input, key))
    )
      return fail("PUBLISHING_MUTATION_INVALID");
    if (Object.hasOwn(input, "optionSetCurrentQualification"))
      optionSetCurrentQualification = parsePublishingOptionSetCurrentQualification(
        input.optionSetCurrentQualification,
      );
    if (Object.hasOwn(input, "optionSetReviewPolicy")) {
      if (input.operation !== "SubmitReview") return fail("PUBLISHING_MUTATION_INVALID");
      optionSetReviewPolicy = parsePublishingOptionSetReviewPolicy(input.optionSetReviewPolicy);
    }
    if (Object.hasOwn(input, "optionSetApprovalWaiver")) {
      if (input.operation !== "Publish") return fail("PUBLISHING_MUTATION_INVALID");
      optionSetApprovalWaiver = parsePublishingOptionSetApprovalWaiver(
        input.optionSetApprovalWaiver,
      );
    }
    if (Object.hasOwn(input, "productPolicyContent")) {
      if (input.operation !== "CreateDraft") return fail("PUBLISHING_MUTATION_INVALID");
      productPolicyContent = parsePublishingProductPublicationPolicy(input.productPolicyContent);
    }
    if (Object.hasOwn(input, "optionSetPolicyContent")) {
      if (input.operation !== "CreateDraft" || productPolicyContent)
        return fail("PUBLISHING_MUTATION_INVALID");
      optionSetPolicyContent = parsePublishingOptionSetPublicationPolicy(
        input.optionSetPolicyContent,
      );
    }
    if (Object.hasOwn(input, "optionPricePolicyContent")) {
      if (input.operation !== "CreateDraft" || productPolicyContent || optionSetPolicyContent)
        return fail("PUBLISHING_MUTATION_INVALID");
      optionPricePolicyContent = parsePublishingOptionPricePublicationPolicy(
        input.optionPricePolicyContent,
      );
    }
    if (!publishingOperations.includes(input.operation)) fail("PUBLISHING_MUTATION_INVALID");
    context =
      administrative && "administrationContext" in input
        ? parseBrandAdministrationContext(input.administrationContext)
        : "tenantContext" in input
          ? revalidateTenantContext(input.tenantContext)
          : fail("PUBLISHING_MUTATION_INVALID");
    current = input.current === null ? null : createPublishingLifecycleRecord(input.current);
    next = createPublishingLifecycleRecord(input.next);
    if (
      administrative &&
      (!["CreateDraft", "SubmitReview", "Approve", "Publish", "Archive"].includes(
        input.operation,
      ) ||
        next.configurationType !== "BRAND_CONFIGURATION" ||
        next.purposeCode !== "BRAND_CONFIGURATION" ||
        next.scope.kind !== "Brand" ||
        next.scope.storeReference !== null ||
        next.familyReference !== String(context.brand.brandReference) ||
        (current !== null &&
          (current.configurationType !== "BRAND_CONFIGURATION" ||
            current.purposeCode !== "BRAND_CONFIGURATION" ||
            current.familyReference !== String(context.brand.brandReference))))
    )
      return fail("PUBLISHING_MUTATION_INVALID");
    if (
      productPolicyContent &&
      (next.scope.kind !== "Brand" ||
        next.configurationType !== productPolicyConfigurationType ||
        next.purposeCode !== productPolicyConfigurationType ||
        String(next.scope.brandReference) !== productPolicyContent.brandReference ||
        next.familyReference !== productPolicyContent.familyReference ||
        next.snapshotReference !== productPolicyContent.policyReference ||
        next.snapshotDigest !== publishingProductPublicationPolicyDigest(productPolicyContent))
    )
      return fail("PUBLISHING_MUTATION_INVALID");
    if (
      optionSetPolicyContent &&
      (next.scope.kind !== "Brand" ||
        next.configurationType !== optionSetPolicyConfigurationType ||
        next.purposeCode !== optionSetPolicyConfigurationType ||
        String(next.scope.brandReference) !== optionSetPolicyContent.brandReference ||
        next.familyReference !== optionSetPolicyContent.familyReference ||
        next.snapshotReference !== optionSetPolicyContent.policyReference ||
        next.snapshotDigest !== publishingOptionSetPublicationPolicyDigest(optionSetPolicyContent))
    )
      return fail("PUBLISHING_MUTATION_INVALID");
    if (
      optionPricePolicyContent &&
      (next.scope.kind !== "Brand" ||
        next.configurationType !== optionPricePolicyConfigurationType ||
        next.purposeCode !== optionPricePolicyConfigurationType ||
        String(next.scope.brandReference) !== optionPricePolicyContent.brandReference ||
        next.familyReference !== optionPricePolicyContent.familyReference ||
        next.snapshotReference !== optionPricePolicyContent.policyReference ||
        next.snapshotDigest !==
          publishingOptionPricePublicationPolicyDigest(optionPricePolicyContent))
    )
      return fail("PUBLISHING_MUTATION_INVALID");
    expectedVersion = parsePublishingVersion(input.expectedVersion);
    idempotencyKey = parsePublishingReference(input.idempotencyKey);
    auditId = parsePublishingReference(input.auditId);
    correlationId = parsePublishingReference(input.correlationId);
    occurredAt = parsePublishingInstant(input.occurredAt);
    sourceChannel = parsePublishingCode(input.sourceChannel);
  } catch {
    return fail("PUBLISHING_MUTATION_INVALID");
  }
  if (
    !exactContext(context, next.scope) ||
    (current !== null && !exactContext(context, current.scope))
  )
    fail("PUBLISHING_MUTATION_INVALID");

  const transition = evaluatePublishingTransition({
    operation: input.operation,
    optionSetApprovalWaived: optionSetApprovalWaiver !== undefined,
    expectedVersion,
    current,
    next,
  });
  if (!transition.allowed) fail("PUBLISHING_MUTATION_INVALID");

  let decision: PermissionDecision;
  try {
    decision = await ports.authorize({
      context,
      action: actions[input.operation],
      resourceScope: permissionScope(next.scope),
      familyReference: next.familyReference,
      purposeCode: next.purposeCode,
      expectedVersion,
    });
  } catch {
    return fail("PUBLISHING_PERMISSION_DENIED");
  }
  if (!accepted(decision, actions[input.operation], next.scope))
    fail("PUBLISHING_PERMISSION_DENIED");

  if (optionSetCurrentQualification) {
    const q = optionSetCurrentQualification;
    if (
      input.operation !== "Publish" ||
      !current ||
      next.configurationType !== "CATALOG_OPTION_SET" ||
      next.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION" ||
      String(q.actorReference) !== String(context.actor.actorReference) ||
      q.operationReference !== idempotencyKey ||
      q.familyReference !== current.familyReference ||
      q.lifecycleReference !== current.lifecycleId ||
      q.expectedLifecycleVersion !== current.version ||
      q.snapshotReference !== current.snapshotReference ||
      q.snapshotDigest !== current.snapshotDigest ||
      q.validationEvidenceReference !== current.validationEvidenceReference ||
      q.approvalEvidenceReference !== current.approvalEvidenceReference ||
      !samePublishingScope(q.scope, current.scope) ||
      !evidenceCurrent(occurredAt, q.checkedAt, q.validUntil) ||
      (optionSetApprovalWaiver &&
        (!optionSetApprovalWaiver.currentQualification ||
          canonicalizeRfc8785(optionSetApprovalWaiver.currentQualification) !==
            canonicalizeRfc8785(q)))
    )
      fail("PUBLISHING_VALIDATION_DENIED");
  } else if (optionSetApprovalWaiver?.currentQualification) fail("PUBLISHING_VALIDATION_DENIED");

  let retainedValidation: PublishingValidationEvidence | null = null;
  let retainedApproval: PublishingApprovalEvidence | null = null;

  if (input.operation === "SubmitReview") {
    const validation = validateValidation(input.validationEvidence, next, occurredAt);
    retainedValidation = validation;
    if (next.validationEvidenceReference !== validation.evidenceReference)
      fail("PUBLISHING_VALIDATION_DENIED");
  }
  if (input.operation === "Approve") {
    if (current === null) fail("PUBLISHING_MUTATION_INVALID");
    const approval = validateApproval(input.approvalEvidence, current, current.version, occurredAt);
    retainedApproval = approval;
    if (
      next.approvalEvidenceReference !== approval.evidenceReference ||
      context.actor.actorReference === null ||
      String(context.actor.actorReference) !== approval.approvedActorReference
    )
      fail("PUBLISHING_APPROVAL_DENIED");
  }

  let release: PublishingReleaseRecord | null = null;
  let rollbackTarget: PublishingReleaseRecord | null = null;
  const previous = validatePreviousRelease(input.previousRelease, next);
  if (input.operation === "Publish" || input.operation === "Rollback") {
    if (current === null) fail("PUBLISHING_MUTATION_INVALID");
    const validation = validateValidation(
      input.validationEvidence,
      current,
      occurredAt,
      optionSetCurrentQualification !== undefined,
    );
    retainedValidation = validation;
    if (optionSetApprovalWaiver) {
      if (
        input.approvalEvidence !== undefined ||
        current.approvalEvidenceReference !== null ||
        optionSetApprovalWaiver.recordedAt !== occurredAt
      )
        fail("PUBLISHING_APPROVAL_DENIED");
    } else {
      const approval = validateApproval(
        input.approvalEvidence,
        current,
        current.version - 1,
        occurredAt,
        optionSetCurrentQualification !== undefined,
      );
      retainedApproval = approval;
      if (current.approvalEvidenceReference !== approval.evidenceReference)
        fail("PUBLISHING_MUTATION_INVALID");
    }
    if (current.validationEvidenceReference !== validation.evidenceReference)
      fail("PUBLISHING_MUTATION_INVALID");
    const validated = validateRelease({
      operation: input.operation,
      release: input.release,
      next,
      previous,
      rollbackTarget: input.rollbackTarget,
      occurredAt,
    });
    release = validated.release;
    rollbackTarget = validated.rollbackTarget;
  } else if (
    input.release !== undefined ||
    input.previousRelease !== undefined ||
    input.rollbackTarget !== undefined
  ) {
    fail("PUBLISHING_RELEASE_DENIED");
  }

  const audit = createAudit({
    operation: input.operation,
    context,
    lifecycle: next,
    auditId,
    correlationId,
    occurredAt,
    sourceChannel,
  });
  const binding = optionSetReviewPolicy ?? optionSetApprovalWaiver?.reviewPolicy;
  if (binding) {
    const original = optionSetReviewPolicy ? next : current;
    if (
      canonicalizeRfc8785(binding.reviewLifecycle) !== canonicalizeRfc8785(original) ||
      canonicalizeRfc8785(binding.validationEvidence) !== canonicalizeRfc8785(retainedValidation) ||
      (optionSetReviewPolicy &&
        (binding.reviewOperationReference !== idempotencyKey ||
          audit.actor.type !== "User" ||
          binding.submittedActorReference !== audit.actor.reference ||
          binding.submittedAt !== occurredAt))
    )
      fail("PUBLISHING_MUTATION_INVALID");
  }
  let originalAuditReference: PublishingReference;
  try {
    const committed = await ports.unitOfWork.commit({
      ...(optionSetCurrentQualification === undefined ? {} : { optionSetCurrentQualification }),
      ...(optionSetReviewPolicy === undefined ? {} : { optionSetReviewPolicy }),
      ...(optionSetApprovalWaiver === undefined ? {} : { optionSetApprovalWaiver }),
      ...(productPolicyContent === undefined ? {} : { productPolicyContent }),
      ...(optionSetPolicyContent === undefined ? {} : { optionSetPolicyContent }),
      ...(optionPricePolicyContent === undefined ? {} : { optionPricePolicyContent }),
      operation: input.operation,
      validationEvidence: retainedValidation,
      approvalEvidence: retainedApproval,
      expectedVersion,
      idempotencyKey,
      current,
      next,
      release,
      supersededReleaseId: previous?.releaseId ?? null,
      rollbackTargetReleaseId: rollbackTarget?.releaseId ?? null,
      audit,
    });
    originalAuditReference = parsePublishingReference(committed.auditReference);
  } catch {
    return fail("PUBLISHING_COMMIT_FAILED");
  }
  return Object.freeze({ lifecycle: next, release, auditReference: originalAuditReference });
}

export function schedulePublishing(): never {
  return fail("PUBLISHING_SCHEDULE_UNSUPPORTED");
}
