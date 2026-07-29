import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import {
  parseBusinessAction,
  revalidateTenantContext,
  type BusinessAction,
  type PermissionDecision,
  type PermissionResourceScope,
} from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import {
  createEffectiveConfigurationVersion,
  createEffectivePeriodApprovalEvidence,
  createEffectivePeriodIntent,
  parseEffectivePeriodCode,
  parseEffectivePeriodInstant,
  parseEffectivePeriodReference,
  parseEffectivePeriodVersion,
  sameEffectiveScope,
  validateNoEffectiveOverlap,
  type EffectiveConfigurationVersion,
  type EffectivePeriodApprovalEvidence,
  type EffectivePeriodCode,
  type EffectivePeriodIntent,
  type EffectivePeriodReference,
  type EffectiveScope,
  type EffectivePeriodVersion,
} from "../contracts/effective-period.js";
import type { EffectivePeriodPorts } from "./ports/effective-period-ports.js";

export const effectivePeriodOperations = ["Schedule", "Renew"] as const;
export type EffectivePeriodOperation = (typeof effectivePeriodOperations)[number];

export const effectivePeriodServiceErrorCodes = [
  "EFFECTIVE_PERIOD_MUTATION_INVALID",
  "EFFECTIVE_PERIOD_PERMISSION_DENIED",
  "EFFECTIVE_PERIOD_APPROVAL_DENIED",
  "EFFECTIVE_PERIOD_OVERLAP_DENIED",
  "EFFECTIVE_PERIOD_COMMIT_FAILED",
] as const;
export type EffectivePeriodServiceErrorCode = (typeof effectivePeriodServiceErrorCodes)[number];

export class EffectivePeriodServiceError extends Error {
  readonly code: EffectivePeriodServiceErrorCode;

  constructor(code: EffectivePeriodServiceErrorCode) {
    super("effective period operation is unavailable");
    this.name = "EffectivePeriodServiceError";
    this.code = code;
  }
}

const actions: Readonly<Record<EffectivePeriodOperation, BusinessAction>> = {
  Schedule: parseBusinessAction("effective.period.schedule"),
  Renew: parseBusinessAction("effective.period.renew"),
};

const auditCodes: Readonly<Record<EffectivePeriodOperation, EffectivePeriodCode>> = {
  Schedule: parseEffectivePeriodCode("EFFECTIVE_PERIOD_SCHEDULED"),
  Renew: parseEffectivePeriodCode("EFFECTIVE_PERIOD_RENEWED"),
};

function fail(code: EffectivePeriodServiceErrorCode): never {
  throw new EffectivePeriodServiceError(code);
}

