import { appendAuditRecordInTransaction } from "@bop/audit";

/**
 * WP-2423: Store staff role assignment (Section 88 IAM-USER-DETAIL). Assigning a role is a privilege
 * increase: one administrator requests it and an independent administrator (never the requester or
 * the subject) approves it before it takes effect. Revoking is a privilege decrease and applies at
 * once. A Store always keeps at least one active Owner. Every effective change advances the Brand
 * policy version so current authorization re-reads it.
 */
export interface RoleAssignmentTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export interface RoleAssignmentScope {
  readonly brandReference: string;
  readonly storeReference: string;
}
export interface StoreRoleAssignmentView {
  readonly assignmentReference: string;
  readonly roleReference: string;
  readonly roleCode: string;
  readonly roleName: string;
  readonly actorReference: string;
  readonly effectiveFrom: string;
}
export interface PendingRoleAssignmentView {
  readonly changeReference: string;
  readonly roleReference: string;
  readonly roleCode: string;
  readonly roleName: string;
  readonly actorReference: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
}
export class RoleAssignmentError extends Error {
  constructor(
    readonly code:
      | "ROLE_ASSIGNMENT_INVALID"
      | "ROLE_ASSIGNMENT_NOT_FOUND"
      | "ROLE_ASSIGNMENT_SELF"
      | "ROLE_ASSIGNMENT_CONFLICT"
      | "ROLE_ASSIGNMENT_LAST_OWNER"
      | "ROLE_ASSIGNMENT_IDEMPOTENCY_CONFLICT",
  ) {
    super(code);
    this.name = "RoleAssignmentError";
  }
}
const fail = (code: RoleAssignmentError["code"]): never => {
  throw new RoleAssignmentError(code);
};
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const scopeSql = "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)";
const roleNameSql = `COALESCE((SELECT v.display_name FROM bop_permission.role_administration_version v
   WHERE v.brand_id=r.brand_id AND v.role_id=r.role_id ORDER BY v.version DESC LIMIT 1),r.role_code)`;
const ownerRoleCode = "store_owner";

export async function listStoreRoleAssignments(
  tx: RoleAssignmentTransaction,
  scope: RoleAssignmentScope,
  at: string,
): Promise<{
  readonly assignments: readonly StoreRoleAssignmentView[];
  readonly pending: readonly PendingRoleAssignmentView[];
}> {
  await tx.query(scopeSql, [scope.brandReference, scope.storeReference]);
  const assignments = (
    await tx.query(
      `SELECT a.assignment_id::text assignment,a.role_id::text role,r.role_code,${roleNameSql} role_name,a.actor_id::text actor,a.effective_from
       FROM bop_permission.role_assignment a JOIN bop_permission.role r ON r.role_id=a.role_id AND r.brand_id=a.brand_id
       WHERE a.brand_id=$1 AND a.store_id=$2 AND a.lifecycle='Active'
         AND a.effective_from<=$3::timestamptz AND (a.effective_until IS NULL OR a.effective_until>$3::timestamptz)
       ORDER BY a.actor_id,r.role_code`,
      [scope.brandReference, scope.storeReference, at],
    )
  ).rows.map((row) =>
    Object.freeze({
      assignmentReference: String(row.assignment),
      roleReference: String(row.role),
      roleCode: String(row.role_code),
      roleName: String(row.role_name),
      actorReference: String(row.actor),
      effectiveFrom: iso(row.effective_from),
    }),
  );
  const pending = (
    await tx.query(
      `SELECT c.change_id::text change,c.role_id::text role,r.role_code,${roleNameSql} role_name,c.actor_id::text actor,
         c.requested_by::text requested_by,c.requested_at
       FROM bop_permission.role_assignment_change c JOIN bop_permission.role r ON r.role_id=c.role_id AND r.brand_id=c.brand_id
       WHERE c.brand_id=$1 AND c.store_id=$2 AND c.kind='Assign'
         AND NOT EXISTS (SELECT 1 FROM bop_permission.role_assignment_change_decision d WHERE d.change_id=c.change_id)
       ORDER BY c.requested_at`,
      [scope.brandReference, scope.storeReference],
    )
  ).rows.map((row) =>
    Object.freeze({
      changeReference: String(row.change),
      roleReference: String(row.role),
      roleCode: String(row.role_code),
      roleName: String(row.role_name),
      actorReference: String(row.actor),
      requestedBy: String(row.requested_by),
      requestedAt: iso(row.requested_at),
    }),
  );
  return { assignments, pending };
}

