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
import { equalsPreset, lockedRoleCodes, rolePresetActions } from "../catalog/role-presets.js";
import type { RoleAdministrationPorts } from "./ports/role-administration-ports.js";
export const roleAdministrationOperations = [
  "SaveDraft",
  "Duplicate",
  "Submit",
  "Approve",
  "Reject",
  "Activate",
  "Deactivate",
  // WP-2423 role presets (Owner request 2026-11-06).
  "Create",
  "Revise",
  "RestoreDefault",
  "Withdraw",
  "ApproveAlone",
] as const;
export type RoleAdministrationOperation = (typeof roleAdministrationOperations)[number];
export class RoleAdministrationServiceError extends Error {
  constructor(
    readonly code:
      | "ROLE_ADMIN_MUTATION_INVALID"
      | "ROLE_ADMIN_PERMISSION_DENIED"
      | "ROLE_ADMIN_POLICY_CONFLICT"
      | "ROLE_ADMIN_ROLE_IN_USE"
      | "ROLE_ADMIN_COMMIT_FAILED",
  ) {
    super(
      code === "ROLE_ADMIN_PERMISSION_DENIED"
        ? "role administration permission is denied"
        : code === "ROLE_ADMIN_POLICY_CONFLICT"
          ? "role policy version changed"
          : code === "ROLE_ADMIN_ROLE_IN_USE"
            ? "role still has active assignments"
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
  Create: parseBusinessAction("identity.role.create"),
  Submit: parseBusinessAction("identity.role.change"),
  Revise: parseBusinessAction("identity.role.change"),
  RestoreDefault: parseBusinessAction("identity.role.change"),
  Withdraw: parseBusinessAction("identity.role.change"),
  Approve: parseBusinessAction("identity.role.approve"),
  ApproveAlone: parseBusinessAction("identity.role.approve"),
  Reject: parseBusinessAction("identity.role.approve"),
  Activate: parseBusinessAction("identity.role.activate"),
  Deactivate: parseBusinessAction("identity.role.deactivate"),
};
/** The permission each operation needs, for callers that show or pre-check it. */
export const roleAdministrationOperationActions: Readonly<
  Record<RoleAdministrationOperation, BusinessAction>
> = Object.freeze({ ...actions });
export interface ExecuteRoleAdministrationInput {
  readonly tenantContext: TenantContext;
  readonly operation: RoleAdministrationOperation;
  /** The role's latest version; null for Create. */
  readonly expectedVersion: RoleAdministrationVersion | null;
  readonly idempotencyKey: string;
  /** The role's latest version (for Duplicate, the role copied); null for Create. */
  readonly current: RoleAdministrationVersionRecord | null;
  /**
   * WP-2423 role presets: the version staff hold now (the latest Active or Deactivated one), or
   * null when the role was never turned on. Deactivate, Activate and Revise after a withdrawn or
   * rejected change work from it.
   */
  readonly effective?: RoleAdministrationVersionRecord | null;
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
const closed = (lifecycle: RoleAdministrationVersionRecord["lifecycle"]) =>
  lifecycle === "Rejected" || lifecycle === "Withdrawn";
const sameActions = (a: RoleAdministrationVersionRecord, b: RoleAdministrationVersionRecord) =>
  equalsPreset(
    a.selections.map((item) => item.action),
    b.selections.map((item) => item.action),
  );
const presetOf = (record: RoleAdministrationVersionRecord) =>
  rolePresetActions(record.code, record.storeReference === null ? "Brand" : "Store");
/**
 * The version an operation on the role's state works from: the latest version, or after a
 * withdrawn or rejected change the version staff hold now.
 */
function basis(
  current: RoleAdministrationVersionRecord,
  effective: RoleAdministrationVersionRecord | null,
): RoleAdministrationVersionRecord | null {
  if (!closed(current.lifecycle)) return current;
  return effective;
}
function transition(
  operation: RoleAdministrationOperation,
  current: RoleAdministrationVersionRecord | null,
  effective: RoleAdministrationVersionRecord | null,
  next: RoleAdministrationVersionRecord,
  actor: string,
): void {
  if (operation === "Create") {
    if (
      current !== null ||
      next.version !== 1 ||
      next.lifecycle !== "Draft" ||
      next.roleType !== "Custom" ||
      next.authoredByReference !== actor
    )
      invalid();
    return;
  }
  if (current === null) return invalid();
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
  if (
    current.roleReference !== next.roleReference ||
    current.administrationReference !== next.administrationReference ||
    current.code !== next.code ||
    (effective !== null &&
      (effective.roleReference !== current.roleReference ||
        effective.administrationReference !== current.administrationReference ||
        effective.version > current.version ||
        !["Active", "Deactivated"].includes(effective.lifecycle)))
  )
    return invalid();
  const locked = lockedRoleCodes.has(current.code);
  const from = basis(current, effective);
  switch (operation) {
    case "SaveDraft":
    case "Submit":
    case "Approve":
    case "ApproveAlone":
    case "Reject": {
      const pair = {
        SaveDraft: ["Draft", "Draft"],
        Submit: ["Draft", "InReview"],
        Approve: ["InReview", "Approved"],
        ApproveAlone: ["InReview", "Approved"],
        Reject: ["InReview", "Rejected"],
      }[operation];
      if (
        current.roleType !== "Custom" ||
        next.roleType !== "Custom" ||
        current.lifecycle !== pair[0] ||
        next.lifecycle !== pair[1]
      )
        invalid();
      // The submitter approves alone only as sole operator; nobody else approves as them.
      if (operation === "Approve" && next.approvalMode !== "Independent") invalid();
      if (
        operation === "ApproveAlone" &&
        (next.approvalMode !== "SoleOperator" ||
          current.submittedByReference !== actor ||
          next.approvedByReference !== actor)
      )
        invalid();
      return;
    }
    case "Withdraw": {
      // A waiting change is taken back by the person who wrote, sent or approved it.
      const people =
        current.lifecycle === "Draft"
          ? [current.authoredByReference]
          : current.lifecycle === "InReview"
            ? [current.submittedByReference]
            : current.lifecycle === "Approved"
              ? [current.submittedByReference, current.approvedByReference]
              : [];
      if (
        !people.includes(actor as RoleAdministrationReference) ||
        current.roleType !== "Custom" ||
        next.roleType !== "Custom" ||
        next.lifecycle !== "Withdrawn" ||
        !sameActions(current, next)
      )
        invalid();
      return;
    }
    case "Revise":
    case "RestoreDefault": {
      // A change starts from the version staff hold (or a role never turned on), never while
      // another change waits and never on a removed role (bring it back first).
      const fromActive = from !== null && from.lifecycle === "Active";
      const neverOn = from === null && closed(current.lifecycle);
      if (
        locked ||
        !(fromActive || neverOn) ||
        next.lifecycle !== "Draft" ||
        next.roleType !== "Custom" ||
        next.authoredByReference !== actor ||
        next.submittedByReference !== null
      )
        invalid();
      if (operation === "RestoreDefault") {
        const preset = presetOf(current);
        if (
          preset === null ||
          from === null ||
          from.roleType !== "Custom" ||
          !equalsPreset(
            next.selections.map((item) => item.action),
            preset,
          )
        )
          invalid();
      }
      return;
    }
    case "Activate": {
      if (current.lifecycle === "Approved") {
        if (
          next.lifecycle !== "Active" ||
          current.roleType !== "Custom" ||
          !sameActions(current, next)
        )
          invalid();
        // A Store's version equal to the BOP preset now is the preset again, so BOP updates apply
        // to it; any other version stays the Store's own.
        const preset = presetOf(current);
        const isPreset =
          preset !== null &&
          equalsPreset(
            next.selections.map((item) => item.action),
            preset,
          );
        if (next.roleType !== (isPreset ? "System" : "Custom")) invalid();
        return;
      }
      // Bring back a removed role with the content it had.
      if (
        from === null ||
        from.lifecycle !== "Deactivated" ||
        next.lifecycle !== "Active" ||
        next.roleType !== from.roleType ||
        !sameActions(from, next)
      )
        invalid();
      return;
    }
    case "Deactivate": {
      if (
        locked ||
        from === null ||
        from.lifecycle !== "Active" ||
        next.lifecycle !== "Deactivated" ||
        next.roleType !== from.roleType ||
        !sameActions(from, next)
      )
        invalid();
      return;
    }
  }
}
function accepted(
  decision: PermissionDecision,
  action: BusinessAction,
  scope: RoleAdministrationVersionRecord,
): boolean {
  return (
    Object.isFrozen(decision) &&
    decision.effect === "Allow" &&
    decision.action === action &&
    decision.scopeKind === (scope.storeReference === null ? "Brand" : "Store") &&
    ((decision.reason === "EXPLICIT_ALLOW" && decision.source === "ExplicitAllow") ||
      (decision.reason === "ROLE_PERMISSION" && decision.source === "RolePermission"))
  );
}
function audit(
  input: ExecuteRoleAdministrationInput,
  context: TenantContext,
  current: RoleAdministrationVersionRecord | null,
  next: RoleAdministrationVersionRecord,
  actorMfaAt: string | null,
): AppendAuditRecordInput {
  const actorReference = context.actor.actorReference;
  if (actorReference === null) return invalid();
  return validateAuditRecord(
    {
      auditId: input.auditId,
      brandId: next.brandReference,
      ...(next.storeReference === null ? {} : { storeId: next.storeReference }),
      actor: { type: "User", reference: actorReference },
      actionCode: `ROLE_ADMIN_${input.operation.toUpperCase()}`,
      targetType: "PermissionRole",
      targetId:
        current === null || input.operation === "Duplicate"
          ? next.roleReference
          : current.roleReference,
      ...(current === null
        ? {}
        : {
            beforeSummary: {
              lifecycle: current.lifecycle,
              version: current.version,
              permissionCount: current.selections.length,
            },
          }),
      afterSummary: {
        lifecycle: next.lifecycle,
        version: next.version,
        permissionCount: next.selections.length,
        roleType: next.roleType,
        ...(actorMfaAt === null ? {} : { approvalMode: "SoleOperator", actorMfaAt }),
      },
      reasonCode: next.reasonCode,
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
    current: RoleAdministrationVersionRecord | null,
    effective: RoleAdministrationVersionRecord | null,
    next: RoleAdministrationVersionRecord;
  try {
    context = revalidateTenantContext(input.tenantContext);
    current = input.current === null ? null : createRoleAdministrationVersion(input.current);
    effective =
      input.effective === undefined || input.effective === null
        ? null
        : createRoleAdministrationVersion(input.effective);
    next = createRoleAdministrationVersion(input.next);
    if (input.expectedVersion !== null) parseRoleAdministrationVersion(input.expectedVersion);
    parseRoleAdministrationReference(input.auditId);
    parseRoleAdministrationReference(input.correlationId);
  } catch {
    return invalid();
  }
  const actor = String(context.actor.actorReference);
  const scope = current ?? next;
  if (
    !/^[a-z0-9][a-z0-9._:-]{7,127}$/u.test(input.idempotencyKey) ||
    !/^[A-Z][A-Z0-9_]{2,63}$/u.test(input.sourceChannel) ||
    (current === null) !== (input.operation === "Create") ||
    (current === null
      ? input.expectedVersion !== null
      : current.version !== input.expectedVersion) ||
    next.version !==
      (current === null || input.operation === "Duplicate" ? 1 : current.version + 1) ||
    scope.brandReference !== next.brandReference ||
    scope.storeReference !== next.storeReference ||
    context.brand.brandReference !== scope.brandReference ||
    (scope.storeReference !== null && context.store?.storeReference !== scope.storeReference)
  )
    invalid();
  transition(input.operation, current, effective, next, actor);
  const action = actions[input.operation],
    decision = await ports.authorization.authorize({
      tenantContext: context,
      action,
      resourceScope: {
        kind: scope.storeReference === null ? "Brand" : "Store",
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
      },
      roleReference: scope.roleReference,
      expectedVersion: (current?.version ?? 1) as RoleAdministrationVersion,
    });
  if (!accepted(decision, action, scope)) return invalid("ROLE_ADMIN_PERMISSION_DENIED");
  let activatePolicy = false;
  if (input.operation === "Activate" || input.operation === "Deactivate") {
    // The approved content cannot change after approval, so it is revalidated against the policy
    // current now and stamped with that version instead of requiring the drafting-time version.
    const policyVersion = await ports.policy.currentVersion(scope.brandReference);
    if (next.sourcePolicyVersion !== policyVersion) return invalid("ROLE_ADMIN_POLICY_CONFLICT");
    const affected = await ports.impact.countActiveAssignments(scope.roleReference);
    if (!Number.isSafeInteger(affected) || affected < 0) return invalid();
    if (input.operation === "Deactivate") {
      // Removing a role still held by staff, or one a staff role request still waits to give,
      // would silently take away (or later fail to give) their access.
      const waiting = await ports.impact.countOpenAssignmentChanges(scope.roleReference);
      if (!Number.isSafeInteger(waiting) || waiting < 0) return invalid();
      if (affected > 0 || waiting > 0) return invalid("ROLE_ADMIN_ROLE_IN_USE");
    }
    assertRoleAdministrationActivatable(
      basis(current as RoleAdministrationVersionRecord, effective) ?? next,
      next,
      affected,
    );
    activatePolicy = true;
  }
  if (input.operation === "ApproveAlone" && ports.soleOperator === undefined)
    return invalid("ROLE_ADMIN_PERMISSION_DENIED");
  try {
    await ports.unitOfWork.commit({
      idempotencyKey: input.idempotencyKey,
      expectedVersion: current === null ? null : current.version,
      current,
      next,
      activatePolicy,
      soleOperator: input.operation === "ApproveAlone" ? (ports.soleOperator ?? null) : null,
      audit: (actorMfaAt) => audit(input, context, current, next, actorMfaAt),
    });
  } catch {
    return invalid("ROLE_ADMIN_COMMIT_FAILED");
  }
  return next;
}
