import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import type { TenantContext } from "@bop/tenant";
import {
  parseBusinessAction,
  revalidateTenantContext,
  type BusinessAction,
  type PermissionDecision,
} from "../contracts/permission-evaluation.js";
import {
  assertRoleAdministrationActivatable,
  createRoleAdministrationVersion,
  parseRoleAdministrationReference,
  parseRoleAdministrationVersion,
  type RoleAdministrationReference,
  type RoleAdministrationVersion,
  type RoleAdministrationVersionRecord,
} from "../contracts/role-administration.js";
import type { RoleAdministrationPorts } from "./ports/role-administration-ports.js";
export const roleAdministrationOperations = [
  "SaveDraft",
  "Duplicate",
  "Submit",
  "Approve",
  "Reject",
  "Activate",
  "Deactivate",
] as const;
export type RoleAdministrationOperation = (typeof roleAdministrationOperations)[number];
export class RoleAdministrationServiceError extends Error {
  constructor(
    readonly code:
      | "ROLE_ADMIN_MUTATION_INVALID"
      | "ROLE_ADMIN_PERMISSION_DENIED"
      | "ROLE_ADMIN_POLICY_CONFLICT"
      | "ROLE_ADMIN_COMMIT_FAILED",
  ) {
    super(
      code === "ROLE_ADMIN_PERMISSION_DENIED"
        ? "role administration permission is denied"
        : code === "ROLE_ADMIN_POLICY_CONFLICT"
          ? "role policy version changed"
          : code === "ROLE_ADMIN_COMMIT_FAILED"
            ? "role administration commit failed"
            : "role administration mutation is invalid",
    );
    this.name = "RoleAdministrationServiceError";
  }
}
const actions: Record<RoleAdministrationOperation, BusinessAction> = {
  SaveDraft: parseBusinessAction("identity.role.change"),
  Duplicate: parseBusinessAction("identity.role.create"),
  Submit: parseBusinessAction("identity.role.change"),
  Approve: parseBusinessAction("identity.role.approve"),
  Reject: parseBusinessAction("identity.role.approve"),
  Activate: parseBusinessAction("identity.role.activate"),
  Deactivate: parseBusinessAction("identity.role.deactivate"),
};
export interface ExecuteRoleAdministrationInput {
  readonly tenantContext: TenantContext;
  readonly operation: RoleAdministrationOperation;
  readonly expectedVersion: RoleAdministrationVersion;
  readonly idempotencyKey: string;
  readonly current: RoleAdministrationVersionRecord;
  readonly next: RoleAdministrationVersionRecord;
  readonly auditId: RoleAdministrationReference;
  readonly correlationId: RoleAdministrationReference;
  readonly sourceChannel: string;
}
const invalid = (
  code: RoleAdministrationServiceError["code"] = "ROLE_ADMIN_MUTATION_INVALID",
): never => {
  throw new RoleAdministrationServiceError(code);
};
function transition(
  operation: RoleAdministrationOperation,
  current: RoleAdministrationVersionRecord,
  next: RoleAdministrationVersionRecord,
): void {
  if (current.roleType === "System") invalid();
  const pair: Readonly<
    Record<
      Exclude<RoleAdministrationOperation, "Duplicate">,
      readonly [
        RoleAdministrationVersionRecord["lifecycle"],
        RoleAdministrationVersionRecord["lifecycle"],
      ]
    >
  > = {
    SaveDraft: ["Draft", "Draft"],
    Submit: ["Draft", "InReview"],
    Approve: ["InReview", "Approved"],
    Reject: ["InReview", "Rejected"],
    Activate: ["Approved", "Active"],
    Deactivate: ["Active", "Deactivated"],
  };
  if (operation === "Duplicate") {
    if (
      next.lifecycle !== "Draft" ||
      next.roleReference === current.roleReference ||
      next.administrationReference === current.administrationReference ||
      next.roleType !== "Custom"
    )
      invalid();
    return;
  }
  const expected = pair[operation];
  if (
    current.lifecycle !== expected[0] ||
    next.lifecycle !== expected[1] ||
    current.roleReference !== next.roleReference ||
    current.administrationReference !== next.administrationReference
  )
    invalid();
}
function accepted(
  decision: PermissionDecision,
  action: BusinessAction,
  current: RoleAdministrationVersionRecord,
): boolean {
  return (
    Object.isFrozen(decision) &&
    decision.effect === "Allow" &&
    decision.action === action &&
    decision.scopeKind === (current.storeReference === null ? "Brand" : "Store") &&
    ((decision.reason === "EXPLICIT_ALLOW" && decision.source === "ExplicitAllow") ||
      (decision.reason === "ROLE_PERMISSION" && decision.source === "RolePermission"))
  );
}
function audit(
  input: ExecuteRoleAdministrationInput,
  context: TenantContext,
): AppendAuditRecordInput {
  const actorReference = context.actor.actorReference;
  if (actorReference === null) return invalid();
  return validateAuditRecord(
    {
      auditId: input.auditId,
      brandId: input.current.brandReference,
      ...(input.current.storeReference === null ? {} : { storeId: input.current.storeReference }),
      actor: { type: "User", reference: actorReference },
      actionCode: `ROLE_ADMIN_${input.operation.toUpperCase()}`,
      targetType: "PermissionRole",
      targetId: input.current.roleReference,
      beforeSummary: {
        lifecycle: input.current.lifecycle,
        version: input.current.version,
        permissionCount: input.current.selections.length,
      },
      afterSummary: {
        lifecycle: input.next.lifecycle,
        version: input.next.version,
        permissionCount: input.next.selections.length,
      },
      reasonCode: input.next.reasonCode,
      correlationId: input.correlationId,
      occurredAt: context.resolvedAt,
      sourceChannel: input.sourceChannel,
      dataClassification: "Internal",
      retentionPolicyCode: "PERMISSION_POLICY_AUDIT",
      retentionPolicyVersion: 1,
    },
    Date.parse(context.resolvedAt),
  );
}
export async function executeRoleAdministration(
  input: ExecuteRoleAdministrationInput,
  ports: RoleAdministrationPorts,
): Promise<RoleAdministrationVersionRecord> {
  let context: TenantContext,
    current: RoleAdministrationVersionRecord,
    next: RoleAdministrationVersionRecord;
  try {
    context = revalidateTenantContext(input.tenantContext);
    current = createRoleAdministrationVersion(input.current);
    next = createRoleAdministrationVersion(input.next);
    parseRoleAdministrationVersion(input.expectedVersion);
    parseRoleAdministrationReference(input.auditId);
    parseRoleAdministrationReference(input.correlationId);
  } catch {
    return invalid();
  }
  if (
    !/^[a-z0-9][a-z0-9._:-]{7,127}$/u.test(input.idempotencyKey) ||
    !/^[A-Z][A-Z0-9_]{2,63}$/u.test(input.sourceChannel) ||
    current.version !== input.expectedVersion ||
    next.version !== (input.operation === "Duplicate" ? 1 : current.version + 1) ||
    current.brandReference !== next.brandReference ||
    current.storeReference !== next.storeReference ||
    context.brand.brandReference !== current.brandReference ||
    (current.storeReference !== null && context.store?.storeReference !== current.storeReference)
  )
    invalid();
  transition(input.operation, current, next);
  const action = actions[input.operation],
    decision = await ports.authorization.authorize({
      tenantContext: context,
      action,
      resourceScope: {
        kind: current.storeReference === null ? "Brand" : "Store",
        brandReference: current.brandReference,
        storeReference: current.storeReference,
      },
      roleReference: current.roleReference,
      expectedVersion: current.version,
    });
  if (!accepted(decision, action, current)) return invalid("ROLE_ADMIN_PERMISSION_DENIED");
  let activatePolicy = false;
  if (input.operation === "Activate" || input.operation === "Deactivate") {
    const policyVersion = await ports.policy.currentVersion(current.brandReference);
    if (policyVersion !== current.sourcePolicyVersion || next.sourcePolicyVersion !== policyVersion)
      return invalid("ROLE_ADMIN_POLICY_CONFLICT");
    const affected = await ports.impact.countActiveAssignments(current.roleReference);
    if (!Number.isSafeInteger(affected) || affected < 0) return invalid();
    assertRoleAdministrationActivatable(current, next, affected);
    activatePolicy = true;
  }
  try {
    await ports.unitOfWork.commit({
      idempotencyKey: input.idempotencyKey,
      expectedVersion: current.version,
      current,
      next,
      activatePolicy,
      audit: audit(input, context),
    });
  } catch {
    return invalid("ROLE_ADMIN_COMMIT_FAILED");
  }
  return next;
}