interface Audit {
  readonly auditReference: string;
  readonly actorReference: string;
  readonly actionCode: string;
  readonly targetId: string;
  readonly reasonCode: string;
  readonly correlationId: string;
  readonly at: string;
  readonly summary: Record<string, string | number | null>;
}
async function audit(tx: RoleAssignmentTransaction, scope: RoleAssignmentScope, value: Audit) {
  await appendAuditRecordInTransaction(tx, {
    auditId: value.auditReference,
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "User", reference: value.actorReference },
    actionCode: value.actionCode,
    targetType: "RoleAssignment",
    targetId: value.targetId,
    afterSummary: value.summary,
    reasonCode: value.reasonCode,
    correlationId: value.correlationId,
    occurredAt: value.at,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Internal",
    retentionPolicyCode: "AUDIT_SECURITY",
    retentionPolicyVersion: 1,
  });
}
async function advancePolicy(
  tx: RoleAssignmentTransaction,
  brandReference: string,
  snapshot: string,
  at: string,
): Promise<number> {
  await tx.query(
    "LOCK TABLE bop_permission.policy_state,bop_permission.permission_definition,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant,bop_permission.permission_override IN SHARE ROW EXCLUSIVE MODE",
    [],
  );
  const updated = await tx.query(
    "UPDATE bop_permission.policy_state SET snapshot_id=$2,version=version+1,updated_at=$3 WHERE brand_id=$1 RETURNING version::text v",
    [brandReference, snapshot, at],
  );
  return Number(updated.rows[0]?.v ?? fail("ROLE_ASSIGNMENT_CONFLICT"));
}
async function activeRole(tx: RoleAssignmentTransaction, scope: RoleAssignmentScope, role: string) {
  const row = (
    await tx.query(
      "SELECT role_code,lifecycle FROM bop_permission.role WHERE role_id=$1 AND brand_id=$2 AND store_id=$3",
      [role, scope.brandReference, scope.storeReference],
    )
  ).rows[0];
  if (row === undefined) return fail("ROLE_ASSIGNMENT_NOT_FOUND");
  if (row.lifecycle !== "Active") return fail("ROLE_ASSIGNMENT_CONFLICT");
  return String(row.role_code);
}

