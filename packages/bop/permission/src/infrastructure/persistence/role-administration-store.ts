import { appendAuditRecordInTransaction, canonicalizeRfc8785 } from "@bop/audit";
import { createHash } from "node:crypto";
import {
  createRoleAdministrationVersion,
  type RoleAdministrationVersionRecord,
  type RolePermissionSelection,
} from "../../contracts/role-administration.js";
import { parseBusinessAction } from "../../contracts/permission-evaluation.js";
import { parsePermissionReference } from "../../domain/permission-policy.js";
import {
  storePermissionCatalog,
  withLegacyEquivalents,
} from "../../catalog/store-permission-catalog.js";
import type { RoleAdministrationPorts } from "../../application/ports/role-administration-ports.js";

/**
 * WP-2423: Permission owner persistence for Store role administration (Section 88 IAM-ROLE-LIST /
 * IAM-ROLE-EDITOR). Versions, selections, decisions and operations are append-only; activation
 * materializes the approved selections into the role's grants and advances the Brand policy version.
 */
export interface RoleAdministrationTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export interface RoleAdministrationScope {
  readonly brandReference: string;
  readonly storeReference: string;
}
export interface RoleAdministrationDecisionView {
  readonly decision: string;
  readonly actorReference: string;
  readonly version: number;
  readonly occurredAt: string;
}
export interface RoleAdministrationRoleView {
  readonly record: RoleAdministrationVersionRecord;
  readonly memberCount: number;
  readonly decisions: readonly RoleAdministrationDecisionView[];
}
export class RoleAdministrationStoreError extends Error {
  constructor(
    readonly code:
      | "ROLE_ADMIN_NOT_FOUND"
      | "ROLE_ADMIN_VERSION_CONFLICT"
      | "ROLE_ADMIN_CODE_CONFLICT"
      | "ROLE_ADMIN_IDEMPOTENCY_CONFLICT",
  ) {
    super(code);
    this.name = "RoleAdministrationStoreError";
  }
}

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const scopeSql = "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)";
const latestSql = `SELECT v.* FROM bop_permission.role_administration_version v
 WHERE v.brand_id=$1 AND (v.store_id IS NULL OR v.store_id=$2) AND v.version=(
   SELECT max(x.version) FROM bop_permission.role_administration_version x
   WHERE x.brand_id=v.brand_id AND x.administration_reference=v.administration_reference)`;

async function selections(
  tx: RoleAdministrationTransaction,
  brandReference: string,
  administrationReference: string,
  version: number,
) {
  return (
    await tx.query(
      `SELECT permission_id::text permission_reference,action_code,group_code,high_risk,dependency_actions
       FROM bop_permission.role_administration_permission
       WHERE brand_id=$1 AND administration_reference=$2 AND administration_version=$3 ORDER BY action_code COLLATE "C"`,
      [brandReference, administrationReference, version],
    )
  ).rows.map((row) => ({
    permissionReference: String(row.permission_reference),
    action: String(row.action_code),
    groupCode: String(row.group_code),
    highRisk: row.high_risk === true,
    dependencyActions: (row.dependency_actions as string[]) ?? [],
  }));
}
async function toRecord(
  tx: RoleAdministrationTransaction,
  row: Record<string, unknown>,
): Promise<RoleAdministrationVersionRecord> {
  const ref = (value: unknown) => (value === null ? null : String(value));
  return createRoleAdministrationVersion({
    administrationReference: String(row.administration_reference),
    roleReference: String(row.role_id),
    version: Number(row.version),
    brandReference: String(row.brand_id),
    storeReference: ref(row.store_id),
    code: String(row.role_code),
    displayName: String(row.display_name),
    description: String(row.description),
    roleType: String(row.role_type),
    lifecycle: String(row.lifecycle),
    sourcePolicyVersion: Number(row.source_policy_version),
    selections: await selections(
      tx,
      String(row.brand_id),
      String(row.administration_reference),
      Number(row.version),
    ),
    authoredByReference: String(row.authored_by_reference),
    submittedByReference: ref(row.submitted_by_reference),
    approvedByReference: ref(row.approved_by_reference),
    decisionEvidenceReference: ref(row.decision_evidence_reference),
    reasonCode: String(row.reason_code),
    changedAt: iso(row.changed_at),
  });
}
async function memberCount(
  tx: RoleAdministrationTransaction,
  brandReference: string,
  roleReference: string,
  at: string,
): Promise<number> {
  return Number(
    (
      await tx.query(
        `SELECT count(*)::int n FROM bop_permission.role_assignment WHERE brand_id=$1 AND role_id=$2 AND lifecycle='Active'
         AND effective_from<=$3::timestamptz AND (effective_until IS NULL OR effective_until>$3::timestamptz)`,
        [brandReference, roleReference, at],
      )
    ).rows[0]?.n ?? 0,
  );
}
async function decisions(
  tx: RoleAdministrationTransaction,
  brandReference: string,
  administrationReference: string,
): Promise<RoleAdministrationDecisionView[]> {
  return (
    await tx.query(
      `SELECT decision,actor_reference::text actor,administration_version::int version,occurred_at
       FROM bop_permission.role_administration_decision WHERE brand_id=$1 AND administration_reference=$2
       ORDER BY occurred_at,administration_version,decision`,
      [brandReference, administrationReference],
    )
  ).rows.map((row) => ({
    decision: String(row.decision),
    actorReference: String(row.actor),
    version: Number(row.version),
    occurredAt: iso(row.occurred_at),
  }));
}

