import { appendAuditRecordInTransaction, appendPlatformAuditRecordInTransaction } from "@bop/audit";
import {
  storePermissionCatalog,
  storePermissionCatalogVersion,
  storeRoleTemplateCodes,
  storeRoleTemplateProfiles,
  type StoreRoleTemplateCode,
} from "../../catalog/store-permission-catalog.js";
import {
  parseStoreRoleProvisioningPlan,
  storeRoleProvisioningPlanDigest,
  StoreRoleProvisioningError,
  verifyStoreRoleProvisioningApproval,
  type StoreRoleProvisioningApproval,
  type StoreRoleProvisioningRole,
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
  /** Tenant owner's public confirmation that the Store belongs to the Brand and can be opened. */
  readonly storeScope: {
    confirm(
      tx: StoreRoleProvisioningTransaction,
      scope: { readonly brandReference: string; readonly storeReference: string },
    ): Promise<boolean>;
  };
  /** Membership owner's public confirmation that the initial Owner is an Active Store member. */
  readonly memberScope: {
    confirm(
      tx: StoreRoleProvisioningTransaction,
      scope: {
        readonly brandReference: string;
        readonly storeReference: string;
        readonly actorReference: string;
        readonly membershipReference: string;
        readonly storeAssignmentReference: string;
        readonly at: string;
      },
    ): Promise<boolean>;
  };
  readonly nextReference: () => string;
}
export interface StoreRoleProvisioningResult {
  readonly status: "Applied" | "AlreadyApplied";
  readonly planDigest: string;
  readonly catalogVersion: number;
  readonly roleCount: number;
  readonly grantCount: number;
  readonly addedCount: number;
  readonly revokedCount: number;
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
const scopeSql =
  "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)";
const templateRolesSql = `SELECT r.role_id::text role_reference,r.role_code,v.administration_reference::text administration_reference,
   v.version::int version,v.role_type,v.lifecycle
 FROM bop_permission.role r
 JOIN LATERAL (SELECT * FROM bop_permission.role_administration_version x WHERE x.brand_id=r.brand_id AND x.role_id=r.role_id
   ORDER BY x.version DESC LIMIT 1) v ON true
 WHERE r.brand_id=$1 AND r.store_id=$2 AND r.role_code=ANY($3::text[])`;

/**
 * Owner-repository read for the release tool: the Store's latest provisioned catalog version and its
 * existing template roles, so an upgrade plan keeps their references.
 */
export async function readStoreTemplateRoles(
  tx: StoreRoleProvisioningTransaction,
  scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  },
): Promise<{
  readonly latestCatalogVersion: number | null;
  readonly roles: Partial<
    Record<
      StoreRoleTemplateCode,
      { readonly roleReference: string; readonly administrationReference: string }
    >
  >;
}> {
  await tx.query(scopeSql, [scope.tenantReference, scope.brandReference, scope.storeReference]);
  const latest = (
    await tx.query(
      "SELECT max(catalog_version)::int v FROM bop_permission.store_role_provisioning WHERE brand_id=$1 AND store_id=$2",
      [scope.brandReference, scope.storeReference],
    )
  ).rows[0]?.v;
  const rows = (
    await tx.query(templateRolesSql, [
      scope.brandReference,
      scope.storeReference,
      storeRoleTemplateCodes.map((template) => storeRoleTemplateProfiles[template].roleCode),
    ])
  ).rows;
  const roles: Partial<
    Record<StoreRoleTemplateCode, { roleReference: string; administrationReference: string }>
  > = {};
  for (const template of storeRoleTemplateCodes) {
    const row = rows.find(
      (item) => item.role_code === storeRoleTemplateProfiles[template].roleCode,
    );
    if (row)
      roles[template] = {
        roleReference: String(row.role_reference),
        administrationReference: String(row.administration_reference),
      };
  }
  return { latestCatalogVersion: typeof latest === "number" ? latest : null, roles };
}

