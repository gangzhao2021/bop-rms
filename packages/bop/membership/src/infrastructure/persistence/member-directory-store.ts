import { parseMembershipReference } from "../../domain/membership.js";

/**
 * WP-2423: Membership owner's Store staff directory (Section 88 IAM-USER-LIST): the Store's members
 * with their assignment state and the display name an administrator maintains for them. The name is
 * personal data; it is returned to authorized staff screens only and never written to audit.
 */
export interface MemberDirectoryTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export interface StoreMember {
  readonly actorReference: string;
  readonly membershipReference: string;
  readonly storeAssignmentReference: string;
  readonly membershipLifecycle: string;
  readonly assignmentLifecycle: string;
  readonly displayName: string | null;
  readonly profileVersion: number;
}
export class MemberDirectoryError extends Error {
  constructor(
    readonly code:
      | "MEMBER_DIRECTORY_INPUT_INVALID"
      | "MEMBER_DIRECTORY_NOT_FOUND"
      | "MEMBER_DIRECTORY_VERSION_CONFLICT"
      | "MEMBER_DIRECTORY_IDEMPOTENCY_CONFLICT",
  ) {
    super(code);
    this.name = "MemberDirectoryError";
  }
}
const scopeSql = "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)";
const listSql = `SELECT s.actor_id::text actor,m.membership_id::text membership,s.assignment_id::text assignment,
   m.lifecycle membership_lifecycle,s.lifecycle assignment_lifecycle,p.display_name,COALESCE(p.version,0)::int profile_version
 FROM bop_membership.store_assignment s
 JOIN bop_membership.membership m ON m.membership_id=s.membership_id AND m.actor_id=s.actor_id AND m.brand_id=s.brand_id
 LEFT JOIN LATERAL (SELECT display_name,version FROM bop_membership.member_profile_version x
   WHERE x.membership_id=m.membership_id ORDER BY x.version DESC LIMIT 1) p ON true
 WHERE s.brand_id=$1 AND s.store_id=$2 AND s.lifecycle<>'Ended' AND m.lifecycle<>'Ended'`;
const row = (item: Record<string, unknown>): StoreMember =>
  Object.freeze({
    actorReference: String(item.actor),
    membershipReference: String(item.membership),
    storeAssignmentReference: String(item.assignment),
    membershipLifecycle: String(item.membership_lifecycle),
    assignmentLifecycle: String(item.assignment_lifecycle),
    displayName: item.display_name === null ? null : String(item.display_name),
    profileVersion: Number(item.profile_version),
  });

export async function listStoreMembers(
  tx: MemberDirectoryTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
): Promise<readonly StoreMember[]> {
  await tx.query(scopeSql, [scope.brandReference, scope.storeReference]);
  return (
    await tx.query(listSql + " ORDER BY p.display_name NULLS LAST,s.actor_id", [
      scope.brandReference,
      scope.storeReference,
    ])
  ).rows.map(row);
}
export async function loadStoreMember(
  tx: MemberDirectoryTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  actorReference: string,
): Promise<StoreMember> {
  await tx.query(scopeSql, [scope.brandReference, scope.storeReference]);
  const found = (
    await tx.query(listSql + " AND s.actor_id=$3", [
      scope.brandReference,
      scope.storeReference,
      actorReference,
    ])
  ).rows[0];
  if (found === undefined) throw new MemberDirectoryError("MEMBER_DIRECTORY_NOT_FOUND");
  return row(found);
}

const nameText = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    [...value].length > 80 ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    throw new MemberDirectoryError("MEMBER_DIRECTORY_INPUT_INVALID");
  return value;
};