function validateEnvelope(input: unknown): void {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    fail("EFFECTIVE_PERIOD_MUTATION_INVALID");
  const fields = [
    "tenantContext",
    "operation",
    "expectedVersion",
    "current",
    "next",
    "existing",
    "approvalEvidence",
    "activationIntent",
    "expiryIntent",
    "idempotencyKey",
    "auditId",
    "correlationId",
    "occurredAt",
    "sourceChannel",
  ];
  const keys = Reflect.ownKeys(input);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !keys.includes(field)) ||
    keys.some((field) => typeof field !== "string" || !fields.includes(field)) ||
    keys.some((field) => {
      if (typeof field !== "string") return true;
      const descriptor = descriptors[field];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    fail("EFFECTIVE_PERIOD_MUTATION_INVALID");
}

function exactContext(context: TenantContext, scope: EffectiveScope): boolean {
  return (
    context.scopeKind === scope.kind &&
    context.brand.brandReference === scope.brandReference &&
    (context.store?.storeReference ?? null) === scope.storeReference
  );
}

function permissionScope(scope: EffectiveScope): PermissionResourceScope {
  return Object.freeze({
    kind: scope.kind,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  });
}

function accepted(
  decision: PermissionDecision,
  action: BusinessAction,
  scope: EffectiveScope,
): boolean {
  return (
    Object.isFrozen(decision) &&
    decision.effect === "Allow" &&
    decision.action === action &&
    decision.scopeKind === scope.kind
  );
}

function sameFamily(left: EffectiveConfigurationVersion, right: EffectiveConfigurationVersion) {
  return (
    left.familyReference === right.familyReference &&
    left.configurationReference === right.configurationReference &&
    left.releaseReference === right.releaseReference &&
    left.snapshotReference === right.snapshotReference &&
    left.snapshotDigest === right.snapshotDigest &&
    left.configurationType === right.configurationType &&
    left.purposeCode === right.purposeCode &&
    sameEffectiveScope(left.scope, right.scope)
  );
}

function validateTransition(
  operation: EffectivePeriodOperation,
  expectedVersion: EffectivePeriodVersion,
  current: EffectiveConfigurationVersion | null,
  next: EffectiveConfigurationVersion,
): void {
  if (operation === "Schedule") {
    if (current !== null || expectedVersion !== 1 || next.version !== 1)
      fail("EFFECTIVE_PERIOD_MUTATION_INVALID");
    return;
  }
  if (
    current === null ||
    expectedVersion !== current.version ||
    next.version !== current.version + 1 ||
    next.timingVersionReference === current.timingVersionReference ||
    !sameFamily(current, next) ||
    Date.parse(next.createdAt) < Date.parse(current.createdAt)
  )
    fail("EFFECTIVE_PERIOD_MUTATION_INVALID");
}

function validateApproval(
  evidenceInput: EffectivePeriodApprovalEvidence,
  next: EffectiveConfigurationVersion,
  occurredAt: string,
): EffectivePeriodApprovalEvidence {
  let evidence: EffectivePeriodApprovalEvidence;
  try {
    evidence = createEffectivePeriodApprovalEvidence(evidenceInput);
  } catch {
    return fail("EFFECTIVE_PERIOD_APPROVAL_DENIED");
  }
  if (
    evidence.familyReference !== next.familyReference ||
    evidence.timingVersionReference !== next.timingVersionReference ||
    evidence.version !== next.version ||
    !sameEffectiveScope(evidence.scope, next.scope) ||
    evidence.periodDigest !== next.periodDigest ||
    evidence.evidenceReference !== next.approvalEvidenceReference ||
    Date.parse(evidence.approvedAt) > Date.parse(occurredAt) ||
    Date.parse(occurredAt) >= Date.parse(evidence.validUntil)
  )
    fail("EFFECTIVE_PERIOD_APPROVAL_DENIED");
  return evidence;
}

function validateIntents(
  activationInput: EffectivePeriodIntent,
  expiryInput: EffectivePeriodIntent | null,
  next: EffectiveConfigurationVersion,
  occurredAt: string,
): readonly EffectivePeriodIntent[] {
  let activation: EffectivePeriodIntent;
  let expiry: EffectivePeriodIntent | null;
  try {
    activation = createEffectivePeriodIntent(activationInput);
    expiry = expiryInput === null ? null : createEffectivePeriodIntent(expiryInput);
  } catch {
    return fail("EFFECTIVE_PERIOD_MUTATION_INVALID");
  }
  if (
    activation.kind !== "Activation" ||
    activation.timingVersionReference !== next.timingVersionReference ||
    activation.dueAt !== next.period.effectiveFrom.instant ||
    activation.createdAt !== occurredAt ||
    (next.period.effectiveUntil === null) !== (expiry === null) ||
    (expiry !== null &&
      (expiry.kind !== "Expiry" ||
        expiry.timingVersionReference !== next.timingVersionReference ||
        expiry.dueAt !== next.period.effectiveUntil?.instant ||
        expiry.createdAt !== occurredAt ||
        expiry.intentReference === activation.intentReference))
  )
    fail("EFFECTIVE_PERIOD_MUTATION_INVALID");
  return Object.freeze(expiry === null ? [activation] : [activation, expiry]);
}

function createAudit(input: {
  operation: EffectivePeriodOperation;
  context: TenantContext;
  next: EffectiveConfigurationVersion;
  auditId: EffectivePeriodReference;
  correlationId: EffectivePeriodReference;
  occurredAt: string;
  sourceChannel: EffectivePeriodCode;
}): AppendAuditRecordInput {
  if (input.context.actor.actorReference === null) return fail("EFFECTIVE_PERIOD_MUTATION_INVALID");
  try {
    return validateAuditRecord({
      auditId: input.auditId,
      brandId: input.next.scope.brandReference,
      ...(input.next.scope.storeReference === null
        ? {}
        : { storeId: input.next.scope.storeReference }),
      actor: { type: "User", reference: input.context.actor.actorReference },
      actionCode: auditCodes[input.operation],
      targetType: "EffectivePeriodVersion",
      targetId: input.next.timingVersionReference,
      reasonCode: auditCodes[input.operation],
      correlationId: input.correlationId,
      occurredAt: input.occurredAt,
      sourceChannel: input.sourceChannel,
      dataClassification: "Confidential",
      retentionPolicyCode: "EFFECTIVE_PERIOD_AUDIT",
      retentionPolicyVersion: 1,
    });
  } catch {
    return fail("EFFECTIVE_PERIOD_MUTATION_INVALID");
  }
}

export interface ExecuteEffectivePeriodMutationInput {
  readonly tenantContext: TenantContext;
  readonly operation: EffectivePeriodOperation;
  readonly expectedVersion: EffectivePeriodVersion;
  readonly current: EffectiveConfigurationVersion | null;
  readonly next: EffectiveConfigurationVersion;
  readonly existing: readonly EffectiveConfigurationVersion[];
  readonly approvalEvidence: EffectivePeriodApprovalEvidence;
  readonly activationIntent: EffectivePeriodIntent;
  readonly expiryIntent: EffectivePeriodIntent | null;
  readonly idempotencyKey: EffectivePeriodReference;
  readonly auditId: EffectivePeriodReference;
  readonly correlationId: EffectivePeriodReference;
  readonly occurredAt: string;
  readonly sourceChannel: EffectivePeriodCode;
}

export interface ExecuteEffectivePeriodMutationResult {
  readonly timingVersion: EffectiveConfigurationVersion;
  readonly intents: readonly EffectivePeriodIntent[];
  readonly auditReference: EffectivePeriodReference;
}

export async function executeEffectivePeriodMutation(
  input: ExecuteEffectivePeriodMutationInput,
  ports: EffectivePeriodPorts,
): Promise<ExecuteEffectivePeriodMutationResult> {
  let context: TenantContext;
  let expectedVersion: EffectivePeriodVersion;
  let current: EffectiveConfigurationVersion | null;
  let next: EffectiveConfigurationVersion;
  let existing: EffectiveConfigurationVersion[];
  let idempotencyKey: EffectivePeriodReference;
  let auditId: EffectivePeriodReference;
  let correlationId: EffectivePeriodReference;
  let occurredAt: string;
  let sourceChannel: EffectivePeriodCode;
  try {
    validateEnvelope(input);
    if (!effectivePeriodOperations.includes(input.operation))
      fail("EFFECTIVE_PERIOD_MUTATION_INVALID");
    context = revalidateTenantContext(input.tenantContext);
    expectedVersion = parseEffectivePeriodVersion(input.expectedVersion);
    current = input.current === null ? null : createEffectiveConfigurationVersion(input.current);
    next = createEffectiveConfigurationVersion(input.next);
    if (!Array.isArray(input.existing)) fail("EFFECTIVE_PERIOD_MUTATION_INVALID");
    existing = input.existing.map(createEffectiveConfigurationVersion);
    idempotencyKey = parseEffectivePeriodReference(input.idempotencyKey);
    auditId = parseEffectivePeriodReference(input.auditId);
    correlationId = parseEffectivePeriodReference(input.correlationId);
    occurredAt = parseEffectivePeriodInstant(input.occurredAt);
    sourceChannel = parseEffectivePeriodCode(input.sourceChannel);
  } catch {
    return fail("EFFECTIVE_PERIOD_MUTATION_INVALID");
  }
  if (
    !exactContext(context, next.scope) ||
    (current !== null && !exactContext(context, current.scope)) ||
    existing.some((value) => !exactContext(context, value.scope))
  )
    fail("EFFECTIVE_PERIOD_MUTATION_INVALID");
  validateTransition(input.operation, expectedVersion, current, next);
  let decision: PermissionDecision;
  try {
    decision = await ports.authorization.authorize({
      tenantContext: context,
      action: actions[input.operation],
      resourceScope: permissionScope(next.scope),
      familyReference: next.familyReference,
      purposeCode: next.purposeCode,
      expectedVersion,
    });
  } catch {
    return fail("EFFECTIVE_PERIOD_PERMISSION_DENIED");
  }
  if (!accepted(decision, actions[input.operation], next.scope))
    fail("EFFECTIVE_PERIOD_PERMISSION_DENIED");

  try {
    validateNoEffectiveOverlap(next, existing);
  } catch {
    return fail("EFFECTIVE_PERIOD_OVERLAP_DENIED");
  }
  validateApproval(input.approvalEvidence, next, occurredAt);
  const intents = validateIntents(input.activationIntent, input.expiryIntent, next, occurredAt);

  const audit = createAudit({
    operation: input.operation,
    context,
    next,
    auditId,
    correlationId,
    occurredAt,
    sourceChannel,
  });
  try {
    await ports.unitOfWork.commit({
      expectedVersion,
      idempotencyKey,
      current,
      next,
      intents,
      audit,
    });
  } catch {
    return fail("EFFECTIVE_PERIOD_COMMIT_FAILED");
  }
  return Object.freeze({ timingVersion: next, intents, auditReference: auditId });
}
