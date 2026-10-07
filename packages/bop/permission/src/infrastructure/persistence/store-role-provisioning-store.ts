import { appendAuditRecordInTransaction, appendPlatformAuditRecordInTransaction } from "@bop/audit";
import {
  storePermissionCatalog,
  storePermissionCatalogVersion,
} from "../../catalog/store-permission-catalog.js";
import {
  parseStoreRoleProvisioningPlan,
  storeRoleProvisioningPlanDigest,
  StoreRoleProvisioningError,
  verifyStoreRoleProvisioningApproval,
  type StoreRoleProvisioningApproval,
} from "../../contracts/store-role-provisioning.js";
import { permissionCatalogDigest } from "./permission-catalog-synchronizer.js";

export interface StoreRoleProvisioningTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export interface StoreRoleProvisioningOptions {
  readonly clock: { now(): string };
  /** Reads the signed approval and the current approver trust; called again before COMMIT. */
  readonly readApprovalMaterial: () => Promise<{
    readonly approval: unknown;
    readonly trust: unknown;
  }>;
  /** Store owner's public confirmation that the Store belongs to the Brand and can be opened. */
  readonly storeScope: {
    confirm(
      tx: StoreRoleProvisioningTransaction,
      scope: { readonly brandReference: string; readonly storeReference: string },
    ): Promise<boolean>;
  };
  readonly nextReference: () => string;
}
export interface StoreRoleProvisioningResult {
  readonly status: "Applied" | "AlreadyApplied";
  readonly planDigest: string;
  readonly roleCount: number;
  readonly grantCount: number;
  readonly policyVersion: number;
}

const conflict = (): never => {
  throw new StoreRoleProvisioningError("STORE_ROLE_PROVISIONING_CONFLICT");
};
const groupCode = (action: string): string =>
  (
    storePermissionCatalog().find((entry) => entry.code === action)?.module ??
    action.split(".")[0] ??
    action
  )
    .replaceAll("-", "_")
    .toLowerCase();
const highRisk = new Set(
  storePermissionCatalog()
    .filter((entry) => entry.risk === "High")
    .map((entry) => entry.code),
);

/**
 * WP-2423 / DEC-PERM-CATALOG: creates a Store's template System roles under a verified signed plan.
 * Caller owns BEGIN/COMMIT on a transaction of the provisioning principal.
 */