/** Records a new display name version for a Store member; idempotent per operation. */
export async function setStoreMemberDisplayName(
  tx: MemberDirectoryTransaction,
  input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly actorReference: string;
    readonly expectedProfileVersion: number;
    readonly displayName: string;
    readonly operationReference: string;
    readonly changedBy: string;
    readonly changedAt: string;
    readonly auditReference: string;
  },
  /** The platform Audit append (`appendAuditRecordInTransaction`) supplied by the composition. */
  appendAudit: (
    tx: MemberDirectoryTransaction,
    record: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<{ readonly profileVersion: number; readonly status: "Applied" | "AlreadyApplied" }> {
  const displayName = nameText(input.displayName);
  const member = await loadStoreMember(tx, input, input.actorReference);
  parseMembershipReference(member.membershipReference);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "bop_membership.member_profile:" + member.membershipReference,
  ]);
  const prior = (
    await tx.query(
      "SELECT membership_id::text membership,version::int version,display_name FROM bop_membership.member_profile_version WHERE brand_id=$1 AND operation_id=$2",
      [input.brandReference, input.operationReference],
    )
  ).rows[0];
  if (prior !== undefined) {
    if (prior.membership !== member.membershipReference || prior.display_name !== displayName)
      throw new MemberDirectoryError("MEMBER_DIRECTORY_IDEMPOTENCY_CONFLICT");
    return { profileVersion: Number(prior.version), status: "AlreadyApplied" };
  }
  const head = Number(
    (
      await tx.query(
        "SELECT COALESCE(max(version),0)::int v FROM bop_membership.member_profile_version WHERE membership_id=$1",
        [member.membershipReference],
      )
    ).rows[0]?.v ?? 0,
  );
  if (head !== input.expectedProfileVersion)
    throw new MemberDirectoryError("MEMBER_DIRECTORY_VERSION_CONFLICT");
  await tx.query(
    `INSERT INTO bop_membership.member_profile_version(membership_id,version,brand_id,actor_id,display_name,operation_id,changed_by,changed_at,data_classification)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PersonalData')`,
    [
      member.membershipReference,
      head + 1,
      input.brandReference,
      member.actorReference,
      displayName,
      input.operationReference,
      input.changedBy,
      input.changedAt,
    ],
  );
  // The audit records who changed which member's profile, never the name itself.
  await appendAudit(tx, {
    auditId: input.auditReference,
    brandId: input.brandReference,
    storeId: input.storeReference,
    actor: { type: "User", reference: input.changedBy },
    actionCode: "MEMBER_PROFILE_NAME_CHANGED",
    targetType: "Membership",
    targetId: member.membershipReference,
    afterSummary: { profileVersion: head + 1 },
    reasonCode: "STAFF_PROFILE_MAINTENANCE",
    correlationId: input.operationReference,
    occurredAt: input.changedAt,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Internal",
    retentionPolicyCode: "AUDIT_STANDARD",
    retentionPolicyVersion: 1,
  });
  return { profileVersion: head + 1, status: "Applied" };
}

/**
 * WP-2423 step 9: a member leaves the Store — their Store assignment ends now (append-only history:
 * the row keeps its start and gains its end). The caller ends their Store roles and sessions in the
 * same transaction. Ending an already ended assignment is a no-op (a retried request).
 */
export async function endStoreMemberAssignment(
  tx: MemberDirectoryTransaction,
  input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly actorReference: string;
    readonly operationReference: string;
    readonly endedBy: string;
    readonly endedAt: string;
    readonly auditReference: string;
  },
  /** The platform Audit append (`appendAuditRecordInTransaction`) supplied by the composition. */
  appendAudit: (
    tx: MemberDirectoryTransaction,
    record: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<{
  readonly status: "Applied" | "AlreadyApplied";
  readonly membershipReference: string;
}> {
  parseMembershipReference(input.actorReference);
  await tx.query(scopeSql, [input.brandReference, input.storeReference]);
  const rows = (
    await tx.query(
      `SELECT assignment_id::text assignment,membership_id::text membership,lifecycle FROM bop_membership.store_assignment
       WHERE brand_id=$1 AND store_id=$2 AND actor_id=$3 ORDER BY effective_from DESC,assignment_id DESC LIMIT 2`,
      [input.brandReference, input.storeReference, input.actorReference],
    )
  ).rows;
  const latest = rows[0];
  if (latest === undefined) throw new MemberDirectoryError("MEMBER_DIRECTORY_NOT_FOUND");
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "bop_membership.store_assignment:" + String(latest.assignment),
  ]);
  if (latest.lifecycle === "Ended")
    return { status: "AlreadyApplied", membershipReference: String(latest.membership) };
  const updated = await tx.query(
    `UPDATE bop_membership.store_assignment SET lifecycle='Ended',effective_until=$2,version=version+1,updated_at=$2
     WHERE assignment_id=$1 AND lifecycle<>'Ended' AND effective_from<$2 RETURNING version`,
    [latest.assignment, input.endedAt],
  );
  if (updated.rows.length !== 1)
    throw new MemberDirectoryError("MEMBER_DIRECTORY_VERSION_CONFLICT");
  await appendAudit(tx, {
    auditId: input.auditReference,
    brandId: input.brandReference,
    storeId: input.storeReference,
    actor: { type: "User", reference: input.endedBy },
    actionCode: "MEMBER_STORE_ASSIGNMENT_ENDED",
    targetType: "StoreAssignment",
    targetId: String(latest.assignment),
    afterSummary: { lifecycle: "Ended" },
    reasonCode: "STAFF_OFFBOARDING",
    correlationId: input.operationReference,
    occurredAt: input.endedAt,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Internal",
    retentionPolicyCode: "AUDIT_STANDARD",
    retentionPolicyVersion: 1,
  });
  return { status: "Applied", membershipReference: String(latest.membership) };
}
