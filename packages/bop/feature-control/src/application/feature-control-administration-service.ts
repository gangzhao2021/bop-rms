import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import {
  parseBusinessAction,
  revalidateTenantContext,
  type BusinessAction,
  type PermissionDecision,
} from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import {
  assertFeatureControlDependenciesPublishable,
  createFeatureControlAdministrationDefinition,
  type FeatureControlAdministrationDefinition,
} from "../contracts/feature-control-administration.js";
import {
  parseFeatureControlPurposeCode,
  parseFeatureControlReference,
  parseFeatureControlVersion,
  type FeatureControlPurposeCode,
  type FeatureControlReference,
  type FeatureControlVersion,
} from "../contracts/feature-control.js";
import type { FeatureControlAdministrationPorts } from "./ports/feature-control-administration-ports.js";
export const featureControlAdministrationOperations = [
  "SaveDraft",
  "Submit",
  "Approve",
  "Publish",
  "Schedule",
  "Disable",
] as const;
export type FeatureControlAdministrationOperation =
  (typeof featureControlAdministrationOperations)[number];
export class FeatureControlAdministrationServiceError extends Error {
  constructor(
    readonly code:
      | "FEATURE_CONTROL_ADMIN_MUTATION_INVALID"
      | "FEATURE_CONTROL_ADMIN_PERMISSION_DENIED"
      | "FEATURE_CONTROL_ADMIN_COMMIT_FAILED",
  ) {
    super(
      code === "FEATURE_CONTROL_ADMIN_PERMISSION_DENIED"
        ? "feature control administration permission is denied"
        : code === "FEATURE_CONTROL_ADMIN_COMMIT_FAILED"
          ? "feature control administration commit failed"
          : "feature control administration mutation is invalid",
    );
    this.name = "FeatureControlAdministrationServiceError";
  }
}
const actions: Record<FeatureControlAdministrationOperation, BusinessAction> = {
  SaveDraft: parseBusinessAction("feature.control.change"),
  Submit: parseBusinessAction("feature.control.change"),
  Approve: parseBusinessAction("feature.control.approve"),
  Publish: parseBusinessAction("feature.control.publish"),
  Schedule: parseBusinessAction("feature.control.publish"),
  Disable: parseBusinessAction("feature.control.activate"),
};
export interface ExecuteFeatureControlAdministrationInput {
  readonly tenantContext: TenantContext;
  readonly operation: FeatureControlAdministrationOperation;
  readonly expectedVersion: FeatureControlVersion;
  readonly idempotencyKey: string;
  readonly current: FeatureControlAdministrationDefinition;
  readonly next: FeatureControlAdministrationDefinition;
  readonly auditId: FeatureControlReference;
  readonly correlationId: FeatureControlReference;
  readonly sourceChannel: FeatureControlPurposeCode;
}
const invalid = (
  code: FeatureControlAdministrationServiceError["code"] = "FEATURE_CONTROL_ADMIN_MUTATION_INVALID",
): never => {
  throw new FeatureControlAdministrationServiceError(code);
};
function transition(
  operation: FeatureControlAdministrationOperation,
  current: FeatureControlAdministrationDefinition,
  next: FeatureControlAdministrationDefinition,
): void {
  const expected = {
    SaveDraft: ["Draft", "Draft"],
    Submit: ["Draft", "PendingApproval"],
    Approve: ["PendingApproval", "Approved"],
    Publish: ["Approved", "Published"],
    Schedule: ["Approved", "Published"],
    Disable: ["Published", "Disabled"],
  } as const;
  const pair = expected[operation];
  if (current.lifecycle !== pair[0] || next.lifecycle !== pair[1]) invalid();
  if ((operation === "Publish" || operation === "Schedule") && next.publicationReference !== null)
    assertFeatureControlDependenciesPublishable(next);
}
function allowed(
  decision: PermissionDecision,
  action: BusinessAction,
  current: FeatureControlAdministrationDefinition,
): boolean {
  return (
    Object.isFrozen(decision) &&
    decision.effect === "Allow" &&
    decision.action === action &&
    decision.scopeKind === current.scope.kind &&
    ((decision.reason === "EXPLICIT_ALLOW" && decision.source === "ExplicitAllow") ||
      (decision.reason === "ROLE_PERMISSION" && decision.source === "RolePermission"))
  );
}
function audit(
  input: ExecuteFeatureControlAdministrationInput,
  context: TenantContext,
): AppendAuditRecordInput {
  const actorReference = context.actor.actorReference;
  if (actorReference === null) return invalid();
  return validateAuditRecord(
    {
      auditId: input.auditId,
      brandId: input.current.scope.brandReference,
      ...(input.current.scope.storeReference === null
        ? {}
        : { storeId: input.current.scope.storeReference }),
      actor: { type: "User", reference: actorReference },
      actionCode: parseFeatureControlPurposeCode(
        `FEATURE_CONTROL_${input.operation.toUpperCase()}`,
      ),
      targetType: "FeatureControl",
      targetId: input.current.controlId,
      beforeSummary: { lifecycle: input.current.lifecycle, version: input.current.version },
      afterSummary: { lifecycle: input.next.lifecycle, version: input.next.version },
      reasonCode: input.next.purposeCode,
      correlationId: input.correlationId,
      occurredAt: context.resolvedAt,
      sourceChannel: input.sourceChannel,
      dataClassification: "Internal",
      retentionPolicyCode: "FEATURE_CONTROL_AUDIT",
      retentionPolicyVersion: 1,
    },
    Date.parse(context.resolvedAt),
  );
}
export async function executeFeatureControlAdministration(
  input: ExecuteFeatureControlAdministrationInput,
  ports: FeatureControlAdministrationPorts,
): Promise<FeatureControlAdministrationDefinition> {
  let context: TenantContext;
  let current: FeatureControlAdministrationDefinition;
  let next: FeatureControlAdministrationDefinition;
  try {
    context = revalidateTenantContext(input.tenantContext);
    current = createFeatureControlAdministrationDefinition(input.current);
    next = createFeatureControlAdministrationDefinition(input.next);
    parseFeatureControlVersion(input.expectedVersion);
    parseFeatureControlReference(input.auditId);
    parseFeatureControlReference(input.correlationId);
    parseFeatureControlPurposeCode(input.sourceChannel);
  } catch {
    return invalid();
  }
  if (
    !/^[a-z0-9][a-z0-9._:-]{7,127}$/u.test(input.idempotencyKey) ||
    current.version !== input.expectedVersion ||
    next.version !== current.version + 1 ||
    current.controlId !== next.controlId ||
    current.key !== next.key ||
    current.scope.kind !== next.scope.kind ||
    current.scope.brandReference !== next.scope.brandReference ||
    current.scope.storeReference !== next.scope.storeReference ||
    context.brand.brandReference !== current.scope.brandReference ||
    (context.store?.storeReference ?? null) !== current.scope.storeReference
  )
    invalid();
  transition(input.operation, current, next);
  const action = actions[input.operation];
  const decision = await ports.authorization.authorize({
    tenantContext: context,
    action,
    resourceScope: {
      kind: current.scope.kind,
      brandReference: current.scope.brandReference,
      storeReference: current.scope.storeReference,
    },
    controlId: current.controlId,
    expectedVersion: current.version,
  });
  if (!allowed(decision, action, current))
    return invalid("FEATURE_CONTROL_ADMIN_PERMISSION_DENIED");
  try {
    await ports.unitOfWork.commit({
      idempotencyKey: input.idempotencyKey,
      expectedVersion: current.version,
      current,
      next,
      audit: audit(input, context),
    });
  } catch {
    return invalid("FEATURE_CONTROL_ADMIN_COMMIT_FAILED");
  }
  return next;
}
