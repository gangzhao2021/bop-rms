import { validateAuditRecord, type AppendAuditRecordInput, type JsonObject } from "@bop/audit";
import {
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  revalidateTenantContext,
  type BusinessAction,
  type PermissionDecision,
  type PermissionResourceScope,
} from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import {
  createFeatureControlDefinition,
  createRecoveryValidationEvidence,
  parseFeatureControlPurposeCode,
  parseFeatureControlReference,
  parseFeatureControlVersion,
  type FeatureControlDefinition,
  type FeatureControlPurposeCode,
  type FeatureControlReference,
  type FeatureControlVersion,
  type KillSwitchDefinition,
  type RecoveryValidationEvidence,
} from "../contracts/feature-control.js";
import type { FeatureControlMutationPorts } from "./ports/feature-control-ports.js";

export const featureControlMutationOperations = [
  "Change",
  "Activate",
  "BeginRecovery",
  "CompleteRecovery",
] as const;
export type FeatureControlMutationOperation = (typeof featureControlMutationOperations)[number];

export const featureControlServiceErrorCodes = [
  "FEATURE_CONTROL_MUTATION_INVALID",
  "FEATURE_CONTROL_PERMISSION_DENIED",
  "FEATURE_CONTROL_RECOVERY_DENIED",
  "FEATURE_CONTROL_COMMIT_FAILED",
] as const;
export type FeatureControlServiceErrorCode = (typeof featureControlServiceErrorCodes)[number];

const safeMessages: Readonly<Record<FeatureControlServiceErrorCode, string>> = {
  FEATURE_CONTROL_MUTATION_INVALID: "feature control mutation is invalid",
  FEATURE_CONTROL_PERMISSION_DENIED: "feature control permission is denied",
  FEATURE_CONTROL_RECOVERY_DENIED: "feature control recovery is denied",
  FEATURE_CONTROL_COMMIT_FAILED: "feature control commit failed",
};

export class FeatureControlServiceError extends Error {
  readonly code: FeatureControlServiceErrorCode;

  constructor(code: FeatureControlServiceErrorCode) {
    super(safeMessages[code]);
    this.name = "FeatureControlServiceError";
    this.code = code;
  }
}

const operationActions: Readonly<Record<FeatureControlMutationOperation, BusinessAction>> = {
  Change: parseBusinessAction("feature.control.change"),
  Activate: parseBusinessAction("feature.control.activate"),
  BeginRecovery: parseBusinessAction("feature.control.recover"),
  CompleteRecovery: parseBusinessAction("feature.control.recover"),
};

const operationAuditCodes: Readonly<
  Record<FeatureControlMutationOperation, FeatureControlPurposeCode>
> = {
  Change: parseFeatureControlPurposeCode("FEATURE_CONTROL_CHANGED"),
  Activate: parseFeatureControlPurposeCode("FEATURE_CONTROL_ACTIVATED"),
  BeginRecovery: parseFeatureControlPurposeCode("FEATURE_CONTROL_RECOVERY_BEGUN"),
  CompleteRecovery: parseFeatureControlPurposeCode("FEATURE_CONTROL_RECOVERY_COMPLETED"),
};

export interface ExecuteFeatureControlMutationInput {
  readonly tenantContext: TenantContext;
  readonly operation: FeatureControlMutationOperation;
  readonly expectedVersion: FeatureControlVersion;
  readonly current: FeatureControlDefinition;
  readonly next: FeatureControlDefinition;
  readonly recoveryEvidence?: RecoveryValidationEvidence;
  readonly auditId: FeatureControlReference;
  readonly correlationId: FeatureControlReference;
  readonly sourceChannel: FeatureControlPurposeCode;
}

export interface ExecuteFeatureControlMutationResult {
  readonly control: FeatureControlDefinition;
  readonly auditReference: FeatureControlReference;
}

function invalid(code: FeatureControlServiceErrorCode = "FEATURE_CONTROL_MUTATION_INVALID"): never {
  throw new FeatureControlServiceError(code);
}