/**
 * WP-2423 / DEC-PERM-CATALOG: opens a Store's template System roles (optionally assigning the initial
 * Owner) or upgrades them to a newer installed catalog version, under a verified signed plan.
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
  const setScope = () =>
    tx.query(scopeSql, [plan.tenantReference, plan.brandReference, plan.storeReference]);
  await setScope();
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "bop_permission.store_role_provisioning:" + plan.storeReference,
  ]);
  const history = (
    await tx.query(
      `SELECT operation_id::text operation,catalog_version::int catalog_version,plan_digest,role_count,grant_count,policy_version
       FROM bop_permission.store_role_provisioning WHERE brand_id=$1 AND store_id=$2 ORDER BY catalog_version`,
      [plan.brandReference, plan.storeReference],
    )
  ).rows;
  const same = history.find((row) => row.operation === plan.operationReference);
  if (same !== undefined) {
    if (same.plan_digest !== planDigest) return conflict();
    return Object.freeze({
      status: "AlreadyApplied",
      planDigest,
      catalogVersion: plan.catalogVersion,
      roleCount: Number(same.role_count),
      grantCount: Number(same.grant_count),
      addedCount: 0,
      revokedCount: 0,
      policyVersion: Number(same.policy_version),
    });
  }
  const latest = history.at(-1)?.catalog_version ?? null;
  if (latest !== plan.previousCatalogVersion) return conflict();
  if (
    (await options.storeScope.confirm(tx, {
      brandReference: plan.brandReference,
      storeReference: plan.storeReference,
    })) !== true
  )
    return conflict();
  const at = options.clock.now();
  if (
    plan.ownerAssignment !== null &&
    (await options.memberScope.confirm(tx, {
      brandReference: plan.brandReference,
      storeReference: plan.storeReference,
      actorReference: plan.ownerAssignment.actorReference,
      membershipReference: plan.ownerAssignment.membershipReference,
      storeAssignmentReference: plan.ownerAssignment.storeAssignmentReference,
      at,
    })) !== true
  )
    return conflict();
  await setScope();
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
  const existing = new Map(
    (
      await tx.query(templateRolesSql, [
        plan.brandReference,
        plan.storeReference,
        plan.roles.map((role) => role.roleCode),
      ])
    ).rows.map((row) => [String(row.role_code), row]),
  );
  // An opening finds no template role; an upgrade keeps each existing System role's identity.
  for (const role of plan.roles) {
    const row = existing.get(role.roleCode);
    if (
      row !== undefined &&
      (plan.previousCatalogVersion === null ||
        row.role_reference !== role.roleReference ||
        row.administration_reference !== role.administrationReference ||
        row.role_type !== "System" ||
        !["Active", "Deactivated"].includes(String(row.lifecycle)))
    )
      return conflict();
  }

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

  const insertGrants = (role: StoreRoleProvisioningRole, granted: readonly string[]) =>
    granted.length === 0
      ? Promise.resolve()
      : tx.query(
          `INSERT INTO bop_permission.permission_grant(grant_id,role_id,permission_id,brand_id,store_id,lifecycle,effective_from,effective_until,version,created_at,updated_at)
           SELECT g,$1,p,$2,$3,'Active',$4,NULL,1,$5,$5 FROM unnest($6::uuid[],$7::uuid[]) AS t(g,p)`,
          [
            role.roleReference,
            plan.brandReference,
            plan.storeReference,
            plan.effectiveFrom > at ? plan.effectiveFrom : at,
            at,
            granted.map(() => options.nextReference()),
            granted.map((action) => permissions.get(action)),
          ],
        );
  let grantCount = 0,
    addedCount = 0,
    revokedCount = 0;
  for (const role of plan.roles) {
    const row = existing.get(role.roleCode);
    const version = row === undefined ? 1 : Number(row.version) + 1,
      lifecycle = row === undefined ? "Active" : String(row.lifecycle);
    if (row === undefined) {
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
      await insertGrants(role, role.actions);
      addedCount += role.actions.length;
    } else {
      const held = (
        await tx.query(
          `SELECT g.grant_id::text grant_id,d.action_code FROM bop_permission.permission_grant g
           JOIN bop_permission.permission_definition d ON d.permission_id=g.permission_id
           WHERE g.role_id=$1 AND g.brand_id=$2 AND g.lifecycle='Active'`,
          [role.roleReference, plan.brandReference],
        )
      ).rows;
      const heldActions = new Set(held.map((item) => String(item.action_code)));
      const added = role.actions.filter((action) => !heldActions.has(action)),
        removed = held.filter((item) => !role.actions.includes(String(item.action_code)));
      await insertGrants(role, added);
      if (removed.length > 0)
        await tx.query(
          "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1,updated_at=$2 WHERE grant_id=ANY($1::uuid[]) AND lifecycle='Active'",
          [removed.map((item) => item.grant_id), at],
        );
      addedCount += added.length;
      revokedCount += removed.length;
    }
    grantCount += role.actions.length;
    await tx.query(
      `INSERT INTO bop_permission.role_administration_version(administration_reference,role_id,version,brand_id,store_id,role_code,display_name,description,
         role_type,lifecycle,source_policy_version,authored_by_reference,submitted_by_reference,approved_by_reference,decision_evidence_reference,reason_code,changed_at,data_classification)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'System',$9,$10,$11,$11,$12,$13,$14,$15,'ConfigurationMetadata')`,
      [
        role.administrationReference,
        role.roleReference,
        version,
        plan.brandReference,
        plan.storeReference,
        role.roleCode,
        role.displayName,
        role.description,
        lifecycle,
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
       SELECT s,$1,$2,$3,$4,p,a,g,h,'[]'::jsonb,'ConfigurationMetadata'
       FROM unnest($5::uuid[],$6::uuid[],$7::text[],$8::text[],$9::boolean[]) AS t(s,p,a,g,h)`,
      [
        plan.brandReference,
        plan.storeReference,
        role.administrationReference,
        version,
        role.actions.map(() => options.nextReference()),
        role.actions.map((action) => permissions.get(action)),
        role.actions,
        role.actions.map(groupCode),
        role.actions.map((action) => highRisk.has(action)),
      ],
    );
    const decisions: (readonly [string, string])[] = [
      ["Submitted", plan.operatorReference],
      ["Approved", approval.approvedByReference],
    ];
    if (lifecycle === "Active") decisions.push(["Activated", plan.operatorReference]);
    for (const [decision, actor] of decisions)
      await tx.query(
        `INSERT INTO bop_permission.role_administration_decision(decision_reference,brand_id,store_id,administration_reference,administration_version,
           decision,actor_reference,reason_code,evidence_reference,occurred_at,data_classification)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ConfigurationMetadata')`,
        [
          options.nextReference(),
          plan.brandReference,
          plan.storeReference,
          role.administrationReference,
          version,
          decision,
          actor,
          plan.reasonCode,
          approval.approvalEvidenceReference,
          at,
        ],
      );
  }
  if (plan.ownerAssignment !== null) {
    const owner = plan.roles.find((role) => role.template === "owner");
    if (!owner) return conflict();
    // Platform assigns an Owner only while the Store has none.
    const held = await tx.query(
      "SELECT 1 FROM bop_permission.role_assignment WHERE role_id=$1 AND brand_id=$2 AND lifecycle='Active'",
      [owner.roleReference, plan.brandReference],
    );
    if (held.rows.length > 0) return conflict();
    await tx.query(
      `INSERT INTO bop_permission.role_assignment(assignment_id,role_id,membership_id,store_assignment_id,actor_id,brand_id,store_id,lifecycle,
         effective_from,effective_until,version,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,'Active',$8,NULL,1,$9,$9)`,
      [
        plan.ownerAssignment.assignmentReference,
        owner.roleReference,
        plan.ownerAssignment.membershipReference,
        plan.ownerAssignment.storeAssignmentReference,
        plan.ownerAssignment.actorReference,
        plan.brandReference,
        plan.storeReference,
        plan.effectiveFrom > at ? plan.effectiveFrom : at,
        at,
      ],
    );
  }

  const auditId = options.nextReference();
  const action =
    plan.previousCatalogVersion === null ? "STORE_ROLES_PROVISIONED" : "STORE_ROLES_UPGRADED";
  await appendAuditRecordInTransaction(tx, {
    auditId,
    brandId: plan.brandReference,
    storeId: plan.storeReference,
    actor: { type: "User", reference: plan.operatorReference },
    actionCode: action,
    targetType: "StoreRoleProvisioning",
    targetId: plan.operationReference,
    afterSummary: {
      planDigest,
      catalogVersion: plan.catalogVersion,
      previousCatalogVersion: plan.previousCatalogVersion,
      roles: plan.roles.map((role) => role.roleCode),
      grantCount,
      addedCount,
      revokedCount,
      ownerAssigned: plan.ownerAssignment !== null,
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
    actionCode: action,
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
       operator_id,approved_by,approval_evidence_id,approval_key_id,policy_version,audit_id,applied_at,data_classification,
       previous_catalog_version,owner_assignment_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'ConfigurationMetadata',$16,$17)`,
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
      plan.previousCatalogVersion,
      plan.ownerAssignment?.assignmentReference ?? null,
    ],
  );
  return Object.freeze({
    status: "Applied",
    planDigest,
    catalogVersion: plan.catalogVersion,
    roleCount: plan.roles.length,
    grantCount,
    addedCount,
    revokedCount,
    policyVersion,
  });
}
