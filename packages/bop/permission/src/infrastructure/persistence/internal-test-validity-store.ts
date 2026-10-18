/**
 * WP-2423 InternalTest only: the Permission owner's Owner-approved extension of the synthetic
 * DEMO roles' validity end. Only the `effective_until` of Active roles whose code is labelled
 * synthetic (`synthetic_…`, `internal_pilot_…`), of their Active role assignments to synthetic
 * fixture actors and of their Active permission grants moves, from the installation's common
 * expiry to a later instant at most 30 days ahead. Each row's version advances, the Brand policy
 * version advances once (as for any role change) and each change is audited (before → after,
 * approval). Rows already at the new end are left as they are; a repeated run changes nothing.
 * Any other Active role, assignment or grant with the same expiry refuses the whole extension:
 * real staff roles change only through role administration.
 */
export interface InternalTestPermissionTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export interface InternalTestPermissionValidityChange {
  readonly targetType: "Role" | "RoleAssignment" | "PermissionGrant";
  readonly targetId: string;
  readonly from: string;
  readonly to: string;
  readonly versionBefore: number;
  readonly versionAfter: number;
}
export class InternalTestPermissionValidityError extends Error {
  constructor(
    readonly code:
      | "INTERNAL_TEST_PERMISSION_INPUT_INVALID"
      | "INTERNAL_TEST_PERMISSION_NOT_SYNTHETIC"
      | "INTERNAL_TEST_PERMISSION_CONFLICT",
  ) {
    super(code);
    this.name = "InternalTestPermissionValidityError";
  }
}
const fail = (code: InternalTestPermissionValidityError["code"]): never => {
  throw new InternalTestPermissionValidityError(code);
};
const SYNTHETIC = /^[0-9a-f]{8}-0000-7000-8000-[0-9a-f]{12}$/u;
/** Role codes the InternalTest installation gave its synthetic DEMO roles. */
export const internalTestRoleCodePattern = /^(?:synthetic_|internal_pilot_)[a-z0-9_]+$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_DAYS = 30;
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : fail("INTERNAL_TEST_PERMISSION_CONFLICT");
const instant = (value: unknown) =>
  typeof value === "string" && INSTANT.test(value) && new Date(value).toISOString() === value;

export interface InternalTestPermissionValidityInput {
  readonly brandReference: string;
  readonly storeReference: string;
  /** The installation's current common expiry. */
  readonly from: string;
  /** The approved new end, at most 30 days after `at`. */
  readonly to: string;
  readonly at: string;
  readonly evidence: {
    readonly renewalReference: string;
    readonly approvedBy: string;
    readonly approval: string;
    readonly reason: string;
    readonly operatorAccount: string;
  };
  readonly nextReference: () => string;
}

const tables = {
  Role: { table: "role", key: "role_id" },
  RoleAssignment: { table: "role_assignment", key: "assignment_id" },
  PermissionGrant: { table: "permission_grant", key: "grant_id" },
} as const;

