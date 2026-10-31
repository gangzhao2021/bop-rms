/**
 * WP-2423 InternalTest only: the Membership owner's Owner-approved extension of the synthetic DEMO
 * staff roster's validity end (memberships and Store assignments). Only the `effective_until` of
 * Active rows whose identities are synthetic fixtures (`xxxxxxxx-0000-7000-8000-…`) moves, from
 * the installation's common expiry to a later instant at most 30 days ahead; each row's version
 * advances like any other owner change and each change is audited (before → after, approval).
 * Rows already at the new end are left as they are, so a repeated run (also with `from` equal to
 * `to`, after a completed renewal) changes nothing. Any
 * non-synthetic Active row with the same expiry refuses the whole extension: a real Store's staff
 * validity changes only through its own staff administration.
 */
export interface InternalTestMembershipTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export interface InternalTestValidityEvidence {
  readonly renewalReference: string;
  readonly approvedBy: string;
  readonly approval: string;
  readonly reason: string;
  readonly operatorAccount: string;
}
export interface InternalTestValidityChange {
  readonly targetType: string;
  readonly targetId: string;
  readonly from: string;
  readonly to: string;
  readonly versionBefore: number;
  readonly versionAfter: number;
}
export class InternalTestMembershipValidityError extends Error {
  constructor(
    readonly code:
      | "INTERNAL_TEST_MEMBERSHIP_INPUT_INVALID"
      | "INTERNAL_TEST_MEMBERSHIP_NOT_SYNTHETIC"
      | "INTERNAL_TEST_MEMBERSHIP_CONFLICT",
  ) {
    super(code);
    this.name = "InternalTestMembershipValidityError";
  }
}
const fail = (code: InternalTestMembershipValidityError["code"]): never => {
  throw new InternalTestMembershipValidityError(code);
};
const SYNTHETIC = /^[0-9a-f]{8}-0000-7000-8000-[0-9a-f]{12}$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_DAYS = 30;
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : fail("INTERNAL_TEST_MEMBERSHIP_CONFLICT");
const instant = (value: unknown) =>
  typeof value === "string" && INSTANT.test(value) && new Date(value).toISOString() === value;

function validate(input: InternalTestMembershipValidityInput) {
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
    fail("INTERNAL_TEST_MEMBERSHIP_INPUT_INVALID");
}
export interface InternalTestMembershipValidityInput {
  readonly brandReference: string;
  readonly storeReference: string;
  /** The installation's current common expiry. */
  readonly from: string;
  /** The approved new end, at most 30 days after `at`. */
  readonly to: string;
  readonly at: string;
  readonly evidence: InternalTestValidityEvidence;
  readonly nextReference: () => string;
}

/** Extends the DEMO roster's memberships and Store assignments of one Store; see the module note. */
export async function extendInternalTestMembershipValidity(
  tx: InternalTestMembershipTransaction,
  input: InternalTestMembershipValidityInput,
  /** The platform Audit append (`appendAuditRecordInTransaction`) supplied by the composition. */
  appendAudit: (
    tx: InternalTestMembershipTransaction,
    record: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<{
  readonly changes: readonly InternalTestValidityChange[];
  readonly alreadyRenewed: number;
}> {
  validate(input);
  const scope = (store: string) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      input.brandReference,
      store,
    ]);
  await scope(input.storeReference);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "bop_membership.internal_test_validity:" + input.brandReference,
  ]);
  await tx.query(
    "LOCK TABLE bop_membership.membership,bop_membership.store_assignment IN SHARE ROW EXCLUSIVE MODE",
    [],
  );
  const memberships = (
    await tx.query(
      `SELECT membership_id::text id,actor_id::text actor,workforce_relationship_reference::text relationship,
         effective_until,version::int version
       FROM bop_membership.membership
       WHERE brand_id=$1 AND lifecycle='Active' AND effective_until IN ($2::timestamptz,$3::timestamptz)
       ORDER BY membership_id LIMIT 101`,
      [input.brandReference, input.from, input.to],
    )
  ).rows;
  const assignments = (
    await tx.query(
      `SELECT assignment_id::text id,membership_id::text membership,actor_id::text actor,effective_until,version::int version
       FROM bop_membership.store_assignment
       WHERE brand_id=$1 AND store_id=$2 AND lifecycle='Active' AND effective_until IN ($3::timestamptz,$4::timestamptz)
       ORDER BY assignment_id LIMIT 101`,
      [input.brandReference, input.storeReference, input.from, input.to],
    )
  ).rows;
  if (memberships.length > 100 || assignments.length > 100)
    fail("INTERNAL_TEST_MEMBERSHIP_NOT_SYNTHETIC");
  if (
    memberships.some(
      (row) =>
        ![row.id, row.actor, row.relationship].every(
          (value) => typeof value === "string" && SYNTHETIC.test(value),
        ),
    ) ||
    assignments.some(
      (row) =>
        ![row.id, row.membership, row.actor].every(
          (value) => typeof value === "string" && SYNTHETIC.test(value),
        ),
    )
  )
    fail("INTERNAL_TEST_MEMBERSHIP_NOT_SYNTHETIC");
  const changes: InternalTestValidityChange[] = [];
  let alreadyRenewed = 0;
  const targets = [
    ...memberships.map((row) => ({ row, table: "membership", key: "membership_id" })),
    ...assignments.map((row) => ({ row, table: "store_assignment", key: "assignment_id" })),
  ] as const;
  for (const { row, table, key } of targets) {
    if (iso(row.effective_until) === input.to) {
      alreadyRenewed += 1;
      continue;
    }
    const updated = (
      await tx.query(
        `UPDATE bop_membership.${table} SET effective_until=$2,version=version+1,updated_at=$3
         WHERE ${key}=$1 AND brand_id=$4 AND lifecycle='Active' AND effective_until=$5 AND version=$6 RETURNING version::int version`,
        [row.id, input.to, input.at, input.brandReference, input.from, row.version],
      )
    ).rows;
    if (updated.length !== 1) fail("INTERNAL_TEST_MEMBERSHIP_CONFLICT");
    const change = {
      targetType: table === "membership" ? "Membership" : "StoreAssignment",
      targetId: String(row.id),
      from: input.from,
      to: input.to,
      versionBefore: Number(row.version),
      versionAfter: Number(updated[0]?.version),
    };
    // Memberships are Brand facts: their audit belongs to the Brand chain (no Store scope).
    if (table === "membership") await scope("");
    await appendAudit(tx, {
      auditId: input.nextReference(),
      brandId: input.brandReference,
      ...(table === "membership" ? {} : { storeId: input.storeReference }),
      actor: { type: "System" },
      actionCode: "INTERNAL_TEST_VALIDITY_EXTENDED",
      targetType: change.targetType,
      targetId: change.targetId,
      beforeSummary: { effectiveUntil: change.from, version: change.versionBefore },
      afterSummary: {
        effectiveUntil: change.to,
        version: change.versionAfter,
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
    if (table === "membership") await scope(input.storeReference);
    changes.push(change);
  }
  return { changes, alreadyRenewed };
}