/** Administered roles visible in the selected Store: its Store roles and Brand-wide roles. */
export async function listRoleAdministration(
  tx: RoleAdministrationTransaction,
  scope: RoleAdministrationScope,
  at: string,
): Promise<RoleAdministrationRoleView[]> {
  await tx.query(scopeSql, [scope.brandReference, scope.storeReference]);
  const rows = (
    await tx.query(latestSql + ' ORDER BY v.role_type DESC,v.role_code COLLATE "C"', [
      scope.brandReference,
      scope.storeReference,
    ])
  ).rows;
  const result: RoleAdministrationRoleView[] = [];
  for (const row of rows) {
    const record = await toRecord(tx, row);
    result.push({
      record,
      memberCount: await memberCount(tx, scope.brandReference, record.roleReference, at),
      decisions: await decisions(tx, scope.brandReference, record.administrationReference),
    });
  }
  return result;
}
export async function loadRoleAdministration(
  tx: RoleAdministrationTransaction,
  scope: RoleAdministrationScope,
  roleReference: string,
  at: string,
): Promise<RoleAdministrationRoleView> {
  await tx.query(scopeSql, [scope.brandReference, scope.storeReference]);
  const row = (
    await tx.query(latestSql + " AND v.role_id=$3", [
      scope.brandReference,
      scope.storeReference,
      roleReference,
    ])
  ).rows[0];
  if (row === undefined) throw new RoleAdministrationStoreError("ROLE_ADMIN_NOT_FOUND");
  const record = await toRecord(tx, row);
  return {
    record,
    memberCount: await memberCount(tx, scope.brandReference, roleReference, at),
    decisions: await decisions(tx, scope.brandReference, record.administrationReference),
  };
}
/** Active catalog definitions a role may select, keyed by action code. */
export async function readPermissionDefinitionReferences(
  tx: RoleAdministrationTransaction,
  actions: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  return new Map(
    (
      await tx.query(
        "SELECT action_code,permission_id::text id FROM bop_permission.permission_definition WHERE lifecycle='Active' AND action_code=ANY($1::text[])",
        [actions],
      )
    ).rows.map((row) => [String(row.action_code), String(row.id)]),
  );
}

/**
 * Selections for chosen catalog codes: each Active definition with its catalog group and risk,
 * plus the legacy consolidated codes the choice fully covers. Unknown or retired codes are refused.
 */
export async function buildRolePermissionSelections(
  tx: RoleAdministrationTransaction,
  actions: readonly string[],
): Promise<readonly RolePermissionSelection[]> {
  const catalog = new Map(storePermissionCatalog().map((entry) => [entry.code, entry]));
  if (actions.some((action) => !catalog.has(action)))
    throw new RoleAdministrationStoreError("ROLE_ADMIN_NOT_FOUND");
  const codes = withLegacyEquivalents(actions);
  const references = await readPermissionDefinitionReferences(tx, codes);
  if (references.size !== codes.length)
    throw new RoleAdministrationStoreError("ROLE_ADMIN_NOT_FOUND");
  return codes.map((action) => {
    const entry = catalog.get(action);
    return Object.freeze({
      permissionReference: parsePermissionReference(references.get(action)),
      action: parseBusinessAction(action),
      groupCode: (entry?.module ?? action.split(".")[0] ?? action).replaceAll("-", "_"),
      highRisk: entry?.risk === "High",
      dependencyActions: Object.freeze([]),
    });
  });
}