export async function provisionStoreRoles(
  tx: StoreRoleProvisioningTransaction,
  rawPlan: unknown,
  options: StoreRoleProvisioningOptions,
): Promise<StoreRoleProvisioningResult> {
  const plan = parseStoreRoleProvisioningPlan(rawPlan),
    planDigest = storeRoleProvisioningPlanDigest(plan);
  const verify = async (): Promise<StoreRoleProvisioningApproval> => {
    const material = await options.readApprovalMaterial();
    return verifyStoreRoleProvisioningApproval({
      plan,
      approval: material.approval,
      trust: material.trust,
      now: options.clock.now(),
    });
  };
  const approval = await verify();
  await tx.query(
    "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
    [plan.tenantReference, plan.brandReference, plan.storeReference],
  );
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "bop_permission.store_role_provisioning:" + plan.storeReference,
  ]);
  const prior = (
    await tx.query(
      `SELECT operation_id::text operation,plan_digest,role_count,grant_count,policy_version
       FROM bop_permission.store_role_provisioning WHERE brand_id=$1 AND store_id=$2`,
      [plan.brandReference, plan.storeReference],
    )
  ).rows[0];
  if (prior !== undefined) {
    if (prior.operation !== plan.operationReference || prior.plan_digest !== planDigest)
      return conflict();
    return Object.freeze({
      status: "AlreadyApplied",
      planDigest,
      roleCount: Number(prior.role_count),
      grantCount: Number(prior.grant_count),
      policyVersion: Number(prior.policy_version),
    });
  }
  if (
    (await options.storeScope.confirm(tx, {
      brandReference: plan.brandReference,
      storeReference: plan.storeReference,
    })) !== true
  )
    return conflict();
  const revision = (
    await tx.query(
      "SELECT catalog_digest FROM bop_permission.permission_catalog_revision WHERE catalog_version=$1",
      [plan.catalogVersion],
    )
  ).rows[0];
  if (
    plan.catalogVersion !== storePermissionCatalogVersion ||
    plan.catalogDigest !== permissionCatalogDigest() ||
    revision?.catalog_digest !== plan.catalogDigest
  )
    throw new StoreRoleProvisioningError("STORE_ROLE_PROVISIONING_CATALOG_MISMATCH");
  await tx.query(
    "LOCK TABLE bop_permission.policy_state,bop_permission.permission_definition,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant,bop_permission.permission_override IN SHARE ROW EXCLUSIVE MODE",
    [],
  );
  const actions = [...new Set(plan.roles.flatMap((role) => role.actions))];
  const permissions = new Map(
    (
      await tx.query(
        "SELECT action_code,permission_id::text id FROM bop_permission.permission_definition WHERE lifecycle='Active' AND action_code=ANY($1::text[])",
        [actions],
      )
    ).rows.map((row) => [String(row.action_code), String(row.id)]),
  );
  if (permissions.size !== actions.length)
    throw new StoreRoleProvisioningError("STORE_ROLE_PROVISIONING_CATALOG_MISMATCH");
  const taken = await tx.query(
    "SELECT 1 FROM bop_permission.role WHERE brand_id=$1 AND store_id=$2 AND role_code=ANY($3::text[])",
    [plan.brandReference, plan.storeReference, plan.roles.map((role) => role.roleCode)],
  );
  if (taken.rows.length > 0) return conflict();

  const at = options.clock.now();
  const state = (
    await tx.query(
      "SELECT snapshot_id::text snapshot,version::text version FROM bop_permission.policy_state WHERE brand_id=$1",
      [plan.brandReference],
    )
  ).rows[0];
  const snapshot = options.nextReference();
  let policyVersion = 1;
  if (state === undefined)
    await tx.query(
      "INSERT INTO bop_permission.policy_state(brand_id,snapshot_id,version,updated_at) VALUES($1,$2,1,$3)",
      [plan.brandReference, snapshot, at],
    );
  else {
    policyVersion = Number(state.version) + 1;
    const updated = await tx.query(
      "UPDATE bop_permission.policy_state SET snapshot_id=$2,version=$3,updated_at=$4 WHERE brand_id=$1 AND snapshot_id=$5 AND version=$6 RETURNING 1",
      [plan.brandReference, snapshot, policyVersion, at, state.snapshot, state.version],
    );
    if (updated.rows.length !== 1) return conflict();
  }

  let grantCount = 0;
  for (const role of plan.roles) {
    await tx.query(
      "INSERT INTO bop_permission.role(role_id,brand_id,store_id,role_code,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'Active',$5,NULL,1,$6,$6)",
      [
        role.roleReference,
        plan.brandReference,
        plan.storeReference,
        role.roleCode,
        plan.effectiveFrom,
        at,
      ],
    );
    const grantIds = role.actions.map(() => options.nextReference()),
      selectionIds = role.actions.map(() => options.nextReference()),
      permissionIds = role.actions.map((action) => permissions.get(action));
    await tx.query(
      `INSERT INTO bop_permission.permission_grant(grant_id,role_id,permission_id,brand_id,store_id,lifecycle,effective_from,effective_until,version,created_at,updated_at)
       SELECT g,$1,p,$2,$3,'Active',$4,NULL,1,$5,$5 FROM unnest($6::uuid[],$7::uuid[]) AS t(g,p)`,
      [
        role.roleReference,
        plan.brandReference,
        plan.storeReference,
        plan.effectiveFrom,
        at,
        grantIds,
        permissionIds,
      ],
    );
    grantCount += role.actions.length;
    await tx.query(
      `INSERT INTO bop_permission.role_administration_version(administration_reference,role_id,version,brand_id,store_id,role_code,display_name,description,
         role_type,lifecycle,source_policy_version,authored_by_reference,submitted_by_reference,approved_by_reference,decision_evidence_reference,reason_code,changed_at,data_classification)
       VALUES($1,$2,1,$3,$4,$5,$6,$7,'System','Active',$8,$9,$9,$10,$11,$12,$13,'ConfigurationMetadata')`,
      [
        role.administrationReference,
        role.roleReference,
        plan.brandReference,
        plan.storeReference,
        role.roleCode,
        role.displayName,
        role.description,
        policyVersion,
        plan.operatorReference,
        approval.approvedByReference,
        approval.approvalEvidenceReference,
        plan.reasonCode,
        at,
      ],
    );
    await tx.query(
      `INSERT INTO bop_permission.role_administration_permission(selection_reference,brand_id,store_id,administration_reference,administration_version,
         permission_id,action_code,group_code,high_risk,dependency_actions,data_classification)
       SELECT s,$1,$2,$3,1,p,a,g,h,'[]'::jsonb,'ConfigurationMetadata'
       FROM unnest($4::uuid[],$5::uuid[],$6::text[],$7::text[],$8::boolean[]) AS t(s,p,a,g,h)`,
      [
        plan.brandReference,
        plan.storeReference,
        role.administrationReference,
        selectionIds,
        permissionIds,
        role.actions,
        role.actions.map(groupCode),
        role.actions.map((action) => highRisk.has(action)),
      ],
    );
    for (const [decision, actor] of [
      ["Submitted", plan.operatorReference],
      ["Approved", approval.approvedByReference],
      ["Activated", plan.operatorReference],
    ] as const)
      await tx.query(
        `INSERT INTO bop_permission.role_administration_decision(decision_reference,brand_id,store_id,administration_reference,administration_version,
           decision,actor_reference,reason_code,evidence_reference,occurred_at,data_classification)
         VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,'ConfigurationMetadata')`,
        [
          options.nextReference(),
          plan.brandReference,
          plan.storeReference,
          role.administrationReference,
          decision,
          actor,
          plan.reasonCode,
          approval.approvalEvidenceReference,
          at,
        ],
      );
  }

  const auditId = options.nextReference();
  await appendAuditRecordInTransaction(tx, {
    auditId,
    brandId: plan.brandReference,
    storeId: plan.storeReference,
    actor: { type: "User", reference: plan.operatorReference },
    actionCode: "STORE_ROLES_PROVISIONED",
    targetType: "StoreRoleProvisioning",
    targetId: plan.operationReference,
    afterSummary: {
      planDigest,
      catalogVersion: plan.catalogVersion,
      roles: plan.roles.map((role) => role.roleCode),
      grantCount,
      approvedBy: approval.approvedByReference,
      approvalEvidence: approval.approvalEvidenceReference,
    },
    reasonCode: plan.reasonCode,
    correlationId: plan.operationReference,
    occurredAt: at,
    sourceChannel: "DEPLOYMENT",
    dataClassification: "Internal",
    retentionPolicyCode: "AUDIT_SECURITY",
    retentionPolicyVersion: 1,
  });
  await tx.query(
    "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose',$2,true)",
    [plan.operatorReference, plan.purposeCode],
  );
  await appendPlatformAuditRecordInTransaction(tx, {
    auditReference: options.nextReference(),
    actorReference: plan.operatorReference,
    purposeCode: plan.purposeCode,
    actionCode: "STORE_ROLES_PROVISIONED",
    targetType: "StoreRoleProvisioning",
    targetReference: plan.operationReference,
    operationReference: plan.operationReference,
    intentDigest: planDigest,
    occurredAt: at,
    reasonCode: plan.reasonCode,
    retentionPolicyCode: "CONFIGURATION_AUDIT",
    retentionPolicyVersion: 1,
  });
  // A revocation or expiry observed while writing refuses the whole provisioning.
  const current = await verify();
  if (current.approvalEvidenceReference !== approval.approvalEvidenceReference) return conflict();
  await tx.query(
    `INSERT INTO bop_permission.store_role_provisioning(operation_id,tenant_id,brand_id,store_id,catalog_version,plan_digest,role_count,grant_count,
       operator_id,approved_by,approval_evidence_id,approval_key_id,policy_version,audit_id,applied_at,data_classification)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'ConfigurationMetadata')`,
    [
      plan.operationReference,
      plan.tenantReference,
      plan.brandReference,
      plan.storeReference,
      plan.catalogVersion,
      planDigest,
      plan.roles.length,
      grantCount,
      plan.operatorReference,
      approval.approvedByReference,
      approval.approvalEvidenceReference,
      approval.keyReference,
      policyVersion,
      auditId,
      at,
    ],
  );
  return Object.freeze({
    status: "Applied",
    planDigest,
    roleCount: plan.roles.length,
    grantCount,
    policyVersion,
  });
}
