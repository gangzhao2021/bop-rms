import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import { createIdentityActor } from "../../bop/identity/src/index.ts";
import {
  createBrandAdministrationContext,
  createPostgresBrandAdministrationOrganizationSource,
} from "../../bop/tenant/src/index.ts";
import {
  createBrandAdministrationPolicyState,
  createBrandAdministrationPermissionRole,
  createPermissionDefinition,
  createPermissionGrant,
  createPostgresApprovedWorkforcePolicyStore,
  createPostgresCurrentBrandAdministrationPermissionPolicySource,
  hashApprovedWorkforcePolicyPlan,
  parseApprovedWorkforcePolicyPlan,
  parsePrepareApprovedWorkforcePolicy,
} from "../../bop/permission/src/index.ts";
import { verifyApprovedWorkforceMembership } from "./approved-workforce-membership.mjs";

const id = (n) => `0190ed61-0061-7000-8000-${n.toString(16).padStart(12, "0")}`;
const atOffset = (at, milliseconds) => new Date(Date.parse(at) + milliseconds).toISOString();
const refused = (error) => error?.code === "APPROVED_WORKFORCE_POLICY_UNAVAILABLE";
function approvedPlan(tuple) {
  const longStart = atOffset(tuple.effectiveFrom, -86_400_000),
    longEnd = atOffset(tuple.effectiveUntil, 86_400_000);
  return parseApprovedWorkforcePolicyPlan({
    profile: "ApprovedWorkforcePolicyV1",
    ...tuple,
    roles: [
      {
        roleReference: id(1),
        roleCode: "approved_existing_administrator",
        effectiveFrom: longStart,
        effectiveUntil: longEnd,
        assignment: {
          assignmentReference: id(2),
          effectiveFrom: tuple.effectiveFrom,
          effectiveUntil: tuple.effectiveUntil,
        },
        grants: [
          {
            grantReference: id(3),
            permissionReference: id(4),
            action: "organization.manage",
            effectiveFrom: atOffset(tuple.effectiveFrom, -3600_000),
            effectiveUntil: atOffset(tuple.effectiveUntil, 3600_000),
          },
        ],
      },
      {
        roleReference: id(5),
        roleCode: "approved_new_reviewer",
        effectiveFrom: tuple.effectiveFrom,
        effectiveUntil: longEnd,
        assignment: {
          assignmentReference: id(6),
          effectiveFrom: tuple.effectiveFrom,
          effectiveUntil: tuple.effectiveUntil,
        },
        grants: [
          {
            grantReference: id(7),
            permissionReference: id(8),
            action: "publishing.review.approve",
            effectiveFrom: tuple.effectiveFrom,
            effectiveUntil: atOffset(tuple.effectiveUntil, 7200_000),
          },
        ],
      },
    ],
  });
}
/** Actual Pending-v1 is committed by the existing Membership production fixture,
 * with this exact policy digest bound before its creation. Actual Permission
 * prepare/current and public Audit run under a separate minimum nonowner role.
 * Existing role/policy/definition rows are explicit synthetic baseline fixtures;
 * they are not represented as production approval or role-administration events.
 * Independent approval, relationship and current signed-MFA facts remain
 * controlled ports. This is not the full Provider/invitation callback. */