/** Requests that a Store member receive a role; it takes effect only after independent approval. */
export async function requestRoleAssignment(
  tx: RoleAssignmentTransaction,
  input: RoleAssignmentScope & {
    readonly changeReference: string;
    readonly assignmentReference: string;
    readonly roleReference: string;
    readonly actorReference: string;
    readonly membershipReference: string;
    readonly storeAssignmentReference: string;
    readonly requestedBy: string;
    readonly at: string;
    readonly auditReference: string;
  },
): Promise<{ readonly status: "Requested" | "AlreadyApplied" }> {
  if (input.requestedBy === input.actorReference) fail("ROLE_ASSIGNMENT_SELF");
  await tx.query(scopeSql, [input.brandReference, input.storeReference]);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "bop_permission.role_assignment:" + input.storeReference + ":" + input.actorReference,
  ]);
  const prior = (
    await tx.query(
      "SELECT kind,role_id::text role,actor_id::text actor,requested_by::text requested_by FROM bop_permission.role_assignment_change WHERE change_id=$1",
      [input.changeReference],
    )
  ).rows[0];
  if (prior !== undefined) {
    if (
      prior.kind !== "Assign" ||
      prior.role !== input.roleReference ||
      prior.actor !== input.actorReference ||
      prior.requested_by !== input.requestedBy
    )
      fail("ROLE_ASSIGNMENT_IDEMPOTENCY_CONFLICT");
    return { status: "AlreadyApplied" };
  }
  const roleCode = await activeRole(tx, input, input.roleReference);
  const duplicate = await tx.query(
    `SELECT 1 FROM bop_permission.role_assignment WHERE role_id=$1 AND actor_id=$2 AND lifecycle='Active'
     UNION ALL
     SELECT 1 FROM bop_permission.role_assignment_change c WHERE c.role_id=$1 AND c.actor_id=$2 AND c.kind='Assign'
       AND NOT EXISTS (SELECT 1 FROM bop_permission.role_assignment_change_decision d WHERE d.change_id=c.change_id)`,
    [input.roleReference, input.actorReference],
  );
  if (duplicate.rows.length > 0) fail("ROLE_ASSIGNMENT_CONFLICT");
  await tx.query(
    `INSERT INTO bop_permission.role_assignment_change(change_id,brand_id,store_id,kind,role_id,assignment_id,actor_id,membership_id,store_assignment_id,
       requested_by,requested_at,reason_code,audit_id,data_classification)
     VALUES($1,$2,$3,'Assign',$4,$5,$6,$7,$8,$9,$10,'STAFF_ROLE_ASSIGNMENT',$11,'ConfigurationMetadata')`,
    [
      input.changeReference,
      input.brandReference,
      input.storeReference,
      input.roleReference,
      input.assignmentReference,
      input.actorReference,
      input.membershipReference,
      input.storeAssignmentReference,
      input.requestedBy,
      input.at,
      input.auditReference,
    ],
  );
  await audit(tx, input, {
    auditReference: input.auditReference,
    actorReference: input.requestedBy,
    actionCode: "ROLE_ASSIGNMENT_REQUESTED",
    targetId: input.changeReference,
    reasonCode: "STAFF_ROLE_ASSIGNMENT",
    correlationId: input.changeReference,
    at: input.at,
    summary: { roleCode, subject: input.actorReference },
  });
  return { status: "Requested" };
}