/** Extends the DEMO roles, assignments and grants of one Store's Brand; see the module note. */
export async function extendInternalTestPermissionValidity(
  tx: InternalTestPermissionTransaction,
  input: InternalTestPermissionValidityInput,
  /** The platform Audit append (`appendAuditRecordInTransaction`) supplied by the composition. */
  appendAudit: (
    tx: InternalTestPermissionTransaction,
    record: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<{
  readonly changes: readonly InternalTestPermissionValidityChange[];
  readonly alreadyRenewed: number;
  readonly policyVersion: number | null;
}> {
  if (
    !SYNTHETIC.test(input.brandReference) ||
    !SYNTHETIC.test(input.storeReference) ||
    !instant(input.from) ||
    !instant(input.to) ||
    !instant(input.at) ||
    input.to < input.from ||
    input.to <= input.at ||
    Date.parse(input.to) > Date.parse(input.at) + MAX_DAYS * 86_400_000 ||
    !UUID_V7.test(input.evidence.renewalReference) ||
    typeof input.nextReference !== "function"
  )
    fail("INTERNAL_TEST_PERMISSION_INPUT_INVALID");
  const scope = (store: string) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      input.brandReference,
      store,
    ]);
  await scope(input.storeReference);
  // Role administration takes the same lock on policy_state first, so concurrent role changes
  // serialize with the extension; only the tables it changes are locked.
  await tx.query(
    "LOCK TABLE bop_permission.policy_state,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant IN SHARE ROW EXCLUSIVE MODE",
    [],
  );
  const window = [input.brandReference, input.storeReference, input.from, input.to];
  const inScope = (alias: string) =>
    `${alias}.brand_id=$1 AND (${alias}.store_id IS NULL OR ${alias}.store_id=$2) AND ${alias}.lifecycle='Active' AND ${alias}.effective_until IN ($3::timestamptz,$4::timestamptz)`;
  const roles = (
    await tx.query(
      `SELECT r.role_id::text id,r.store_id::text store,r.role_code code,r.effective_until,r.version::int version
       FROM bop_permission.role r WHERE ${inScope("r")} ORDER BY r.role_id LIMIT 101`,
      window,
    )
  ).rows;
  const assignments = (
    await tx.query(
      `SELECT a.assignment_id::text id,a.store_id::text store,r.role_code code,a.actor_id::text actor,a.effective_until,a.version::int version
       FROM bop_permission.role_assignment a JOIN bop_permission.role r ON r.role_id=a.role_id AND r.brand_id=a.brand_id
       WHERE ${inScope("a")} ORDER BY a.assignment_id LIMIT 101`,
      window,
    )
  ).rows;
  const grants = (
    await tx.query(
      `SELECT g.grant_id::text id,g.store_id::text store,r.role_code code,g.effective_until,g.version::int version
       FROM bop_permission.permission_grant g JOIN bop_permission.role r ON r.role_id=g.role_id AND r.brand_id=g.brand_id
       WHERE ${inScope("g")} ORDER BY g.grant_id LIMIT 1001`,
      window,
    )
  ).rows;
  const labelled = (row: Record<string, unknown>) =>
    typeof row.code === "string" && internalTestRoleCodePattern.test(row.code);
  if (
    roles.length > 100 ||
    assignments.length > 100 ||
    grants.length > 1000 ||
    ![...roles, ...assignments, ...grants].every(labelled) ||
    !assignments.every((row) => typeof row.actor === "string" && SYNTHETIC.test(row.actor))
  )
    fail("INTERNAL_TEST_PERMISSION_NOT_SYNTHETIC");
  const targets = [
    ...roles.map((row) => ({ row, kind: "Role" as const })),
    ...assignments.map((row) => ({ row, kind: "RoleAssignment" as const })),
    ...grants.map((row) => ({ row, kind: "PermissionGrant" as const })),
  ];
  const pending = targets.filter(({ row }) => iso(row.effective_until) !== input.to);
  if (pending.length === 0)
    return { changes: [], alreadyRenewed: targets.length, policyVersion: null };
  const advanced = (
    await tx.query(
      "UPDATE bop_permission.policy_state SET snapshot_id=$2,version=version+1,updated_at=$3 WHERE brand_id=$1 RETURNING version::text v",
      [input.brandReference, input.nextReference(), input.at],
    )
  ).rows;
  if (advanced.length !== 1) fail("INTERNAL_TEST_PERMISSION_CONFLICT");
  const policyVersion = Number(advanced[0]?.v);
  const changes: InternalTestPermissionValidityChange[] = [];
  for (const { row, kind } of pending) {
    const { table, key } = tables[kind];
    const updated = (
      await tx.query(
        `UPDATE bop_permission.${table} SET effective_until=$2,version=version+1,updated_at=$3
         WHERE ${key}=$1 AND brand_id=$4 AND lifecycle='Active' AND effective_until=$5 AND version=$6 RETURNING version::int version`,
        [row.id, input.to, input.at, input.brandReference, input.from, row.version],
      )
    ).rows;
    if (updated.length !== 1) fail("INTERNAL_TEST_PERMISSION_CONFLICT");
    const change: InternalTestPermissionValidityChange = {
      targetType: kind,
      targetId: String(row.id),
      from: input.from,
      to: input.to,
      versionBefore: Number(row.version),
      versionAfter: Number(updated[0]?.version),
    };
    const brandLevel = row.store === null;
    // Brand rows (no Store) are audited in the Brand chain, which needs no Store scope.
    if (brandLevel) await scope("");
    await appendAudit(tx, {
      auditId: input.nextReference(),
      brandId: input.brandReference,
      ...(brandLevel ? {} : { storeId: String(row.store) }),
      actor: { type: "System" },
      actionCode: "INTERNAL_TEST_VALIDITY_EXTENDED",
      targetType: kind,
      targetId: change.targetId,
      beforeSummary: { effectiveUntil: change.from, version: change.versionBefore },
      afterSummary: {
        effectiveUntil: change.to,
        version: change.versionAfter,
        roleCode: String(row.code),
        policyVersion,
        environment: "InternalTest",
        approvedBy: input.evidence.approvedBy,
        approval: input.evidence.approval,
        reason: input.evidence.reason,
        operatorAccount: input.evidence.operatorAccount,
      },
      reasonCode: "INTERNAL_TEST_RENEWAL",
      correlationId: input.evidence.renewalReference,
      occurredAt: input.at,
      sourceChannel: "DEPLOYMENT",
      dataClassification: "Internal",
      retentionPolicyCode: "AUDIT_SECURITY",
      retentionPolicyVersion: 1,
    });
    if (brandLevel) await scope(input.storeReference);
    changes.push(change);
  }
  return { changes, alreadyRenewed: targets.length - pending.length, policyVersion };
}
