import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import {
  parseBusinessAction,
  revalidateTenantContext,
  type BusinessAction,
  type PermissionDecision,
} from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import {
  assertLiveGateReady,
  createLiveGateRecord,
  type LiveGateRecord,
} from "../contracts/live-gate.js";
import {
  parsePublishingCode,
  parsePublishingReference,
  parsePublishingVersion,
  type PublishingCode,
  type PublishingReference,
  type PublishingVersion,
} from "../contracts/publishing.js";
import type { LiveGateMutationPorts } from "./ports/live-gate-ports.js";
export const liveGateOperations = [
  "AttachEvidence",
  "RequestReview",
  "Approve",
  "Reject",
  "Reopen",
] as const;
export type LiveGateOperation = (typeof liveGateOperations)[number];
export class LiveGateServiceError extends Error {
  constructor(
    readonly code:
      "LIVE_GATE_MUTATION_INVALID" | "LIVE_GATE_PERMISSION_DENIED" | "LIVE_GATE_COMMIT_FAILED",
  ) {
    super(
      code === "LIVE_GATE_PERMISSION_DENIED"
        ? "live gate permission is denied"
        : code === "LIVE_GATE_COMMIT_FAILED"
          ? "live gate commit failed"
          : "live gate mutation is invalid",
    );
    this.name = "LiveGateServiceError";
  }
}
const actionByOperation: Record<LiveGateOperation, BusinessAction> = {
  AttachEvidence: parseBusinessAction("publishing.livegate.attach"),
  RequestReview: parseBusinessAction("publishing.livegate.submit"),
  Approve: parseBusinessAction("publishing.livegate.approve"),
  Reject: parseBusinessAction("publishing.livegate.approve"),
  Reopen: parseBusinessAction("publishing.livegate.reopen"),
};
export interface ExecuteLiveGateMutationInput {
  readonly tenantContext: TenantContext;
  readonly operation: LiveGateOperation;
  readonly expectedVersion: PublishingVersion;
  readonly idempotencyKey: string;
  readonly current: LiveGateRecord;
  readonly next: LiveGateRecord;
  readonly auditId: PublishingReference;
  readonly correlationId: PublishingReference;
  readonly sourceChannel: PublishingCode;
}
const invalid = (code: LiveGateServiceError["code"] = "LIVE_GATE_MUTATION_INVALID"): never => {
  throw new LiveGateServiceError(code);
};
function validateTransition(
  operation: LiveGateOperation,
  current: LiveGateRecord,
  next: LiveGateRecord,
): void {
  if (operation === "AttachEvidence" && !["Draft", "Blocked", "Reopened"].includes(current.state))
    invalid();
  if (operation === "AttachEvidence" && next.state !== "Blocked") invalid();
  if (operation === "RequestReview" && !["Blocked", "Reopened"].includes(current.state)) invalid();
  if (operation === "RequestReview" && next.state !== "InReview") invalid();
  if (operation === "Approve" && (current.state !== "InReview" || next.state !== "Approved"))
    invalid();
  if (operation === "Reject" && (current.state !== "InReview" || next.state !== "Rejected"))
    invalid();
  if (
    operation === "Reopen" &&
    (!["Approved", "Rejected"].includes(current.state) || next.state !== "Reopened")
  )
    invalid();
  if (operation === "Approve") assertLiveGateReady(next, next.changedAt);
}
function accepted(
  decision: PermissionDecision,
  action: BusinessAction,
  current: LiveGateRecord,
): boolean {
  return (
    Object.isFrozen(decision) &&
    decision.effect === "Allow" &&
    decision.action === action &&
    decision.scopeKind === "Store" &&
    ((decision.reason === "EXPLICIT_ALLOW" && decision.source === "ExplicitAllow") ||
      (decision.reason === "ROLE_PERMISSION" && decision.source === "RolePermission")) &&
    current.scope.storeReference !== null
  );
}
function createAudit(
  input: ExecuteLiveGateMutationInput,
  context: TenantContext,
): AppendAuditRecordInput {
  const actorReference = context.actor.actorReference;
  if (actorReference === null) return invalid();
  return validateAuditRecord(
    {
      auditId: input.auditId,
      brandId: input.current.scope.brandReference,
      storeId: input.current.scope.storeReference,
      actor: { type: "User", reference: actorReference },
      actionCode: parsePublishingCode(`LIVE_GATE_${input.operation.toUpperCase()}`),
      targetType: "LiveGate",
      targetId: input.current.gateReference,
      beforeSummary: { state: input.current.state, version: input.current.version },
      afterSummary: { state: input.next.state, version: input.next.version },
      reasonCode: parsePublishingCode("LIVE_GATE_WORKFLOW"),
      correlationId: input.correlationId,
      occurredAt: context.resolvedAt,
      sourceChannel: input.sourceChannel,
      dataClassification: "Internal",
      retentionPolicyCode: "LIVE_GATE_AUDIT",
      retentionPolicyVersion: 1,
    },
    Date.parse(context.resolvedAt),
  );
}
export async function executeLiveGateMutation(
  input: ExecuteLiveGateMutationInput,
  ports: LiveGateMutationPorts,
): Promise<LiveGateRecord> {
  let context: TenantContext;
  let current: LiveGateRecord;
  let next: LiveGateRecord;
  try {
    context = revalidateTenantContext(input.tenantContext);
    current = createLiveGateRecord(input.current);
    next = createLiveGateRecord(input.next);
    parsePublishingVersion(input.expectedVersion);
    parsePublishingReference(input.auditId);
    parsePublishingReference(input.correlationId);
    parsePublishingCode(input.sourceChannel);
  } catch {
    return invalid();
  }
  if (
    !/^[a-z0-9][a-z0-9._:-]{7,127}$/u.test(input.idempotencyKey) ||
    current.version !== input.expectedVersion ||
    next.version !== current.version + 1 ||
    current.gateReference !== next.gateReference ||
    current.gateId !== next.gateId ||
    current.scope.tenantReference !== next.scope.tenantReference ||
    current.scope.brandReference !== next.scope.brandReference ||
    current.scope.storeReference !== next.scope.storeReference ||
    context.brand.brandReference !== current.scope.brandReference ||
    context.store?.storeReference !== current.scope.storeReference
  )
    invalid();
  validateTransition(input.operation, current, next);
  const action = actionByOperation[input.operation];
  const decision = await ports.authorization.authorize({
    tenantContext: context,
    action,
    resourceScope: {
      kind: "Store",
      brandReference: current.scope.brandReference,
      storeReference: current.scope.storeReference,
    },
    gateReference: current.gateReference,
    expectedVersion: current.version,
  });
  if (!accepted(decision, action, current)) return invalid("LIVE_GATE_PERMISSION_DENIED");
  try {
    await ports.unitOfWork.commit({
      idempotencyKey: input.idempotencyKey,
      expectedVersion: current.version,
      current,
      next,
      audit: createAudit(input, context),
    });
  } catch {
    return invalid("LIVE_GATE_COMMIT_FAILED");
  }
  return next;
}