/** Approves, rejects or (by its requester) withdraws a pending role assignment request. */
export async function decideRoleAssignment(
  tx: RoleAssignmentTransaction,
  input: RoleAssignmentScope & {
    readonly changeReference: string;
    readonly decision: "Approved" | "Rejected" | "Withdrawn";
    readonly decidedBy: string;
    readonly at: string;
    readonly auditReference: string;
    readonly snapshotReference: string;
    /** Signed Platform approval evidence when Platform support decides instead of the Store. */
    readonly platformApprovalEvidence?: string;
  },
  /** Membership owner's confirmation that the subject is still an Active member of the Store. */
  confirmMember: (member: {
    readonly actorReference: string;
    readonly membershipReference: string;
    readonly storeAssignmentReference: string;
  }) => Promise<boolean>,
): Promise<{
  readonly status: "Applied" | "AlreadyApplied";
  readonly policyVersion: number | null;
}> {
  await tx.query(scopeSql, [input.brandReference, input.storeReference]);
  const change = (
    await tx.query(
      `SELECT kind,role_id::text role,assignment_id::text assignment,actor_id::text actor,membership_id::text membership,
         store_assignment_id::text store_assignment,requested_by::text requested_by
       FROM bop_permission.role_assignment_change WHERE change_id=$1 AND brand_id=$2 AND store_id=$3`,
      [input.changeReference, input.brandReference, input.storeReference],
    )
  ).rows[0];
  if (change === undefined || change.kind !== "Assign") return fail("ROLE_ASSIGNMENT_NOT_FOUND");
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "bop_permission.role_assignment:" + input.storeReference + ":" + String(change.actor),
  ]);
  const decided = (
    await tx.query(
      "SELECT decision,decided_by::text decided_by,policy_version FROM bop_permission.role_assignment_change_decision WHERE change_id=$1",
      [input.changeReference],
    )
  ).rows[0];
  if (decided !== undefined) {
    if (decided.decision !== input.decision || decided.decided_by !== input.decidedBy)
      fail("ROLE_ASSIGNMENT_CONFLICT");
    return {
      status: "AlreadyApplied",
      policyVersion: decided.policy_version === null ? null : Number(decided.policy_version),
    };
  }
  if (
    input.decision === "Withdrawn"
      ? input.decidedBy !== change.requested_by
      : input.decidedBy === change.requested_by || input.decidedBy === change.actor
  )
    fail("ROLE_ASSIGNMENT_SELF");
  let policyVersion: number | null = null;
  if (input.decision === "Approved") {
    await activeRole(tx, input, String(change.role));
    if (
      (await confirmMember({
        actorReference: String(change.actor),
        membershipReference: String(change.membership),
        storeAssignmentReference: String(change.store_assignment),
      })) !== true
    )
      fail("ROLE_ASSIGNMENT_CONFLICT");
    await tx.query(scopeSql, [input.brandReference, input.storeReference]);
    const held = await tx.query(
      "SELECT 1 FROM bop_permission.role_assignment WHERE role_id=$1 AND actor_id=$2 AND lifecycle='Active'",
      [change.role, change.actor],
    );
    if (held.rows.length > 0) fail("ROLE_ASSIGNMENT_CONFLICT");
    policyVersion = await advancePolicy(
      tx,
      input.brandReference,
      input.snapshotReference,
      input.at,
    );
    await tx.query(
      `INSERT INTO bop_permission.role_assignment(assignment_id,role_id,membership_id,store_assignment_id,actor_id,brand_id,store_id,lifecycle,
         effective_from,effective_until,version,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,'Active',$8,NULL,1,$8,$8)`,
      [
        change.assignment,
        change.role,
        change.membership,
        change.store_assignment,
        change.actor,
        input.brandReference,
        input.storeReference,
        input.at,
      ],
    );
  }
  await tx.query(
    `INSERT INTO bop_permission.role_assignment_change_decision(change_id,brand_id,store_id,decision,decided_by,decided_at,policy_version,audit_id,data_classification)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ConfigurationMetadata')`,
    [
      input.changeReference,
      input.brandReference,
      input.storeReference,
      input.decision,
      input.decidedBy,
      input.at,
      policyVersion,
      input.auditReference,
    ],
  );
  await audit(tx, input, {
    auditReference: input.auditReference,
    actorReference: input.decidedBy,
    actionCode: "ROLE_ASSIGNMENT_" + input.decision.toUpperCase(),
    targetId: input.changeReference,
    reasonCode: "STAFF_ROLE_ASSIGNMENT",
    correlationId: input.changeReference,
    at: input.at,
    summary: {
      subject: String(change.actor),
      policyVersion,
      platformApprovalEvidence: input.platformApprovalEvidence ?? null,
    },
  });
  return { status: "Applied", policyVersion };
}