const decisionOf = {
  SaveDraft: null,
  Duplicate: null,
  Submit: "Submitted",
  Approve: "Approved",
  Reject: "Rejected",
  Activate: "Activated",
  Deactivate: "Deactivated",
} as const;

/** Postgres ports for executeRoleAdministration inside the caller's transaction. */
export function createPostgresRoleAdministrationPorts(options: {
  readonly transaction: RoleAdministrationTransaction;
  readonly scope: RoleAdministrationScope;
  readonly operation: keyof typeof decisionOf;
  readonly operationReference: string;
  readonly actorReference: string;
  readonly authorization: RoleAdministrationPorts["authorization"];
  readonly clock: { now(): string };
  readonly nextReference: () => string;
}): RoleAdministrationPorts {
  const tx = options.transaction;
  return {
    authorization: options.authorization,
    impact: {
      countActiveAssignments: (roleReference) =>
        memberCount(tx, options.scope.brandReference, roleReference, options.clock.now()),
    },
    policy: {
      async currentVersion(brandReference) {
        const row = (
          await tx.query(
            "SELECT version::text v FROM bop_permission.policy_state WHERE brand_id=$1",
            [brandReference],
          )
        ).rows[0];
        return row === undefined ? 0 : Number(row.v);
      },
    },
    unitOfWork: {
      async commit(input) {
        const { next } = input;
        const intentDigest =
          "sha256:" +
          createHash("sha256")
            .update(canonicalizeRfc8785({ operation: options.operation, next }))
            .digest("hex");
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "bop_permission.role_administration:" + next.administrationReference,
        ]);
        const prior = (
          await tx.query(
            "SELECT intent_digest FROM bop_permission.role_administration_operation WHERE brand_id=$1 AND operation_reference=$2",
            [next.brandReference, options.operationReference],
          )
        ).rows[0];
        if (prior !== undefined) {
          if (prior.intent_digest !== intentDigest)
            throw new RoleAdministrationStoreError("ROLE_ADMIN_IDEMPOTENCY_CONFLICT");
          return;
        }
        const head = (
          await tx.query(
            "SELECT max(version)::int v FROM bop_permission.role_administration_version WHERE brand_id=$1 AND administration_reference=$2",
            [next.brandReference, next.administrationReference],
          )
        ).rows[0]?.v;
        const expectedHead = options.operation === "Duplicate" ? null : input.expectedVersion;
        if ((head ?? null) !== expectedHead)
          throw new RoleAdministrationStoreError("ROLE_ADMIN_VERSION_CONFLICT");
        const at = next.changedAt;
        if (options.operation === "Duplicate") {
          const taken = await tx.query(
            "SELECT 1 FROM bop_permission.role WHERE brand_id=$1 AND store_id IS NOT DISTINCT FROM $2 AND role_code=$3",
            [next.brandReference, next.storeReference, next.code],
          );
          if (taken.rows.length > 0)
            throw new RoleAdministrationStoreError("ROLE_ADMIN_CODE_CONFLICT");
          // A Custom role holds no grant and is not effective until it is approved and activated.
          await tx.query(
            "INSERT INTO bop_permission.role(role_id,brand_id,store_id,role_code,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'Suspended',$5,NULL,1,$5,$5)",
            [next.roleReference, next.brandReference, next.storeReference, next.code, at],
          );
        }
        await tx.query(
          `INSERT INTO bop_permission.role_administration_version(administration_reference,role_id,version,brand_id,store_id,role_code,display_name,description,
             role_type,lifecycle,source_policy_version,authored_by_reference,submitted_by_reference,approved_by_reference,decision_evidence_reference,reason_code,changed_at,data_classification)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'ConfigurationMetadata')`,
          [
            next.administrationReference,
            next.roleReference,
            next.version,
            next.brandReference,
            next.storeReference,
            next.code,
            next.displayName,
            next.description,
            next.roleType,
            next.lifecycle,
            next.sourcePolicyVersion,
            next.authoredByReference,
            next.submittedByReference,
            next.approvedByReference,
            next.decisionEvidenceReference,
            next.reasonCode,
            at,
          ],
        );
        if (next.selections.length > 0)
          await tx.query(
            `INSERT INTO bop_permission.role_administration_permission(selection_reference,brand_id,store_id,administration_reference,administration_version,
               permission_id,action_code,group_code,high_risk,dependency_actions,data_classification)
             SELECT s,$1,$2,$3,$4,p,a,g,h,d,'ConfigurationMetadata'
             FROM unnest($5::uuid[],$6::uuid[],$7::text[],$8::text[],$9::boolean[],$10::jsonb[]) AS t(s,p,a,g,h,d)`,
            [
              next.brandReference,
              next.storeReference,
              next.administrationReference,
              next.version,
              next.selections.map(() => options.nextReference()),
              next.selections.map((item) => item.permissionReference),
              next.selections.map((item) => item.action),
              next.selections.map((item) => item.groupCode),
              next.selections.map((item) => item.highRisk),
              next.selections.map((item) => JSON.stringify(item.dependencyActions)),
            ],
          );
        const decision = decisionOf[options.operation];
        if (decision !== null)
          await tx.query(
            `INSERT INTO bop_permission.role_administration_decision(decision_reference,brand_id,store_id,administration_reference,administration_version,
               decision,actor_reference,reason_code,evidence_reference,occurred_at,data_classification)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ConfigurationMetadata')`,
            [
              options.nextReference(),
              next.brandReference,
              next.storeReference,
              next.administrationReference,
              next.version,
              decision,
              options.actorReference,
              next.reasonCode,
              next.decisionEvidenceReference ?? options.operationReference,
              at,
            ],
          );
        if (input.activatePolicy) await materialize(next, at);
        await tx.query(
          `INSERT INTO bop_permission.role_administration_operation(operation_reference,brand_id,store_id,administration_reference,command_type,
             expected_version,resulting_version,intent_digest,actor_reference,audit_reference,occurred_at,data_classification)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ConfigurationMetadata')`,
          [
            options.operationReference,
            next.brandReference,
            next.storeReference,
            next.administrationReference,
            options.operation,
            input.expectedVersion,
            next.version,
            intentDigest,
            options.actorReference,
            input.audit.auditId,
            at,
          ],
        );
        await appendAuditRecordInTransaction(tx, input.audit);
      },
    },
  };

  /** Activation applies exactly the approved selections; deactivation suspends the role. */
  async function materialize(next: RoleAdministrationVersionRecord, at: string): Promise<void> {
    await tx.query(
      "LOCK TABLE bop_permission.policy_state,bop_permission.permission_definition,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant,bop_permission.permission_override IN SHARE ROW EXCLUSIVE MODE",
      [],
    );
    const active = next.lifecycle === "Active";
    await tx.query(
      "UPDATE bop_permission.role SET lifecycle=$3,version=version+1,updated_at=$4 WHERE role_id=$1 AND brand_id=$2",
      [next.roleReference, next.brandReference, active ? "Active" : "Suspended", at],
    );
    if (active) {
      const held = (
        await tx.query(
          "SELECT grant_id::text grant_id,permission_id::text permission FROM bop_permission.permission_grant WHERE role_id=$1 AND brand_id=$2 AND lifecycle='Active'",
          [next.roleReference, next.brandReference],
        )
      ).rows;
      const wanted = new Set<string>(next.selections.map((item) => item.permissionReference));
      const heldPermissions = new Set(held.map((row) => String(row.permission)));
      const added = next.selections.filter(
        (item) => !heldPermissions.has(item.permissionReference),
      );
      const removed = held.filter((row) => !wanted.has(String(row.permission)));
      if (added.length > 0)
        await tx.query(
          `INSERT INTO bop_permission.permission_grant(grant_id,role_id,permission_id,brand_id,store_id,lifecycle,effective_from,effective_until,version,created_at,updated_at)
           SELECT g,$1,p,$2,$3,'Active',$4,NULL,1,$4,$4 FROM unnest($5::uuid[],$6::uuid[]) AS t(g,p)`,
          [
            next.roleReference,
            next.brandReference,
            next.storeReference,
            at,
            added.map(() => options.nextReference()),
            added.map((item) => item.permissionReference),
          ],
        );
      if (removed.length > 0)
        await tx.query(
          "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1,updated_at=$2 WHERE grant_id=ANY($1::uuid[]) AND lifecycle='Active'",
          [removed.map((row) => row.grant_id), at],
        );
    }
    const state = (
      await tx.query(
        "SELECT snapshot_id::text snapshot,version::text version FROM bop_permission.policy_state WHERE brand_id=$1",
        [next.brandReference],
      )
    ).rows[0];
    if (state === undefined || Number(state.version) !== next.sourcePolicyVersion)
      throw new RoleAdministrationStoreError("ROLE_ADMIN_VERSION_CONFLICT");
    await tx.query(
      "UPDATE bop_permission.policy_state SET snapshot_id=$2,version=version+1,updated_at=$3 WHERE brand_id=$1 AND version=$4",
      [next.brandReference, options.nextReference(), at, state.version],
    );
  }
}
