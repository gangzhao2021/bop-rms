import { canonicalizeRfc8785, appendAuditRecordInTransaction } from "@bop/audit";
import { createIdentityActor, readClosedRecord, type IdentityActor } from "@bop/identity";
import {
  createApprovedPendingWorkforceMembership,
  parseApprovedWorkforceMembership,
  type Membership,
  type ApprovedWorkforceMembership,
  type CurrentWorkforceRelationshipQualification,
  type ApprovedWorkforceMembershipPolicy,
} from "@bop/membership";
import { createBrand, type Brand } from "@bop/tenant";
import {
  advancePolicyState,
  createBrandAdministrationPolicyState,
  createBrandAdministrationPermissionRole,
  createPermissionDefinition,
  createPermissionGrant,
  createRoleAssignment,
  type PolicyState,
} from "../../domain/permission-policy.js";
import {
  ApprovedWorkforcePolicyError,
  approvedWorkforcePolicyArray as array,
  approvedWorkforcePolicyInstant as instant,
  approvedWorkforcePolicyReference as reference,
  parsePrepareApprovedWorkforcePolicy,
  parseHoldApprovedWorkforcePolicy,
  hashApprovedWorkforcePolicyPlan,
  hashApprovedWorkforcePolicyRequest,
  type ApprovedWorkforcePolicyRequest,
  type ApprovedWorkforcePolicyPlan,
  type PrepareApprovedWorkforcePolicy,
} from "../../contracts/approved-workforce-policy.js";

export interface ApprovedWorkforcePolicyTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface ApprovedWorkforcePolicyAuthority {
  readonly requestDigest: string;
  readonly approval: ApprovedWorkforceMembership;
  readonly brand: Brand;
  /** Actual immutable original Pending-v1 receipt. On hold, the Membership owner
   * separately fences its exact Pending1 -> Active2 transition. This receipt is
   * never represented as a current Active Membership or business authorization. */
  readonly pendingMembership: Membership;
  /** Current original inviter for preparation; intended Workforce target with
   * verified recent MFA for activation. Original approver is signed evidence. */
  readonly operator: IdentityActor;
  readonly relationship: CurrentWorkforceRelationshipQualification;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface ApprovedWorkforcePolicyStoreOptions {
  readonly transaction: ApprovedWorkforcePolicyTransaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly auditReference: string;
  readonly authority: {
    /** Resolve the exact signed original, its current trusted signer/withdrawal,
     * current Brand/relationship and actual Pending receipt. Echoing requestDigest
     * or the claimed planDigest is insufficient. No default authority is supplied. */
    hold(
      tx: ApprovedWorkforcePolicyTransaction,
      input: {
        readonly request: ApprovedWorkforcePolicyRequest;
        readonly purposeCode: "WORKFORCE_ONBOARDING";
        readonly requestDigest: string;
        readonly observedAt: string;
        readonly validUntil: string;
      },
    ): Promise<ApprovedWorkforcePolicyAuthority>;
  };
  readonly appendAudit: typeof appendAuditRecordInTransaction;
  readonly registerBeforeCommit: (
    tx: ApprovedWorkforcePolicyTransaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => Promise<void>;
}
export interface ApprovedWorkforcePolicyPreparation extends ApprovedWorkforceMembershipPolicy {
  readonly profile: "ApprovedWorkforcePolicyPreparationV1";
  readonly operationReference: string;
  readonly requestDigest: string;
  readonly auditReference: string;
  readonly occurredAt: string;
}
export interface ApprovedWorkforcePolicyStore {
  prepareApproved(value: unknown): Promise<ApprovedWorkforcePolicyPreparation>;
  holdApproved(value: unknown): Promise<ApprovedWorkforceMembershipPolicy>;
  assertFinalized(): void;
}
const fingerprint = (value: unknown): string => canonicalizeRfc8785(value);
function unavailable(): never {
  throw new ApprovedWorkforcePolicyError("APPROVED_WORKFORCE_POLICY_UNAVAILABLE");
}
function rows(value: unknown, maximum: number): readonly unknown[] {
  const d =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  if (!d?.enumerable || !("value" in d)) return unavailable();
  return array(d.value, maximum);
}
const stateSql = `SELECT brand_id::text AS "brandReference",snapshot_id::text AS "snapshotReference",version::text AS version,
 to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",updated_at=date_trunc('milliseconds',updated_at) AS precise
 FROM bop_permission.policy_state WHERE brand_id=$1 LIMIT 2`;
const rolesSql = `SELECT role_id::text AS "roleReference",brand_id::text AS "brandReference",store_id::text AS "storeReference",role_code AS code,lifecycle,version::text AS version,
 to_char(effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveFrom",to_char(effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveUntil",
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
 effective_from=date_trunc('milliseconds',effective_from) AND effective_until=date_trunc('milliseconds',effective_until) AND created_at=date_trunc('milliseconds',created_at) AND updated_at=date_trunc('milliseconds',updated_at) AS precise
 FROM bop_permission.role WHERE brand_id=$1 AND (role_id=ANY($2::uuid[]) OR role_code=ANY($3::text[])) ORDER BY role_id LIMIT 17`;
const assignmentsSql = `SELECT assignment_id::text AS "assignmentReference",role_id::text AS "roleReference",membership_id::text AS "membershipReference",store_assignment_id::text AS "storeAssignmentReference",actor_id::text AS "actorReference",brand_id::text AS "brandReference",store_id::text AS "storeReference",lifecycle,version::text AS version,
 to_char(effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveFrom",to_char(effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveUntil",
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
 effective_from=date_trunc('milliseconds',effective_from) AND effective_until=date_trunc('milliseconds',effective_until) AND created_at=date_trunc('milliseconds',created_at) AND updated_at=date_trunc('milliseconds',updated_at) AS precise
 FROM bop_permission.role_assignment WHERE brand_id=$1 AND (actor_id=$2 OR membership_id=$3) ORDER BY assignment_id LIMIT 9`;
const grantsSql = `SELECT grant_id::text AS "grantReference",role_id::text AS "roleReference",permission_id::text AS "permissionReference",brand_id::text AS "brandReference",store_id::text AS "storeReference",lifecycle,version::text AS version,
 to_char(effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveFrom",to_char(effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveUntil",
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
 effective_from=date_trunc('milliseconds',effective_from) AND effective_until=date_trunc('milliseconds',effective_until) AND created_at=date_trunc('milliseconds',created_at) AND updated_at=date_trunc('milliseconds',updated_at) AS precise
 FROM bop_permission.permission_grant WHERE brand_id=$1 AND role_id=ANY($2::uuid[]) ORDER BY grant_id LIMIT 49`;
const definitionsSql = `SELECT permission_id::text AS "permissionReference",action_code AS action,lifecycle,version::text AS version,
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
 created_at=date_trunc('milliseconds',created_at) AND updated_at=date_trunc('milliseconds',updated_at) AS precise
 FROM bop_permission.permission_definition WHERE permission_id=ANY($1::uuid[]) ORDER BY permission_id LIMIT 7`;
const temporal = [
  "lifecycle",
  "version",
  "effectiveFrom",
  "effectiveUntil",
  "createdAt",
  "updatedAt",
  "precise",
];
function record(
  value: unknown,
  fields: readonly string[],
  at: string,
): Readonly<Record<string, unknown>> & { readonly version: number } {
  const r = readClosedRecord(value, fields);
  if (
    r.precise !== true ||
    typeof r.version !== "string" ||
    !/^[1-9][0-9]*$/u.test(r.version) ||
    !Number.isSafeInteger(Number(r.version))
  )
    return unavailable();
  const { precise, ...data } = r;
  void precise;
  if (instant(r.updatedAt) > at || (r.createdAt !== undefined && instant(r.createdAt) > at))
    return unavailable();
  if (
    r.effectiveFrom !== undefined &&
    (instant(r.effectiveFrom) > at || instant(r.effectiveUntil) <= at)
  )
    return unavailable();
  return { ...data, version: Number(r.version) };
}

/** One preparation, or repeated exact holds of the same approved original.
 * No independent replay/repair: the outer immutable onboarding journal must
 * arbitrate originals before this leaf. Only Brand-only rows are visible under
 * the fixed null-Store RLS scope; this does not claim Store-role qualification. */
export function createPostgresApprovedWorkforcePolicyStore(
  options: ApprovedWorkforcePolicyStoreOptions,
): ApprovedWorkforcePolicyStore {
  const tx = options.transaction,
    queryPort = tx.query,
    clock = options.clock,
    now = clock.now,
    authority = options.authority,
    hold = authority.hold,
    append = options.appendAudit,
    register = options.registerBeforeCommit;
  const origin = instant(options.originalObservedAt),
    originalUntil = instant(options.originalValidUntil),
    auditReference = reference(options.auditReference);
  if (
    originalUntil <= origin ||
    Date.parse(originalUntil) > Date.parse(origin) + 5000 ||
    [queryPort, now, hold, append, register].some((p) => typeof p !== "function")
  )
    return unavailable();
  let phase: "Open" | "Ready" | "Guarded" | "Final" | "Poison" = "Open",
    busy = false,
    registered = false,
    latest = origin,
    deadline = originalUntil,
    transactionId: string | undefined,
    request: ApprovedWorkforcePolicyRequest | undefined,
    requestDigest: string | undefined,
    authorityPin: string | undefined,
    policyPin: string | undefined,
    contentDigest: string | undefined,
    state: PolicyState | undefined;
  const poison = (): never => {
    phase = "Poison";
    return unavailable();
  };
  const check = () => {
    const at = instant(now.call(clock));
    if (
      phase === "Poison" ||
      phase === "Final" ||
      options.transaction !== tx ||
      tx.query !== queryPort ||
      options.clock !== clock ||
      clock.now !== now ||
      options.authority !== authority ||
      authority.hold !== hold ||
      options.appendAudit !== append ||
      options.registerBeforeCommit !== register ||
      options.originalObservedAt !== origin ||
      options.originalValidUntil !== originalUntil ||
      options.auditReference !== auditReference ||
      at < latest ||
      at >= deadline
    )
      return poison();
    latest = at;
    return at;
  };
  const query = async (sql: string, values: readonly unknown[]) => {
    check();
    const result = await queryPort.call(tx, sql, values);
    check();
    return result;
  };
  const sameTx = async () => {
    const page = rows(
      await query(
        "SELECT current_setting('transaction_isolation') AS isolation,pg_current_xact_id()::text AS transaction_id",
        [],
      ),
      1,
    );
    if (page.length !== 1) return poison();
    const r = readClosedRecord(page[0], ["isolation", "transaction_id"]);
    if (
      r.isolation !== "read committed" ||
      typeof r.transaction_id !== "string" ||
      !/^[1-9][0-9]*$/u.test(r.transaction_id) ||
      (transactionId !== undefined && r.transaction_id !== transactionId)
    )
      return poison();
    transactionId = r.transaction_id;
  };
  const current = () => request ?? poison();
  const scope = () =>
    query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
      [current().policy.brandReference],
    );
  const window = (atInput: unknown, untilInput: unknown, at: string) => {
    const observed = instant(atInput),
      until = instant(untilInput);
    if (
      observed < origin ||
      observed > at ||
      until <= at ||
      Date.parse(until) > Date.parse(observed) + 5000
    )
      return poison();
    if (until < deadline) deadline = until;
  };
  const qualify = async () => {
    const command = current(),
      at = check();
    const raw = await hold.call(authority, tx, {
      request: command,
      purposeCode: "WORKFORCE_ONBOARDING",
      requestDigest: requestDigest ?? poison(),
      observedAt: at,
      validUntil: deadline,
    });
    const after = check(),
      r = readClosedRecord(raw, [
        "requestDigest",
        "approval",
        "brand",
        "pendingMembership",
        "operator",
        "relationship",
        "observedAt",
        "validUntil",
      ]);
    const approval = parseApprovedWorkforceMembership(r.approval),
      brand = createBrand(r.brand),
      operator = createIdentityActor(r.operator),
      member = createApprovedPendingWorkforceMembership(
        r.pendingMembership,
        approval.actorReference,
      );
    window(r.observedAt, r.validUntil, after);
    const preparing = command.profile === "PrepareApprovedWorkforcePolicyV1";
    if (
      r.requestDigest !== requestDigest ||
      fingerprint(approval) !== fingerprint(command.approval) ||
      brand.brandReference !== approval.brandReference ||
      !["Draft", "Active"].includes(brand.lifecycle) ||
      String(brand.updatedAt) > at ||
      member.membershipReference !== approval.membershipReference ||
      member.brandReference !== approval.brandReference ||
      member.workforceRelationshipReference !== approval.workforceRelationshipReference ||
      member.effectiveFrom !== approval.effectiveFrom ||
      member.effectiveUntil !== approval.effectiveUntil ||
      member.version !== 1 ||
      member.createdAt !== member.updatedAt ||
      String(member.createdAt) > at ||
      operator.actorType !== "User" ||
      operator.status !== "Active" ||
      operator.authenticationMethod !== "Oidc" ||
      operator.verificationLevel !== "RecentMfa" ||
      operator.actorReference !==
        (preparing ? approval.operatorReference : approval.actorReference) ||
      (preparing
        ? !["Platform", "Workforce"].includes(operator.accountKind)
        : operator.accountKind !== "Workforce") ||
      operator.authenticatedAt === null ||
      operator.recentMfaAt === null ||
      String(operator.authenticatedAt) > at ||
      String(operator.recentMfaAt) > at ||
      approval.effectiveFrom > origin ||
      approval.effectiveUntil <= after
    )
      return poison();
    const rel = readClosedRecord(r.relationship, [
      "profile",
      "environmentReference",
      "actorReference",
      "brandReference",
      "workforceRelationshipReference",
      "relationshipEvidenceReference",
      "issuerReference",
      "revision",
      "relationshipEffectiveFrom",
      "relationshipEffectiveUntil",
      "verifiedAt",
      "observedAt",
      "validUntil",
    ]);
    window(rel.observedAt, rel.validUntil, after);
    if (
      rel.profile !== "CurrentWorkforceRelationshipQualificationV1" ||
      [
        "environmentReference",
        "actorReference",
        "brandReference",
        "workforceRelationshipReference",
        "relationshipEvidenceReference",
      ].some((key) => rel[key] !== approval[key as keyof ApprovedWorkforceMembership]) ||
      rel.revision !== approval.relationshipRevision ||
      instant(rel.verifiedAt) > at ||
      instant(rel.relationshipEffectiveFrom) > approval.effectiveFrom ||
      (rel.relationshipEffectiveUntil !== null &&
        instant(rel.relationshipEffectiveUntil) < approval.effectiveUntil)
    )
      return poison();
    reference(rel.issuerReference);
    const mfaUntil = new Date(Date.parse(operator.recentMfaAt) + 900_000).toISOString();
    for (const until of [approval.effectiveUntil, command.policy.effectiveUntil, mfaUntil])
      if (until < deadline) deadline = until;
    const { observedAt: relObservation, validUntil: relDeadline, ...stableRelationship } = rel;
    void relObservation;
    void relDeadline;
    const pin = fingerprint({
      approval,
      brand,
      member,
      operator,
      relationship: stableRelationship,
    });
    if (authorityPin !== undefined && pin !== authorityPin) return poison();
    authorityPin = pin;
    check();
    await scope();
    return { brand, member };
  };
  const read = async (brand: Brand, member: Membership) => {
    const plan = current().policy,
      roleIds = plan.roles.map((r) => r.roleReference),
      roleCodes = plan.roles.map((r) => r.roleCode),
      permissionIds = [
        ...new Set(plan.roles.flatMap((r) => r.grants.map((g) => g.permissionReference))),
      ];
    const stateRows = rows(await query(stateSql, [plan.brandReference]), 1);
    const root =
      stateRows.length === 0
        ? null
        : createBrandAdministrationPolicyState(
            record(
              stateRows[0],
              ["brandReference", "snapshotReference", "version", "updatedAt", "precise"],
              check(),
            ),
            brand,
          );
    const roles = rows(await query(rolesSql, [plan.brandReference, roleIds, roleCodes]), 16).map(
      (r) =>
        createBrandAdministrationPermissionRole(
          record(
            r,
            ["roleReference", "brandReference", "storeReference", "code", ...temporal],
            check(),
          ),
          brand,
        ),
    );
    const definitions = rows(await query(definitionsSql, [permissionIds]), 6).map((r) =>
      createPermissionDefinition(
        record(
          r,
          [
            "permissionReference",
            "action",
            "lifecycle",
            "version",
            "createdAt",
            "updatedAt",
            "precise",
          ],
          check(),
        ),
      ),
    );
    const byRole = new Map(roles.map((r) => [String(r.roleReference), r])),
      byDefinition = new Map(definitions.map((d) => [String(d.permissionReference), d]));
    const assignments = rows(
      await query(assignmentsSql, [
        plan.brandReference,
        plan.actorReference,
        plan.membershipReference,
      ]),
      8,
    ).map((r) => {
      const value = record(
        r,
        [
          "assignmentReference",
          "roleReference",
          "membershipReference",
          "storeAssignmentReference",
          "actorReference",
          "brandReference",
          "storeReference",
          ...temporal,
        ],
        check(),
      );
      return createRoleAssignment(
        value,
        byRole.get(String(value.roleReference)) ?? poison(),
        member,
        null,
      );
    });
    const grants = rows(await query(grantsSql, [plan.brandReference, roleIds]), 48).map((r) => {
      const value = record(
          r,
          [
            "grantReference",
            "roleReference",
            "permissionReference",
            "brandReference",
            "storeReference",
            ...temporal,
          ],
          check(),
        ),
        definition = byDefinition.get(String(value.permissionReference)) ?? poison();
      return createPermissionGrant(
        { ...value, action: definition.action },
        byRole.get(String(value.roleReference)) ?? poison(),
        definition,
      );
    });
    if (
      rows(
        await query(
          "SELECT override_id::text AS reference FROM bop_permission.permission_override WHERE brand_id=$1 AND actor_id=$2 LIMIT 1",
          [plan.brandReference, plan.actorReference],
        ),
        1,
      ).length
    )
      return poison();
    if (
      definitions.length !== permissionIds.length ||
      definitions.some((d) => d.lifecycle !== "Active")
    )
      return poison();
    for (const definition of definitions)
      if (
        !plan.roles.some((r) =>
          r.grants.some(
            (g) =>
              g.permissionReference === definition.permissionReference &&
              g.action === definition.action,
          ),
        )
      )
        return poison();
    for (const fact of [...roles, ...grants, ...assignments]) {
      if (fact.lifecycle !== "Active" || fact.effectiveUntil === null) return poison();
      if (fact.effectiveUntil < deadline) deadline = fact.effectiveUntil;
    }
    check();
    return { root, roles, definitions, assignments, grants };
  };
  type Facts = Awaited<ReturnType<typeof read>>;
  const roleContent = (facts: Facts, plan: ApprovedWorkforcePolicyPlan["roles"][number]) => {
    const role = facts.roles.find((r) => r.roleReference === plan.roleReference) ?? poison();
    const grants = facts.grants
      .filter((g) => g.roleReference === role.roleReference)
      .map((g) => ({
        grantReference: String(g.grantReference),
        permissionReference: String(g.permissionReference),
        action: String(g.action),
        effectiveFrom: String(g.effectiveFrom),
        effectiveUntil: String(g.effectiveUntil),
      }))
      .sort((a, b) => a.grantReference.localeCompare(b.grantReference));
    const content = {
      roleReference: String(role.roleReference),
      roleCode: String(role.code),
      effectiveFrom: String(role.effectiveFrom),
      effectiveUntil: String(role.effectiveUntil),
      grants,
    };
    const { assignment, ...expected } = plan;
    void assignment;
    if (fingerprint(content) !== fingerprint(expected)) return poison();
    return content;
  };
  const confirm = (facts: Facts) => {
    const plan = current().policy;
    if (
      !facts.root ||
      facts.roles.length !== plan.roles.length ||
      facts.assignments.length !== plan.roles.length
    )
      return poison();
    const actual = {
      ...plan,
      roles: plan.roles.map((r) => {
        const role = roleContent(facts, r),
          matches = facts.assignments.filter((a) => a.roleReference === r.roleReference);
        if (matches.length !== 1) return poison();
        const a = matches[0] ?? poison();
        return {
          ...role,
          assignment: {
            assignmentReference: String(a.assignmentReference),
            effectiveFrom: String(a.effectiveFrom),
            effectiveUntil: String(a.effectiveUntil),
          },
        };
      }),
    };
    const actualDigest = hashApprovedWorkforcePolicyPlan(actual);
    if (actualDigest !== current().approval.approvedPolicyDigest) return poison();
    const pin = fingerprint(facts);
    if (policyPin !== undefined && policyPin !== pin) return poison();
    policyPin = pin;
    contentDigest = actualDigest;
    state = facts.root;
  };
  const packet = (): ApprovedWorkforceMembershipPolicy =>
    Object.freeze({
      approvedPolicyDigest: current().approval.approvedPolicyDigest,
      contentDigest: contentDigest ?? poison(),
      policySnapshotReference: String((state ?? poison()).snapshotReference),
      policyVersion: (state ?? poison()).version,
      observedAt: origin,
      validUntil: deadline,
    });
  const recheck = async () => {
    await sameTx();
    const held = await qualify();
    confirm(await read(held.brand, held.member));
  };
  const registerGuard = async () => {
    if (registered) return;
    registered = true;
    await register(
      tx,
      async () => {
        try {
          if (busy || phase !== "Ready") return poison();
          busy = true;
          check();
          await recheck();
          phase = "Guarded";
        } catch {
          return poison();
        } finally {
          busy = false;
        }
      },
      () => {
        try {
          if (busy || phase !== "Guarded") return poison();
          check();
          phase = "Final";
        } catch {
          return poison();
        }
      },
    );
  };
  const inserted = async (sql: string, values: readonly unknown[], expected: string) => {
    const page = rows(await query(sql, values), 1);
    if (page.length !== 1 || readClosedRecord(page[0], ["reference"]).reference !== expected)
      return poison();
  };
  const prepare = async (
    command: PrepareApprovedWorkforcePolicy,
    held: Awaited<ReturnType<typeof qualify>>,
  ) => {
    const before = await read(held.brand, held.member),
      expected = command.expectedPolicy;
    if (
      (before.root === null) !== (expected === null) ||
      (before.root !== null &&
        (before.root.snapshotReference !== expected?.snapshotReference ||
          before.root.version !== expected?.version)) ||
      before.assignments.length !== 0
    )
      return poison();
    if (before.root === null) {
      if (
        rows(
          await query(
            "SELECT role_id::text AS reference FROM bop_permission.role WHERE brand_id=$1 LIMIT 1",
            [command.policy.brandReference],
          ),
          1,
        ).length ||
        rows(
          await query(
            "SELECT assignment_id::text AS reference FROM bop_permission.role_assignment WHERE brand_id=$1 LIMIT 1",
            [command.policy.brandReference],
          ),
          1,
        ).length ||
        rows(
          await query(
            "SELECT grant_id::text AS reference FROM bop_permission.permission_grant WHERE brand_id=$1 LIMIT 1",
            [command.policy.brandReference],
          ),
          1,
        ).length
      )
        return poison();
    }
    for (const role of before.roles) {
      const approved =
        command.policy.roles.find((r) => r.roleReference === role.roleReference) ?? poison();
      roleContent(before, approved);
    }
    const next =
      before.root === null
        ? createBrandAdministrationPolicyState(
            {
              brandReference: command.policy.brandReference,
              snapshotReference: command.policySnapshotReference,
              version: 1,
              updatedAt: origin,
            },
            held.brand,
          )
        : advancePolicyState(
            before.root,
            before.root.version,
            command.policySnapshotReference,
            origin,
          );
    if (before.root === null)
      await inserted(
        "INSERT INTO bop_permission.policy_state(brand_id,snapshot_id,version,updated_at) VALUES($1,$2,1,$3) RETURNING snapshot_id::text AS reference",
        [next.brandReference, next.snapshotReference, next.updatedAt],
        String(next.snapshotReference),
      );
    else
      await inserted(
        "UPDATE bop_permission.policy_state SET snapshot_id=$2,version=$3,updated_at=$4 WHERE brand_id=$1 AND snapshot_id=$5 AND version=$6 RETURNING snapshot_id::text AS reference",
        [
          next.brandReference,
          next.snapshotReference,
          next.version,
          next.updatedAt,
          before.root.snapshotReference,
          before.root.version,
        ],
        String(next.snapshotReference),
      );
    const byDefinition = new Map(before.definitions.map((d) => [String(d.permissionReference), d]));
    for (const spec of command.policy.roles) {
      const existing = before.roles.find((r) => r.roleReference === spec.roleReference);
      const role =
        existing ??
        createBrandAdministrationPermissionRole(
          {
            roleReference: spec.roleReference,
            brandReference: command.policy.brandReference,
            storeReference: null,
            code: spec.roleCode,
            lifecycle: "Active",
            effectiveFrom: spec.effectiveFrom,
            effectiveUntil: spec.effectiveUntil,
            version: 1,
            createdAt: origin,
            updatedAt: origin,
          },
          held.brand,
        );
      if (!existing) {
        await inserted(
          "INSERT INTO bop_permission.role(role_id,brand_id,store_id,role_code,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,NULL,$3,'Active',$4,$5,1,$6,$6) RETURNING role_id::text AS reference",
          [
            role.roleReference,
            role.brandReference,
            role.code,
            role.effectiveFrom,
            role.effectiveUntil,
            role.createdAt,
          ],
          String(role.roleReference),
        );
        for (const g of spec.grants) {
          const grant = createPermissionGrant(
            {
              ...g,
              roleReference: role.roleReference,
              brandReference: role.brandReference,
              storeReference: null,
              lifecycle: "Active",
              version: 1,
              createdAt: origin,
              updatedAt: origin,
            },
            role,
            byDefinition.get(g.permissionReference) ?? poison(),
          );
          await inserted(
            "INSERT INTO bop_permission.permission_grant(grant_id,role_id,permission_id,brand_id,store_id,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$7,$7) RETURNING grant_id::text AS reference",
            [
              grant.grantReference,
              grant.roleReference,
              grant.permissionReference,
              grant.brandReference,
              grant.effectiveFrom,
              grant.effectiveUntil,
              grant.createdAt,
            ],
            String(grant.grantReference),
          );
        }
      }
      const assignment = createRoleAssignment(
        {
          ...spec.assignment,
          roleReference: role.roleReference,
          membershipReference: held.member.membershipReference,
          storeAssignmentReference: null,
          actorReference: held.member.actorReference,
          brandReference: role.brandReference,
          storeReference: null,
          lifecycle: "Active",
          version: 1,
          createdAt: origin,
          updatedAt: origin,
        },
        role,
        held.member,
        null,
      );
      await inserted(
        "INSERT INTO bop_permission.role_assignment(assignment_id,role_id,membership_id,store_assignment_id,actor_id,brand_id,store_id,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,$7,1,$8,$8) RETURNING assignment_id::text AS reference",
        [
          assignment.assignmentReference,
          assignment.roleReference,
          assignment.membershipReference,
          assignment.actorReference,
          assignment.brandReference,
          assignment.effectiveFrom,
          assignment.effectiveUntil,
          assignment.createdAt,
        ],
        String(assignment.assignmentReference),
      );
    }
    await append(tx, {
      auditId: auditReference,
      brandId: command.policy.brandReference,
      actor: { type: "User", reference: command.approval.operatorReference },
      actionCode: "APPROVED_WORKFORCE_POLICY_PREPARED",
      targetType: "PermissionPolicy",
      targetId: next.snapshotReference,
      afterSummary: {
        purposeCode: "WORKFORCE_ONBOARDING",
        operationReference: command.operationReference,
        requestDigest: requestDigest ?? poison(),
        approvedPolicyDigest: command.approval.approvedPolicyDigest,
        planDigest: command.approval.planDigest,
        approvalEvidenceReference: command.approval.approvalEvidenceReference,
        approvedByReference: command.approval.approvedByReference,
        policyVersion: next.version,
      },
      reasonCode: "APPROVED_WORKFORCE_ONBOARDING",
      correlationId: command.operationReference,
      occurredAt: origin,
      sourceChannel: "APPLICATION",
      dataClassification: "Restricted",
      retentionPolicyCode: "PERMISSION_POLICY_AUDIT",
      retentionPolicyVersion: 1,
    });
    check();
    const refreshed = await qualify();
    const facts = await read(refreshed.brand, refreshed.member);
    if (fingerprint(facts.root) !== fingerprint(next)) return poison();
    confirm(facts);
  };
  const work = async (value: unknown, preparing: boolean) => {
    if (busy) return poison();
    busy = true;
    try {
      await registerGuard();
      check();
      const parsed = preparing
          ? parsePrepareApprovedWorkforcePolicy(value)
          : parseHoldApprovedWorkforcePolicy(value),
        digest = hashApprovedWorkforcePolicyRequest(parsed);
      if (phase !== "Open") {
        if (
          preparing ||
          current().profile !== "HoldApprovedWorkforcePolicyV1" ||
          digest !== requestDigest ||
          (phase !== "Ready" && phase !== "Guarded")
        )
          return poison();
        await recheck();
        return packet();
      }
      request = parsed;
      requestDigest = digest;
      // Two separate statements detect an accidental autocommit port before DML.
      await sameTx();
      await sameTx();
      await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `Brand:${parsed.policy.brandReference}`,
      ]);
      const held = await qualify();
      if (preparing)
        await query(
          "LOCK TABLE bop_permission.policy_state,bop_permission.permission_definition,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant,bop_permission.permission_override IN SHARE ROW EXCLUSIVE MODE",
          [],
        );
      else
        await query(
          "LOCK TABLE bop_permission.policy_state,bop_permission.permission_definition,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant,bop_permission.permission_override IN SHARE MODE",
          [],
        );
      await sameTx();
      if (parsed.profile === "PrepareApprovedWorkforcePolicyV1") await prepare(parsed, held);
      else confirm(await read(held.brand, held.member));
      phase = "Ready";
      return packet();
    } catch {
      return poison();
    } finally {
      busy = false;
    }
  };
  return Object.freeze({
    async prepareApproved(value: unknown) {
      const result = await work(value, true),
        command = current();
      if (command.profile !== "PrepareApprovedWorkforcePolicyV1") return poison();
      return Object.freeze({
        profile: "ApprovedWorkforcePolicyPreparationV1" as const,
        ...result,
        operationReference: command.operationReference,
        requestDigest: requestDigest ?? poison(),
        auditReference,
        occurredAt: origin,
      });
    },
    holdApproved: (value: unknown) => work(value, false),
    assertFinalized() {
      if (phase !== "Final" || busy) return poison();
    },
  });
}