function validateMutationEnvelope(input: unknown): void {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    invalid();
  const required = [
    "tenantContext",
    "operation",
    "expectedVersion",
    "current",
    "next",
    "auditId",
    "correlationId",
    "sourceChannel",
  ];
  const allowed = new Set([...required, "recoveryEvidence"]);
  const keys = Reflect.ownKeys(input);
  if (
    required.some((field) => !keys.includes(field)) ||
    keys.some((field) => typeof field !== "string" || !allowed.has(field))
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    keys.some((field) => {
      if (typeof field !== "string") return true;
      const descriptor = descriptors[field];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    invalid();
}

function sameScope(
  left: FeatureControlDefinition["scope"],
  right: FeatureControlDefinition["scope"],
): boolean {
  return (
    left.kind === right.kind &&
    left.brandReference === right.brandReference &&
    left.storeReference === right.storeReference
  );
}

function exactContext(context: TenantContext, definition: FeatureControlDefinition): boolean {
  return (
    context.scopeKind === definition.scope.kind &&
    context.brand.brandReference === definition.scope.brandReference &&
    (context.store?.storeReference ?? null) === definition.scope.storeReference
  );
}

function stableConfiguration(definition: FeatureControlDefinition): string {
  const configuration: Record<string, unknown> = { ...definition };
  delete configuration.version;
  delete configuration.state;
  return JSON.stringify(configuration);
}

function validateFamily(
  current: FeatureControlDefinition,
  next: FeatureControlDefinition,
  expectedVersion: FeatureControlVersion,
): void {
  if (
    current.version !== expectedVersion ||
    next.version !== current.version + 1 ||
    current.controlId !== next.controlId ||
    current.key !== next.key ||
    current.kind !== next.kind ||
    !sameScope(current.scope, next.scope)
  )
    invalid();
}

function validateRecoveryEvidence(
  evidenceInput: RecoveryValidationEvidence | undefined,
  current: KillSwitchDefinition,
  next: KillSwitchDefinition,
  at: number,
): RecoveryValidationEvidence {
  if (evidenceInput === undefined || !Object.isFrozen(evidenceInput))
    return invalid("FEATURE_CONTROL_RECOVERY_DENIED");
  let evidence: RecoveryValidationEvidence;
  try {
    evidence = createRecoveryValidationEvidence(evidenceInput);
  } catch {
    return invalid("FEATURE_CONTROL_RECOVERY_DENIED");
  }
  const target = next.state.phase === "Recovering" ? next.state.rolloutBasisPoints : 10_000;
  if (
    evidence.controlId !== current.controlId ||
    evidence.controlVersion !== current.version ||
    !sameScope(evidence.scope, current.scope) ||
    evidence.targetBasisPoints !== target ||
    Date.parse(evidence.checkedAt) > at ||
    at >= Date.parse(evidence.validUntil)
  )
    return invalid("FEATURE_CONTROL_RECOVERY_DENIED");
  return evidence;
}

function validateTransition(
  operation: FeatureControlMutationOperation,
  current: FeatureControlDefinition,
  next: FeatureControlDefinition,
  recoveryEvidence: RecoveryValidationEvidence | undefined,
  at: number,
): void {
  if (operation === "Change") {
    if (
      current.kind === "KillSwitch" &&
      JSON.stringify(current.state) !== JSON.stringify(next.state)
    )
      invalid();
    return;
  }
  if (current.kind !== "KillSwitch" || next.kind !== "KillSwitch") invalid();
  if (stableConfiguration(current) !== stableConfiguration(next)) invalid();
  if (operation === "Activate") {
    if (next.state.phase !== "Active" || current.state.phase === "Active") invalid();
    return;
  }
  validateRecoveryEvidence(recoveryEvidence, current, next, at);
  if (operation === "BeginRecovery") {
    if (
      next.state.phase !== "Recovering" ||
      (current.state.phase !== "Active" && current.state.phase !== "Recovering")
    )
      invalid("FEATURE_CONTROL_RECOVERY_DENIED");
    const currentBasis =
      current.state.phase === "Recovering" ? current.state.rolloutBasisPoints : 0;
    if (next.state.rolloutBasisPoints <= currentBasis) invalid("FEATURE_CONTROL_RECOVERY_DENIED");
    if (current.recoveryPolicy === "Progressive") {
      const currentStageIndex =
        current.state.phase === "Recovering"
          ? current.recoveryStages.indexOf(current.state.rolloutBasisPoints)
          : -1;
      if (current.recoveryStages.at(currentStageIndex + 1) !== next.state.rolloutBasisPoints)
        invalid("FEATURE_CONTROL_RECOVERY_DENIED");
    }
    if (current.recoveryPolicy !== "Progressive" && next.state.rolloutBasisPoints !== 10_000)
      invalid("FEATURE_CONTROL_RECOVERY_DENIED");
    return;
  }
  if (
    current.state.phase !== "Recovering" ||
    current.state.rolloutBasisPoints !== 10_000 ||
    next.state.phase !== "Inactive"
  )
    invalid("FEATURE_CONTROL_RECOVERY_DENIED");
}

function resourceScope(definition: FeatureControlDefinition): PermissionResourceScope {
  return Object.freeze({
    kind: definition.scope.kind,
    brandReference: definition.scope.brandReference,
    storeReference: definition.scope.storeReference,
  });
}

function acceptedDecision(
  value: PermissionDecision,
  action: BusinessAction,
  definition: FeatureControlDefinition,
): boolean {
  try {
    if (
      !Object.isFrozen(value) ||
      !Object.isFrozen(value.audit) ||
      Object.keys(value).sort().join(",") !==
        "action,audit,effect,policySnapshotReference,policyVersion,reason,scopeKind,source" ||
      Object.keys(value.audit).sort().join(",") !== "effect,reason,source" ||
      value.effect !== "Allow" ||
      value.audit.effect !== "Allow" ||
      value.action !== action ||
      value.scopeKind !== definition.scope.kind ||
      value.reason !== value.audit.reason ||
      value.source !== value.audit.source ||
      !(
        (value.reason === "EXPLICIT_ALLOW" && value.source === "ExplicitAllow") ||
        (value.reason === "ROLE_PERMISSION" && value.source === "RolePermission")
      )
    )
      return false;
    parsePolicyReference(value.policySnapshotReference);
    parsePolicyVersion(value.policyVersion);
    return true;
  } catch {
    return false;
  }
}

function stateSummary(definition: FeatureControlDefinition): JsonObject {
  return {
    kind: definition.kind,
    scopeKind: definition.scope.kind,
    version: definition.version,
    state: definition.kind === "ReleaseFlag" ? definition.state : definition.state.phase,
  };
}

function auditRecord(
  input: ExecuteFeatureControlMutationInput,
  context: TenantContext,
  current: FeatureControlDefinition,
  next: FeatureControlDefinition,
): AppendAuditRecordInput {
  const actorReference = context.actor.actorReference;
  if (actorReference === null) return invalid();
  const audit: AppendAuditRecordInput = {
    auditId: input.auditId,
    brandId: current.scope.brandReference,
    ...(current.scope.storeReference === null ? {} : { storeId: current.scope.storeReference }),
    actor: {
      type: "User",
      reference: actorReference,
    },
    actionCode: operationAuditCodes[input.operation],
    targetType: "FeatureControl",
    targetId: current.controlId,
    beforeSummary: stateSummary(current),
    afterSummary: stateSummary(next),
    reasonCode: operationAuditCodes[input.operation],
    correlationId: input.correlationId,
    occurredAt: context.resolvedAt,
    sourceChannel: input.sourceChannel,
    dataClassification: "Internal",
    retentionPolicyCode: "FEATURE_CONTROL_AUDIT",
    retentionPolicyVersion: 1,
  };
  return validateAuditRecord(audit, Date.parse(context.resolvedAt));
}

export async function executeFeatureControlMutation(
  input: ExecuteFeatureControlMutationInput,
  ports: FeatureControlMutationPorts,
): Promise<ExecuteFeatureControlMutationResult> {
  let context: TenantContext;
  let current: FeatureControlDefinition;
  let next: FeatureControlDefinition;
  let expectedVersion: FeatureControlVersion;
  try {
    validateMutationEnvelope(input);
    if (
      !featureControlMutationOperations.includes(input.operation) ||
      !Object.isFrozen(input.current) ||
      !Object.isFrozen(input.next)
    )
      invalid();
    context = revalidateTenantContext(input.tenantContext);
    current = createFeatureControlDefinition(input.current);
    next = createFeatureControlDefinition(input.next);
    expectedVersion = parseFeatureControlVersion(input.expectedVersion);
    parseFeatureControlReference(input.auditId);
    parseFeatureControlReference(input.correlationId);
    parseFeatureControlPurposeCode(input.sourceChannel);
    if (!exactContext(context, current)) invalid();
    validateFamily(current, next, expectedVersion);
    validateTransition(
      input.operation,
      current,
      next,
      input.recoveryEvidence,
      Date.parse(context.resolvedAt),
    );
  } catch (error) {
    if (error instanceof FeatureControlServiceError) throw error;
    return invalid();
  }

  const action = operationActions[input.operation];
  let permission: PermissionDecision;
  try {
    permission = await ports.authorization.authorize({
      tenantContext: context,
      action,
      resourceScope: resourceScope(current),
      controlId: current.controlId,
      expectedVersion,
    });
  } catch {
    return invalid("FEATURE_CONTROL_PERMISSION_DENIED");
  }
  if (!acceptedDecision(permission, action, current)) invalid("FEATURE_CONTROL_PERMISSION_DENIED");

  let audit: AppendAuditRecordInput;
  try {
    audit = auditRecord(input, context, current, next);
  } catch {
    return invalid();
  }
  try {
    await ports.unitOfWork.commit({
      expectedVersion,
      current,
      next,
      audit,
    });
  } catch {
    return invalid("FEATURE_CONTROL_COMMIT_FAILED");
  }
  return Object.freeze({
    control: next,
    auditReference: input.auditId,
  });
}