export async function verifyApprovedWorkforcePolicy(context) {
  let policyFailure;
  try {
    await verifyApprovedWorkforceMembership(context, {
      approvedPolicyDigest(tuple) {
        return hashApprovedWorkforcePolicyPlan(approvedPlan(tuple));
      },
      async onPending(fixture) {
        try {
          await verifyPolicyForActualPending(fixture);
        } catch (error) {
          policyFailure = error;
          throw error;
        }
      },
    });
  } catch (error) {
    throw policyFailure ?? error;
  }
}
async function verifyPolicyForActualPending({
  admin,
  approval,
  originalPending,
  origin,
  end,
  query,
  context,
}) {
  const plan = approvedPlan({
    brandReference: approval.brandReference,
    actorReference: approval.actorReference,
    membershipReference: approval.membershipReference,
    effectiveFrom: approval.effectiveFrom,
    effectiveUntil: approval.effectiveUntil,
  });
  if (
    hashApprovedWorkforcePolicyPlan(plan) !== approval.approvedPolicyDigest ||
    originalPending.lifecycle !== "PendingActivation" ||
    originalPending.version !== 1
  )
    throw new Error("APPROVED_POLICY_NATIVE_INPUT_INVALID");
  const role = `pending_policy_${context.runId}`,
    password = randomBytes(32).toString("hex"),
    deadline = atOffset(origin, 5000);
  let client,
    roleCreated = false,
    stage = "Setup",
    sqlState = "none",
    primaryFailure,
    cleanupFailed = false;
  const q = async (connection, sql, values = []) => {
    try {
      return await query(connection, sql, values);
    } catch (error) {
      if (/^[0-9A-Z]{5}$/u.test(error.code ?? "")) sqlState = error.code;
      throw error;
    }
  };
  const mark = (value) => {
    stage = value;
    sqlState = "none";
  };
  const snapshot = async () => {
    const result = {};
    for (const [name, sql] of [
      [
        "state",
        "SELECT brand_id::text,snapshot_id::text,version::text,updated_at::text FROM bop_permission.policy_state WHERE brand_id=$1 ORDER BY brand_id",
      ],
      [
        "roles",
        "SELECT role_id::text,brand_id::text,store_id::text,role_code,lifecycle,effective_from::text,effective_until::text,version::text,created_at::text,updated_at::text FROM bop_permission.role WHERE brand_id=$1 ORDER BY role_id",
      ],
      [
        "assignments",
        "SELECT assignment_id::text,role_id::text,membership_id::text,actor_id::text,store_id::text,lifecycle,effective_from::text,effective_until::text,version::text FROM bop_permission.role_assignment WHERE brand_id=$1 ORDER BY assignment_id",
      ],
      [
        "grants",
        "SELECT grant_id::text,role_id::text,permission_id::text,store_id::text,lifecycle,effective_from::text,effective_until::text,version::text FROM bop_permission.permission_grant WHERE brand_id=$1 ORDER BY grant_id",
      ],
      [
        "overrides",
        "SELECT override_id::text,actor_id::text,effect,lifecycle,version::text FROM bop_permission.permission_override WHERE brand_id=$1 ORDER BY override_id",
      ],
      [
        "audits",
        "SELECT audit_id::text,actor_reference::text,action_code,target_id::text,chain_sequence::text,encode(record_hash,'hex') record_hash,encode(previous_record_hash,'hex') previous_record_hash FROM platform_audit.audit_record WHERE brand_id=$1 ORDER BY chain_sequence",
      ],
      [
        "heads",
        "SELECT next_sequence::text,encode(last_record_hash,'hex') last_hash FROM platform_audit.audit_chain_head WHERE brand_id=$1",
      ],
      [
        "members",
        "SELECT membership_id::text,actor_id::text,lifecycle,version FROM bop_membership.membership WHERE brand_id=$1 ORDER BY membership_id",
      ],
    ])
      result[name] = (await q(admin, sql, [approval.brandReference])).rows;
    result.definitions = (
      await q(
        admin,
        "SELECT permission_id::text,action_code,lifecycle,version::text,created_at::text,updated_at::text FROM bop_permission.permission_definition WHERE permission_id=ANY($1::uuid[]) ORDER BY permission_id",
        [[id(4), id(8)]],
      )
    ).rows;
    return result;
  };
  const heldActor = (preparing) =>
    createIdentityActor({
      actorType: "User",
      actorReference: preparing ? approval.operatorReference : approval.actorReference,
      accountKind: preparing ? "Platform" : "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "RecentMfa",
      authenticatedAt: origin,
      recentMfaAt: origin,
    });
  const make = (tx, preparing, controls, register) =>
    createPostgresApprovedWorkforcePolicyStore({
      transaction: tx,
      clock: { now: () => controls.now ?? origin },
      originalObservedAt: origin,
      originalValidUntil: deadline,
      auditReference: id(30),
      authority: {
        async hold(actual, input) {
          assert.equal(actual, tx);
          assert.equal(input.purposeCode, "WORKFORCE_ONBOARDING");
          controls.authorityCalls = (controls.authorityCalls ?? 0) + 1;
          assert.deepEqual(input.request.approval, approval);
          assert.deepEqual(input.request.policy, plan);
          if (controls.allowed === false) throw new Error("CONTROLLED_APPROVAL_WITHDRAWN");
          const brand = await createPostgresBrandAdministrationOrganizationSource(tx, {
            brandReference: approval.brandReference,
            observedAt: input.observedAt,
          }).getBrand(approval.brandReference);
          assert(brand, "ACTUAL_BRAND_REQUIRED");
          return {
            requestDigest: input.requestDigest,
            approval,
            brand,
            pendingMembership: originalPending,
            operator: heldActor(preparing),
            relationship: {
              profile: "CurrentWorkforceRelationshipQualificationV1",
              environmentReference: approval.environmentReference,
              actorReference: approval.actorReference,
              brandReference: approval.brandReference,
              workforceRelationshipReference: approval.workforceRelationshipReference,
              relationshipEvidenceReference: approval.relationshipEvidenceReference,
              issuerReference: id(31),
              revision: approval.relationshipRevision,
              relationshipEffectiveFrom: origin,
              relationshipEffectiveUntil: end,
              verifiedAt: origin,
              observedAt: input.observedAt,
              validUntil: input.validUntil,
            },
            observedAt: input.observedAt,
            validUntil: input.validUntil,
          };
        },
      },
      async appendAudit(actual, audit) {
        assert.equal(actual, tx);
        assert.equal(audit.actor.reference, approval.operatorReference);
        await appendAuditRecordInTransaction(actual, audit);
        controls.auditWritten = true;
        if (controls.auditFault) throw new Error("CONTROLLED_FAILURE_AFTER_ACTUAL_AUDIT_APPEND");
      },
      registerBeforeCommit: register,
    });
  const transaction = async (preparing, work, controls = {}) => {
    const guards = [],
      tx = Object.freeze({
        query: async (sql, values) => {
          const result = await q(client, sql, values);
          if (sql.startsWith("INSERT INTO bop_permission.role_assignment"))
            controls.assignmentWritten = true;
          if (sql.startsWith("UPDATE bop_permission.policy_state")) controls.headWritten = true;
          return result;
        },
      });
    await q(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await q(client, "SET LOCAL statement_timeout='5s'");
      await q(client, "SET LOCAL lock_timeout='2s'");
      const source = make(tx, preparing, controls, async (actual, guard, final) => {
        assert.equal(actual, tx);
        guards.push({ guard, final });
      });
      const result = await work(source, tx);
      assert.equal(guards.length, 1, "ACTUAL_HOST_REGISTRATION_REQUIRED");
      await controls.beforeCommit?.();
      for (const g of guards) await g.guard();
      controls.beforeFinal?.();
      for (const g of guards) g.final();
      await q(client, "COMMIT");
      source.assertFinalized();
      return result;
    } catch (error) {
      await q(client, "ROLLBACK");
      throw error;
    }
  };
  const prepare = parsePrepareApprovedWorkforcePolicy({
    profile: "PrepareApprovedWorkforcePolicyV1",
    operationReference: approval.operationReference,
    approval,
    policy: plan,
    expectedPolicy: { snapshotReference: id(20), version: 4 },
    policySnapshotReference: id(21),
  });
  const hold = { profile: "HoldApprovedWorkforcePolicyV1", approval, policy: plan };
  try {
    assert.match(role, /^[a-z][a-z0-9_]{0,62}$/u);
    await q(
      admin,
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
    );
    roleCreated = true;
    await q(
      admin,
      `GRANT USAGE ON SCHEMA bop_permission,bop_tenant,platform_audit,platform_helpers TO ${role}`,
    );
    await q(
      admin,
      `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    // PG18 MAINTAIN is required for the owning predicate/table fence; it does
    // not add DML. No role/grant/assignment UPDATE or definition write is given.
    await q(
      admin,
      `GRANT SELECT,MAINTAIN ON bop_permission.policy_state,bop_permission.permission_definition,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant,bop_permission.permission_override TO ${role}`,
    );
    await q(
      admin,
      `GRANT INSERT ON bop_permission.policy_state,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant TO ${role}`,
    );
    await q(
      admin,
      `GRANT UPDATE(snapshot_id,version,updated_at) ON bop_permission.policy_state TO ${role}`,
    );
    await q(admin, `GRANT SELECT,UPDATE(version) ON bop_tenant.brand TO ${role}`);
    await q(admin, `GRANT SELECT,INSERT ON platform_audit.audit_record TO ${role}`);
    await q(admin, `GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
    client = new pg.Client({ ...context.clientConfig, user: role, password });
    await client.connect();
    assert.equal((await q(client, "SELECT current_user AS principal")).rows[0].principal, role);
    const acl = (
      await q(
        admin,
        `SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,
      has_table_privilege($1,'bop_permission.policy_state','UPDATE') full_policy_update,
      has_table_privilege($1,'bop_permission.role','UPDATE') role_update,
      has_table_privilege($1,'bop_permission.role_assignment','UPDATE') assignment_update,
      has_table_privilege($1,'bop_permission.permission_grant','UPDATE') grant_update,
      has_table_privilege($1,'bop_permission.permission_definition','INSERT') definition_insert,
      has_table_privilege($1,'bop_permission.permission_override','INSERT') override_insert,
      has_table_privilege($1,'bop_permission.role','DELETE') role_delete,
      has_table_privilege($1,'bop_permission.role','TRUNCATE') role_truncate,
      has_table_privilege($1,'bop_membership.membership','SELECT') member_read,
      has_table_privilege($1,'bop_membership.membership','UPDATE') member_write,
      has_table_privilege($1,'bop_identity.authentication_session','SELECT') session_read,
      has_table_privilege($1,'platform_audit.audit_record','UPDATE') audit_update,
      (SELECT pg_get_userbyid(relowner)=$1 FROM pg_class WHERE oid='bop_permission.policy_state'::regclass) owns_policy
      FROM pg_roles WHERE rolname=$1`,
        [role],
      )
    ).rows[0];
    for (const flag of Object.values(acl))
      assert.equal(flag, false, "MINIMUM_POLICY_ROLE_REQUIRED");

    mark("ExistingPolicyFixtureAndRealPending");
    let brand;
    await q(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      brand = await createPostgresBrandAdministrationOrganizationSource(
        { query: (sql, values) => q(client, sql, values) },
        { brandReference: approval.brandReference, observedAt: origin },
      ).getBrand(approval.brandReference);
    } finally {
      await q(client, "ROLLBACK");
    }
    assert(brand, "ACTUAL_FIXTURE_BRAND_REQUIRED");
    const existingState = createBrandAdministrationPolicyState(
      {
        brandReference: approval.brandReference,
        snapshotReference: id(20),
        version: 4,
        updatedAt: origin,
      },
      brand,
    );
    const definitions = [
      createPermissionDefinition({
        permissionReference: id(4),
        action: "organization.manage",
        lifecycle: "Active",
        version: 1,
        createdAt: origin,
        updatedAt: origin,
      }),
      createPermissionDefinition({
        permissionReference: id(8),
        action: "publishing.review.approve",
        lifecycle: "Active",
        version: 1,
        createdAt: origin,
        updatedAt: origin,
      }),
    ];
    for (const d of definitions)
      await q(
        admin,
        "INSERT INTO bop_permission.permission_definition(permission_id,action_code,lifecycle,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6)",
        [d.permissionReference, d.action, d.lifecycle, d.version, d.createdAt, d.updatedAt],
      );
    await q(
      admin,
      "INSERT INTO bop_permission.policy_state(brand_id,snapshot_id,version,updated_at) VALUES($1,$2,$3,$4)",
      [
        existingState.brandReference,
        existingState.snapshotReference,
        existingState.version,
        existingState.updatedAt,
      ],
    );
    const existingSpec = plan.roles.find((r) => r.roleReference === id(1));
    assert(existingSpec);
    const existingRole = createBrandAdministrationPermissionRole(
      {
        roleReference: existingSpec.roleReference,
        brandReference: approval.brandReference,
        storeReference: null,
        code: existingSpec.roleCode,
        lifecycle: "Active",
        effectiveFrom: existingSpec.effectiveFrom,
        effectiveUntil: existingSpec.effectiveUntil,
        version: 3,
        createdAt: origin,
        updatedAt: origin,
      },
      brand,
    );
    const unrelatedRole = createBrandAdministrationPermissionRole(
      { ...existingRole, roleReference: id(22), code: "unrelated_preserved_role", version: 2 },
      brand,
    );
    const grantSpec = existingSpec.grants[0];
    assert(grantSpec);
    const existingGrant = createPermissionGrant(
      {
        ...grantSpec,
        roleReference: existingRole.roleReference,
        brandReference: approval.brandReference,
        storeReference: null,
        lifecycle: "Active",
        version: 2,
        createdAt: origin,
        updatedAt: origin,
      },
      existingRole,
      definitions[0],
    );
    const unrelatedGrant = createPermissionGrant(
      { ...existingGrant, grantReference: id(23), roleReference: unrelatedRole.roleReference },
      unrelatedRole,
      definitions[0],
    );
    for (const r of [existingRole, unrelatedRole])
      await q(
        admin,
        "INSERT INTO bop_permission.role(role_id,brand_id,store_id,role_code,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9)",
        [
          r.roleReference,
          r.brandReference,
          r.code,
          r.lifecycle,
          r.effectiveFrom,
          r.effectiveUntil,
          r.version,
          r.createdAt,
          r.updatedAt,
        ],
      );
    for (const g of [existingGrant, unrelatedGrant])
      await q(
        admin,
        "INSERT INTO bop_permission.permission_grant(grant_id,role_id,permission_id,brand_id,store_id,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10)",
        [
          g.grantReference,
          g.roleReference,
          g.permissionReference,
          g.brandReference,
          g.lifecycle,
          g.effectiveFrom,
          g.effectiveUntil,
          g.version,
          g.createdAt,
          g.updatedAt,
        ],
      );
    assert.notEqual(existingRole.effectiveFrom, originalPending.effectiveFrom);
    assert.notEqual(existingRole.effectiveUntil, originalPending.effectiveUntil);
    const baseline = await snapshot();
    assert.equal(baseline.members.length, 1);
    assert.equal(baseline.members[0].lifecycle, "PendingActivation");
    assert.equal(baseline.assignments.length, 0);
    assert.equal(baseline.audits.length, 1);

    mark("AutocommitRefusedBeforeAnyMutation");
    const auto = {},
      raw = Object.freeze({ query: (sql, values) => q(client, sql, values) });
    await assert.rejects(
      make(raw, true, auto, async () => undefined).prepareApproved(prepare),
      refused,
    );
    assert.equal(auto.authorityCalls ?? 0, 0);
    assert.equal(auto.auditWritten ?? false, false);
    assert.deepEqual(await snapshot(), baseline);

    mark("StalePolicyCasRefusesWithoutWrites");
    await assert.rejects(
      transaction(true, (source) =>
        source.prepareApproved({
          ...prepare,
          expectedPolicy: { ...prepare.expectedPolicy, version: 3 },
        }),
      ),
      refused,
    );
    assert.deepEqual(await snapshot(), baseline);

    mark("CaughtFailurePoisonsWholePreparation");
    const caught = {};
    await assert.rejects(
      transaction(
        true,
        async (source) => {
          await source.prepareApproved(prepare);
          await assert.rejects(source.prepareApproved(prepare), refused);
          caught.observed = true;
        },
        caught,
      ),
      refused,
    );
    assert(caught.observed && caught.assignmentWritten && caught.auditWritten);
    assert.deepEqual(await snapshot(), baseline);

    mark("LateAuthorityRollsBackActualCasAssignmentsAndAudit");
    const late = { allowed: true };
    late.beforeCommit = async () => {
      assert(late.headWritten && late.assignmentWritten && late.auditWritten);
      late.allowed = false;
    };
    await assert.rejects(
      transaction(true, (source) => source.prepareApproved(prepare), late),
      refused,
    );
    assert(late.authorityCalls >= 3);
    assert.deepEqual(await snapshot(), baseline);

    mark("ActualAuditAppendFailureRollsBackPolicy");
    const auditFault = { auditFault: true };
    await assert.rejects(
      transaction(true, (source) => source.prepareApproved(prepare), auditFault),
      refused,
    );
    assert(auditFault.headWritten && auditFault.assignmentWritten && auditFault.auditWritten);
    assert.deepEqual(await snapshot(), baseline);

    mark("FinalDeadlineRefusesAfterAsyncGuards");
    const expired = {};
    expired.beforeFinal = () => {
      expired.now = deadline;
    };
    await assert.rejects(
      transaction(true, (source) => source.prepareApproved(prepare), expired),
      refused,
    );
    assert(expired.auditWritten);
    assert.deepEqual(await snapshot(), baseline);

    mark("PrepareApprovedExistingPolicyWithActualAudit");
    const prepared = await transaction(true, (source) => source.prepareApproved(prepare));
    assert.equal(prepared.contentDigest, approval.approvedPolicyDigest);
    assert.equal(prepared.policyVersion, 5);
    assert.equal(prepared.policySnapshotReference, id(21));
    const committed = await snapshot();
    assert.equal(committed.state[0].version, "5");
    assert.equal(committed.roles.length, 3);
    assert.equal(committed.grants.length, 3);
    assert.equal(committed.assignments.length, 2);
    assert.deepEqual(committed.members, baseline.members);
    assert.deepEqual(committed.overrides, baseline.overrides);
    assert.deepEqual(committed.definitions, baseline.definitions);
    for (const old of baseline.roles)
      assert.deepEqual(
        committed.roles.find((r) => r.role_id === old.role_id),
        old,
      );
    for (const old of baseline.grants)
      assert.deepEqual(
        committed.grants.find((g) => g.grant_id === old.grant_id),
        old,
      );
    assert.equal(committed.audits.length, baseline.audits.length + 1);
    const audit = committed.audits.at(-1);
    assert.equal(audit.action_code, "APPROVED_WORKFORCE_POLICY_PREPARED");
    assert.equal(audit.actor_reference, approval.operatorReference);
    assert.equal(audit.target_id, id(21));
    assert.equal(audit.previous_record_hash, baseline.audits.at(-1).record_hash);
    assert.equal(committed.heads[0].last_hash, audit.record_hash);
    assert.equal(committed.heads[0].next_sequence, "3");

    mark("HoldActualRowsAndDigestRepeatedly");
    const proof = await transaction(false, async (source) => {
      const first = await source.holdApproved(hold);
      assert.deepEqual(await source.holdApproved(hold), first);
      return first;
    });
    assert.deepEqual(proof, {
      approvedPolicyDigest: approval.approvedPolicyDigest,
      contentDigest: hashApprovedWorkforcePolicyPlan(plan),
      policySnapshotReference: id(21),
      policyVersion: 5,
      observedAt: origin,
      validUntil: deadline,
    });
    assert.deepEqual(await snapshot(), committed);

    mark("PreparedRolesDoNotAuthorizePendingMember");
    await q(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      let readActualPolicy = false;
      const tx = Object.freeze({
        query: async (sql, values) => {
          const result = await q(client, sql, values);
          if (sql.includes("PermissionCurrentPolicyPacketV1")) readActualPolicy = true;
          return result;
        },
      });
      const currentBrand = await createPostgresBrandAdministrationOrganizationSource(tx, {
        brandReference: approval.brandReference,
        observedAt: origin,
      }).getBrand(approval.brandReference);
      assert(currentBrand);
      await assert.rejects(
        createPostgresCurrentBrandAdministrationPermissionPolicySource(tx).authorize({
          administrationContext: createBrandAdministrationContext(
            heldActor(false),
            currentBrand,
            origin,
          ),
          membership: originalPending,
          storeAssignment: null,
          action: "organization.manage",
        }),
        (error) => error?.code === "PERMISSION_POLICY_MATERIALIZATION_INVALID",
      );
      assert(readActualPolicy, "ACTUAL_POLICY_MATERIALIZATION_REQUIRED");
    } finally {
      await q(client, "ROLLBACK");
    }
    assert.deepEqual(await snapshot(), committed);

    mark("OriginalPrepareCannotBeReplayedWithoutOuterArbitration");
    await assert.rejects(
      transaction(true, (source) => source.prepareApproved(prepare)),
      refused,
    );
    assert.deepEqual(await snapshot(), committed);

    mark("WrongBrandRlsAndMinimalMutationPrivileges");
    await q(client, "BEGIN");
    try {
      await q(
        client,
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
        [id(99)],
      );
      assert.equal(
        (
          await q(client, "SELECT role_id FROM bop_permission.role WHERE brand_id=$1", [
            approval.brandReference,
          ])
        ).rowCount,
        0,
      );
    } finally {
      await q(client, "ROLLBACK");
    }
    await assert.rejects(
      q(client, "UPDATE bop_permission.role SET version=version+1 WHERE role_id=$1", [id(1)]),
      (error) => error?.code === "42501",
    );
    await assert.rejects(
      q(client, "DELETE FROM bop_permission.role_assignment WHERE membership_id=$1", [
        approval.membershipReference,
      ]),
      (error) => error?.code === "42501",
    );
    assert.deepEqual(await snapshot(), committed);

    mark("ActualStillEffectiveGrantDriftRefusesApprovalDigest");
    // Deliberate owning-table corruption fixture after the successful proof:
    // remains Active/effective, so exact approved period/content must reject it.
    await q(
      admin,
      "UPDATE bop_permission.permission_grant SET effective_until=$2,version=version+1 WHERE grant_id=$1",
      [id(3), end],
    );
    const drifted = await snapshot();
    await assert.rejects(
      transaction(false, (source) => source.holdApproved(hold)),
      refused,
    );
    assert.deepEqual(await snapshot(), drifted);
    assert.deepEqual(drifted.audits, committed.audits);
  } catch {
    primaryFailure = new Error(
      `Approved Workforce policy native failed at ${stage}; SQLSTATE=${sqlState}`,
    );
  } finally {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        cleanupFailed = true;
      }
      try {
        await client.end();
      } catch {
        cleanupFailed = true;
      }
    }
    if (roleCreated) {
      try {
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      } catch {
        cleanupFailed = true;
      }
    }
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailed) throw new Error("APPROVED_WORKFORCE_POLICY_NATIVE_CLEANUP_UNAVAILABLE");
}