/** Ends an active assignment at once; refuses self-revocation and removing the last Owner. */
export async function revokeRoleAssignment(
  tx: RoleAssignmentTransaction,
  input: RoleAssignmentScope & {
    readonly changeReference: string;
    readonly assignmentReference: string;
    readonly revokedBy: string;
    readonly at: string;
    readonly auditReference: string;
    readonly snapshotReference: string;
  },
): Promise<{ readonly status: "Applied" | "AlreadyApplied"; readonly policyVersion: number }> {
  await tx.query(scopeSql, [input.brandReference, input.storeReference]);
  const prior = (
    await tx.query(
      `SELECT c.assignment_id::text assignment,c.requested_by::text requested_by,d.policy_version
       FROM bop_permission.role_assignment_change c LEFT JOIN bop_permission.role_assignment_change_decision d ON d.change_id=c.change_id
       WHERE c.change_id=$1`,
      [input.changeReference],
    )
  ).rows[0];
  if (prior !== undefined) {
    if (prior.assignment !== input.assignmentReference || prior.requested_by !== input.revokedBy)
      fail("ROLE_ASSIGNMENT_IDEMPOTENCY_CONFLICT");
    return { status: "AlreadyApplied", policyVersion: Number(prior.policy_version) };
  }
  const assignment = (
    await tx.query(
      `SELECT a.role_id::text role,a.actor_id::text actor,a.membership_id::text membership,a.store_assignment_id::text store_assignment,r.role_code
       FROM bop_permission.role_assignment a JOIN bop_permission.role r ON r.role_id=a.role_id AND r.brand_id=a.brand_id
       WHERE a.assignment_id=$1 AND a.brand_id=$2 AND a.store_id=$3 AND a.lifecycle='Active'`,
      [input.assignmentReference, input.brandReference, input.storeReference],
    )
  ).rows[0];
  if (assignment === undefined) return fail("ROLE_ASSIGNMENT_NOT_FOUND");
  if (assignment.actor === input.revokedBy) fail("ROLE_ASSIGNMENT_SELF");
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "bop_permission.role_assignment:" + input.storeReference + ":owners",
  ]);
  if (assignment.role_code === ownerRoleCode) {
    const owners = Number(
      (
        await tx.query(
          "SELECT count(*)::int n FROM bop_permission.role_assignment WHERE role_id=$1 AND lifecycle='Active'",
          [assignment.role],
        )
      ).rows[0]?.n ?? 0,
    );
    if (owners <= 1) fail("ROLE_ASSIGNMENT_LAST_OWNER");
  }
  const policyVersion = await advancePolicy(
    tx,
    input.brandReference,
    input.snapshotReference,
    input.at,
  );
  await tx.query(
    "UPDATE bop_permission.role_assignment SET lifecycle='Ended',effective_until=$2,version=version+1,updated_at=$2 WHERE assignment_id=$1 AND lifecycle='Active'",
    [input.assignmentReference, input.at],
  );
  await tx.query(
    `INSERT INTO bop_permission.role_assignment_change(change_id,brand_id,store_id,kind,role_id,assignment_id,actor_id,membership_id,store_assignment_id,
       requested_by,requested_at,reason_code,audit_id,data_classification)
     VALUES($1,$2,$3,'Revoke',$4,$5,$6,$7,$8,$9,$10,'STAFF_ROLE_REVOCATION',$11,'ConfigurationMetadata')`,
    [
      input.changeReference,
      input.brandReference,
      input.storeReference,
      assignment.role,
      input.assignmentReference,
      assignment.actor,
      assignment.membership,
      assignment.store_assignment,
      input.revokedBy,
      input.at,
      input.auditReference,
    ],
  );
  await tx.query(
    `INSERT INTO bop_permission.role_assignment_change_decision(change_id,brand_id,store_id,decision,decided_by,decided_at,policy_version,audit_id,data_classification)
     VALUES($1,$2,$3,'Applied',$4,$5,$6,$7,'ConfigurationMetadata')`,
    [
      input.changeReference,
      input.brandReference,
      input.storeReference,
      input.revokedBy,
      input.at,
      policyVersion,
      input.auditReference,
    ],
  );
  await audit(tx, input, {
    auditReference: input.auditReference,
    actorReference: input.revokedBy,
    actionCode: "ROLE_ASSIGNMENT_REVOKED",
    targetId: input.assignmentReference,
    reasonCode: "STAFF_ROLE_REVOCATION",
    correlationId: input.changeReference,
    at: input.at,
    summary: {
      roleCode: String(assignment.role_code),
      subject: String(assignment.actor),
      policyVersion,
    },
  });
  return { status: "Applied", policyVersion };
}

/** The recorded decision of a role assignment change, if any. */
export async function readRoleAssignmentDecision(
  tx: RoleAssignmentTransaction,
  scope: RoleAssignmentScope,
  changeReference: string,
): Promise<{
  readonly decision: string;
  readonly decidedBy: string;
  readonly policyVersion: number | null;
} | null> {
  await tx.query(scopeSql, [scope.brandReference, scope.storeReference]);
  const row = (
    await tx.query(
      "SELECT decision,decided_by::text decided_by,policy_version FROM bop_permission.role_assignment_change_decision WHERE change_id=$1",
      [changeReference],
    )
  ).rows[0];
  return row === undefined
    ? null
    : {
        decision: String(row.decision),
        decidedBy: String(row.decided_by),
        policyVersion: row.policy_version === null ? null : Number(row.policy_version),
      };
}
