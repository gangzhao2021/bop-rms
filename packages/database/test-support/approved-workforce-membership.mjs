import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers";
import pg from "pg";
import {
  buildWorkforceAccountBinding,
  createIdentityActor,
  parseCurrentWorkforceAccount,
  parseSelectorHash,
  parseWorkforceAccountBindingAcceptanceOriginal,
  workforceAccountBindingCodec,
  workforceAccountBindingIntent,
  workforceAccountSubjectContext,
} from "../../bop/identity/src/index.ts";
import {
  createBrand,
  createBrandAdministrationContext,
  createPostgresBrandInitialCreationStore,
  createPostgresBrandAdministrationOrganizationSource,
} from "../../bop/tenant/src/index.ts";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import {
  createPostgresApprovedWorkforceMembershipStore,
  createPostgresBrandAdministrationMembershipActivationSource,
  parseApprovedWorkforceMembership,
} from "../../bop/membership/src/index.ts";

const id = (n) => `0190ed60-0060-7000-8000-${n.toString(16).padStart(12, "0")}`;
const denied = (error) => error?.code === "MEMBERSHIP_INPUT_INVALID";
/** Actual existing 003 rows, production Membership writer and public Tenant/Audit
 * owners under an independent minimum nonowner role. The static independent
 * approval, relationship, current policy, signed-TOTP Actor and first acceptance
 * packet are controlled source ports, NOT actual Provider/callback/journal facts.
 * No successful Membership is seeded and no permission or Session is granted. */
export async function verifyApprovedWorkforceMembership(context, extension) {
  const admin = new pg.Client(context.clientConfig),
    role = `pending_member_${context.runId}`,
    password = randomBytes(32).toString("hex");
  // Controlled past time keeps the real public Audit writer's database-recorded
  // time after every occurredAt; elapsed test time never renews an owner lease.
  const origin = new Date(Date.now() - 60_000).toISOString(),
    activationAt = new Date(Date.parse(origin) + 1000).toISOString(),
    end = new Date(Date.parse(origin) + 86_400_000).toISOString();
  const approval = parseApprovedWorkforceMembership({
    profile: "ApprovedWorkforceMembershipV1",
    operationReference: id(1),
    planDigest: `sha256:${"a".repeat(64)}`,
    operatorReference: id(2),
    approvedByReference: id(3),
    approvalEvidenceReference: id(4),
    environmentReference: id(18),
    brandReference: id(5),
    membershipReference: id(6),
    actorReference: id(7),
    workforceRelationshipReference: id(8),
    relationshipEvidenceReference: id(9),
    relationshipRevision: 1,
    effectiveFrom: origin,
    effectiveUntil: end,
    approvedPolicyDigest: extension
      ? extension.approvedPolicyDigest({
          brandReference: id(5),
          actorReference: id(7),
          membershipReference: id(6),
          effectiveFrom: origin,
          effectiveUntil: end,
        })
      : `sha256:${"b".repeat(64)}`,
  });
  const createRequest = { profile: "CreateApprovedPendingMembershipV1", approval },
    activationRequest = {
      profile: "ActivateApprovedMembershipV1",
      operationReference: id(10),
      approval,
      expectedVersion: 1,
      pendingCreatedAt: origin,
      invitationReference: id(11),
    };
  const configuration = {
      environment: "internal-test",
      issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Test",
      clientIds: ["syntheticclient"],
    },
    bindingOriginal = parseWorkforceAccountBindingAcceptanceOriginal({
      profile: "WorkforceAccountBindingAcceptanceV1",
      operationReference: id(12),
      actorReference: id(7),
      invitationReference: id(11),
      originalMembershipReference: id(6),
      providerEvidenceReference: id(13),
      recordedByReference: id(7),
      approvedByReference: id(3),
      approvalEvidenceReference: id(4),
      reasonCode: "APPROVED_ONBOARDING",
      subjectHash: parseSelectorHash("a".repeat(64)),
    }),
    binding = buildWorkforceAccountBinding(
      {
        profile: "WorkforceAccountBindingV1",
        actorReference: id(7),
        configuration,
        subjectHash: bindingOriginal.subjectHash,
        encryptedSubject: {
          algorithm: "SYNTHETIC_AES_256_GCM",
          keyReference: "synthetic-key",
          ciphertext: "A".repeat(80),
          encryptionContext: workforceAccountSubjectContext(configuration, id(7)),
        },
        invitationReference: id(11),
        originalMembershipReference: id(6),
        providerEvidenceReference: id(13),
        operationReference: id(12),
        intentDigest: workforceAccountBindingIntent(
          configuration,
          bindingOriginal,
          workforceAccountBindingCodec,
        ),
        originalCommand: bindingOriginal,
        recordedByReference: id(7),
        approvedByReference: id(3),
        approvalEvidenceReference: id(4),
        reasonCode: bindingOriginal.reasonCode,
        auditReference: id(14),
        recordedAt: activationAt,
        classification: "RestrictedSecurity",
      },
      workforceAccountBindingCodec,
    );
  let client,
    originalPending,
    roleCreated = false,
    stage = "Setup",
    sqlState = "none",
    failed = false,
    primaryFailure,
    cleanupFailed = false,
    auditCalls = 0;
  const query = async (connection, sql, values = []) => {
    try {
      return await connection.query(sql, [...values]);
    } catch (error) {
      if (/^[0-9A-Z]{5}$/u.test(error.code ?? "")) sqlState = error.code;
      throw error;
    }
  };
  const mark = (value) => {
    stage = value;
    sqlState = "none";
  };
  const snapshot = async () => ({
    members: (
      await query(
        admin,
        `SELECT membership_id::text,actor_id::text,brand_id::text,workforce_relationship_reference::text,
      lifecycle,version,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') created_at,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') updated_at
      FROM bop_membership.membership WHERE brand_id=$1 ORDER BY membership_id`,
        [approval.brandReference],
      )
    ).rows,
    audits: (
      await query(
        admin,
        "SELECT audit_id::text,action_code,actor_reference::text,chain_sequence::text FROM platform_audit.audit_record WHERE brand_id=$1 ORDER BY chain_sequence",
        [approval.brandReference],
      )
    ).rows,
    heads: (
      await query(
        admin,
        "SELECT next_sequence::text FROM platform_audit.audit_chain_head WHERE brand_id=$1",
        [approval.brandReference],
      )
    ).rows,
  });
  const approvalOriginal = approval,
    originOriginal = origin,
    activationAtOriginal = activationAt,
    endOriginal = end,
    createRequestOriginal = createRequest,
    activationRequestOriginal = activationRequest,
    bindingOriginalSnapshot = binding,
    pendingOriginal = () => originalPending;
  const make = (tx, activate, controls, register, fixture) => {
    const {
      approval,
      origin,
      activationAt,
      end,
      createRequest,
      activationRequest,
      binding,
      originalPending,
    } = fixture ?? {
      approval: approvalOriginal,
      origin: originOriginal,
      activationAt: activationAtOriginal,
      end: endOriginal,
      createRequest: createRequestOriginal,
      activationRequest: activationRequestOriginal,
      binding: bindingOriginalSnapshot,
      originalPending: pendingOriginal(),
    };
    const start = activate ? activationAt : origin,
      until = new Date(Date.parse(start) + 5000).toISOString();
    const operator = createIdentityActor({
      actorType: "User",
      actorReference: activate ? approval.actorReference : approval.operatorReference,
      accountKind: activate ? "Workforce" : "Platform",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "RecentMfa",
      authenticatedAt: start,
      recentMfaAt: start,
    });
    return createPostgresApprovedWorkforceMembershipStore({
      transaction: tx,
      clock: { now: () => controls.now ?? start },
      originalObservedAt: start,
      originalValidUntil: until,
      auditReference: fixture
        ? activate
          ? fixture.activationAudit
          : fixture.pendingAudit
        : activate
          ? id(21)
          : id(20),
      authority: {
        async hold(actual, input) {
          assert.equal(actual, tx);
          controls.authorityCalls = (controls.authorityCalls ?? 0) + 1;
          assert.deepEqual(input.request, activate ? activationRequest : createRequest);
          if (controls.allowed === false) throw new Error("CONTROLLED_APPROVAL_WITHDRAWN");
          const brand = await createPostgresBrandAdministrationOrganizationSource(tx, {
            brandReference: approval.brandReference,
            observedAt: input.observedAt,
          }).getBrand(approval.brandReference);
          assert(brand, "ACTUAL_CURRENT_BRAND_REQUIRED");
          return {
            requestDigest: input.requestDigest,
            approval,
            brand,
            operator,
            relationship: {
              profile: "CurrentWorkforceRelationshipQualificationV1",
              environmentReference: approval.environmentReference,
              actorReference: approval.actorReference,
              brandReference: approval.brandReference,
              workforceRelationshipReference: approval.workforceRelationshipReference,
              relationshipEvidenceReference: approval.relationshipEvidenceReference,
              issuerReference: id(15),
              revision: approval.relationshipRevision,
              relationshipEffectiveFrom: origin,
              relationshipEffectiveUntil: end,
              verifiedAt: origin,
              observedAt: input.observedAt,
              validUntil: input.validUntil,
            },
            activation: activate
              ? {
                  pendingMembership: originalPending,
                  invitation: {
                    profile: "CurrentWorkforceInvitationEvidenceV1",
                    invitationReference: activationRequest.invitationReference,
                    actorReference: approval.actorReference,
                    originalMembershipReference: approval.membershipReference,
                    providerEvidenceReference: binding.providerEvidenceReference,
                    status: "Accepted",
                    version: 2,
                    createdAt: origin,
                    expiresAt: end,
                    consumedAt: activationAt,
                    observedAt: input.observedAt,
                    validUntil: input.validUntil,
                  },
                  account: parseCurrentWorkforceAccount({
                    profile: "CurrentWorkforceAccountV1",
                    actorType: "User",
                    actorReference: approval.actorReference,
                    accountKind: "Workforce",
                    status: "Active",
                    observedAt: input.observedAt,
                    validUntil: input.validUntil,
                  }),
                  binding,
                  policy: {
                    approvedPolicyDigest: approval.approvedPolicyDigest,
                    contentDigest: controls.policyChanged
                      ? `sha256:${"c".repeat(64)}`
                      : approval.approvedPolicyDigest,
                    policySnapshotReference: id(16),
                    policyVersion: 1,
                    observedAt: input.observedAt,
                    validUntil: input.validUntil,
                  },
                }
              : null,
            observedAt: input.observedAt,
            validUntil: input.validUntil,
          };
        },
      },
      async appendAudit(actual, audit) {
        assert.equal(actual, tx);
        auditCalls++;
        assert.equal(audit.actorReference, operator.actorReference);
        assert.equal(audit.targetActorReference, approval.actorReference);
        assert.equal(audit.originalOperationReference, approval.operationReference);
        await appendAuditRecordInTransaction(tx, {
          auditId: audit.auditReference,
          brandId: audit.brandReference,
          actor: { type: "User", reference: audit.actorReference },
          actionCode: audit.actionCode,
          targetType: "Membership",
          targetId: audit.membershipReference,
          afterSummary: {
            operationReference: audit.operationReference,
            originalOperationReference: audit.originalOperationReference,
            planDigest: audit.planDigest,
            requestDigest: audit.requestDigest,
            approvalEvidenceReference: audit.approvalEvidenceReference,
            membershipVersion: audit.afterVersion,
          },
          reasonCode: "APPROVED_WORKFORCE_ONBOARDING",
          correlationId: audit.operationReference,
          occurredAt: audit.occurredAt,
          sourceChannel: activate ? "MERCHANT_WEB" : "DEPLOYMENT",
          dataClassification: "Restricted",
          retentionPolicyCode: "MEMBERSHIP_AUDIT",
          retentionPolicyVersion: 1,
        });
        if (controls.auditFault) throw new Error("CONTROLLED_FAILURE_AFTER_ACTUAL_AUDIT_APPEND");
      },
      registerBeforeCommit: register,
    });
  };
  const transaction = async (activate, work, controls = {}, fixture, connection = client) => {
    const guards = [],
      tx = Object.freeze({
        query: async (sql, values) => {
          if (controls.observeSql) controls.observeSql(sql);
          const result = await query(connection, sql, values);
          if (
            sql.startsWith("INSERT INTO bop_membership.membership") ||
            sql.startsWith("UPDATE bop_membership.membership")
          )
            controls.written = true;
          return result;
        },
      });
    await query(connection, "BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await query(connection, "SET LOCAL statement_timeout='5s'");
      await query(connection, "SET LOCAL lock_timeout='2s'");
      if (controls.beforeActivationRead) {
        const actor = createIdentityActor({
          actorType: "User",
          actorReference: fixture.approval.actorReference,
          accountKind: "Workforce",
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "RecentMfa",
          authenticatedAt: fixture.activationAt,
          recentMfaAt: fixture.activationAt,
        });
        const brand = await createPostgresBrandAdministrationOrganizationSource(tx, {
          brandReference: fixture.approval.brandReference,
          observedAt: fixture.activationAt,
        }).getBrand(fixture.approval.brandReference);
        assert(brand);
        const read = createPostgresBrandAdministrationMembershipActivationSource(
          tx,
          createBrandAdministrationContext(actor, brand, fixture.activationAt),
        );
        const members = await read.findMemberships(actor.actorReference, brand.brandReference);
        assert.equal(members.length, 1);
        assert.equal(members[0].lifecycle, "PendingActivation");
        await controls.beforeActivationRead();
      }
      const source = make(
        tx,
        activate,
        controls,
        async (actual, guard, final) => {
          assert.equal(actual, tx);
          guards.push({ guard, final });
        },
        fixture,
      );
      const result = await work(source);
      assert.equal(guards.length, 1, "ACTUAL_HOST_REGISTRATION_REQUIRED");
      await controls.beforeCommit?.();
      for (const g of guards) await g.guard();
      for (const g of guards) g.final();
      await query(connection, "COMMIT");
      source.assertFinalized();
      return result;
    } catch (error) {
      await query(connection, "ROLLBACK");
      throw error;
    }
  };
  const verifyCrossBrandActivation = async () => {
    mark("CrossBrandActivationAdmission");
    const makeFixture = (base) => {
      mark(base === 1000 ? "CrossBrandFixtureA" : "CrossBrandFixtureB");
      const { sourceDigest: priorSourceDigest, ...bindingBody } = binding;
      void priorSourceDigest;
      const approved = parseApprovedWorkforceMembership({
        ...approval,
        operationReference: id(base + 1),
        brandReference: id(base + 5),
        membershipReference: id(base + 6),
        actorReference: id(base + 7),
        workforceRelationshipReference: id(base + 8),
        relationshipEvidenceReference: id(base + 9),
      });
      const original = parseWorkforceAccountBindingAcceptanceOriginal({
        ...bindingOriginal,
        operationReference: id(base + 12),
        actorReference: approved.actorReference,
        recordedByReference: approved.actorReference,
        invitationReference: id(base + 11),
        originalMembershipReference: approved.membershipReference,
        providerEvidenceReference: id(base + 13),
      });
      const accepted = buildWorkforceAccountBinding(
        {
          ...bindingBody,
          actorReference: approved.actorReference,
          encryptedSubject: {
            ...binding.encryptedSubject,
            encryptionContext: workforceAccountSubjectContext(
              configuration,
              approved.actorReference,
            ),
          },
          invitationReference: original.invitationReference,
          originalMembershipReference: original.originalMembershipReference,
          providerEvidenceReference: original.providerEvidenceReference,
          operationReference: original.operationReference,
          originalCommand: original,
          intentDigest: workforceAccountBindingIntent(
            configuration,
            original,
            workforceAccountBindingCodec,
          ),
          recordedByReference: approved.actorReference,
          auditReference: id(base + 14),
        },
        workforceAccountBindingCodec,
      );
      return {
        approval: approved,
        origin,
        activationAt,
        end,
        binding: accepted,
        createRequest: { profile: "CreateApprovedPendingMembershipV1", approval: approved },
        activationRequest: {
          ...activationRequest,
          approval: approved,
          operationReference: id(base + 10),
          invitationReference: id(base + 11),
        },
        pendingAudit: id(base + 20),
        activationAudit: id(base + 21),
        brandAudit: id(base + 22),
        brandOperation: id(base + 23),
        base,
      };
    };
    const fixtures = [makeFixture(1000), makeFixture(2000)];
    // Genuine public Tenant CreateBrand producer, not cloned successful rows.
    // Its approval port remains an explicitly controlled native boundary.
    for (const f of fixtures) {
      mark(f.base === 1000 ? "CrossBrandCreateA" : "CrossBrandCreateB");
      const brand = createBrand({
        brandReference: f.approval.brandReference,
        code: `SYNTHETIC_CONCURRENT_${f.base}`,
        displayName: "Synthetic Concurrent Brand",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Draft",
        version: 1,
        createdAt: origin,
        updatedAt: origin,
      });
      const tx = Object.freeze({ query: (sql, values) => query(admin, sql, values) });
      await query(admin, "BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        const intentDigest = `sha256:${"d".repeat(64)}`;
        const owner = createPostgresBrandInitialCreationStore({
          brandReference: brand.brandReference,
          binding: {
            operationReference: f.brandOperation,
            intentDigest,
            actorReference: f.approval.operatorReference,
            auditReference: f.brandAudit,
          },
          transactions: { run: (work) => work(tx) },
          authorize: async (actual) => {
            assert.equal(actual, tx);
            return true;
          },
          appendAudit: async (actual, input) => {
            assert.equal(actual, tx);
            await appendAuditRecordInTransaction(tx, {
              auditId: f.brandAudit,
              brandId: brand.brandReference,
              actor: { type: "User", reference: f.approval.operatorReference },
              actionCode: "BRAND_CREATED",
              targetType: "Brand",
              targetId: brand.brandReference,
              afterSummary: { operationReference: f.brandOperation, intentDigest },
              reasonCode: "CONTROLLED_APPROVED_ONBOARDING",
              correlationId: f.brandOperation,
              occurredAt: input.audit.occurredAt,
              sourceChannel: "DEPLOYMENT",
              dataClassification: "Restricted",
              retentionPolicyCode: "BRAND_ADMINISTRATION_AUDIT",
              retentionPolicyVersion: 1,
            });
          },
        });
        await owner.commit({
          operation: {
            command: "CreateBrand",
            operationReference: f.brandOperation,
            brandReference: brand.brandReference,
            intentDigest,
            brandVersion: 1,
            artifact: brand,
          },
          expectedBrandVersion: 0,
          audit: {
            actorReference: f.approval.operatorReference,
            purposeCode: "BRAND_INITIAL_PROVISIONING",
            auditReference: f.brandAudit,
            occurredAt: origin,
          },
        });
        await query(admin, "COMMIT");
      } catch (error) {
        await query(admin, "ROLLBACK");
        throw error;
      }
      mark(f.base === 1000 ? "CrossBrandPendingA" : "CrossBrandPendingB");
      f.originalPending = (
        await transaction(false, (source) => source.createPending(f.createRequest), {}, f)
      ).membership;
      assert.equal(f.originalPending.lifecycle, "PendingActivation");
    }
    const other = new pg.Client({ ...context.clientConfig, user: role, password });
    let releaseA,
      pendingA,
      pendingB,
      childFailure,
      otherCleanupFailure = false;
    const gate = new Promise((resolve) => {
      releaseA = resolve;
    });
    let enteredA;
    const readyA = new Promise((resolve) => {
      enteredA = resolve;
    });
    let bReachedMemberRead = false,
      bReachedMemberWrite = false;
    try {
      await other.connect();
      const aPid = (await query(client, "SELECT pg_backend_pid() AS pid")).rows[0].pid,
        bPid = (await query(other, "SELECT pg_backend_pid() AS pid")).rows[0].pid;
      mark("CrossBrandAEnter");
      pendingA = transaction(
        true,
        (source) => source.activateApproved(fixtures[0].activationRequest),
        {
          beforeActivationRead: async () => {
            mark("CrossBrandAHeld");
            enteredA();
            await gate;
            mark("CrossBrandAActivate");
          },
          beforeCommit: async () => {
            mark("CrossBrandACommit");
          },
        },
        fixtures[0],
        client,
      );
      // Attach immediately; failures must not escape as unhandled rejections.
      pendingA.catch(() => undefined);
      await Promise.race([
        readyA,
        pendingA.then(() => {
          throw new Error("ADMISSION_GATE_NOT_REACHED");
        }),
      ]);
      mark("CrossBrandBWait");
      pendingB = transaction(
        true,
        (source) => source.activateApproved(fixtures[1].activationRequest),
        {
          beforeActivationRead: async () => {
            mark("CrossBrandBActivate");
          },
          beforeCommit: async () => {
            mark("CrossBrandBCommit");
          },
          observeSql: (sql) => {
            if (sql.includes("FROM bop_membership.membership WHERE actor_id"))
              bReachedMemberRead = true;
            if (sql.startsWith("UPDATE bop_membership.membership")) bReachedMemberWrite = true;
          },
        },
        fixtures[1],
        other,
      );
      pendingB.catch(() => undefined);
      let waiting = false;
      const until = Date.now() + 1000;
      while (Date.now() < until) {
        const locks = (
          await query(
            admin,
            `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='bop_membership.membership'::regclass
          AND mode='ShareRowExclusiveLock' AND NOT granted) waiting,$2=ANY(pg_blocking_pids($1)) blocked`,
            [bPid, aPid],
          )
        ).rows[0];
        if (locks.waiting && locks.blocked) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(waiting, "ACTUAL_SRE_WAIT_REQUIRED");
      assert.equal(
        bReachedMemberRead,
        false,
        "SECOND_BRAND_MUST_NOT_RETAIN_MEMBERSHIP_SHARE_BEFORE_ADMISSION",
      );
      assert.equal(bReachedMemberWrite, false, "SECOND_BRAND_MUST_NOT_WRITE_BEFORE_ADMISSION");
      releaseA();
      const results = await Promise.all([pendingA, pendingB]);
      mark("CrossBrandCommittedAssertions");
      for (const result of results) {
        assert.equal(result.membership.lifecycle, "Active");
        assert.equal(result.membership.version, 2);
      }
      const committed = (
        await query(
          admin,
          "SELECT membership_id::text,lifecycle,version FROM bop_membership.membership WHERE membership_id=ANY($1::uuid[]) ORDER BY membership_id",
          [fixtures.map((f) => f.approval.membershipReference)],
        )
      ).rows;
      assert.equal(committed.length, 2);
      assert(committed.every((row) => row.lifecycle === "Active" && row.version === 2));
      const audits = (
        await query(
          admin,
          "SELECT audit_id::text,actor_reference::text FROM platform_audit.audit_record WHERE audit_id=ANY($1::uuid[]) ORDER BY audit_id",
          [fixtures.map((f) => f.activationAudit)],
        )
      ).rows;
      assert.equal(audits.length, 2);
      for (const f of fixtures)
        assert(
          audits.some(
            (row) =>
              row.audit_id === f.activationAudit &&
              row.actor_reference === f.approval.actorReference,
          ),
        );
      assert.notEqual(sqlState, "40P01");
    } catch (error) {
      childFailure = error;
    } finally {
      releaseA();
      const settled = await Promise.allSettled([pendingA, pendingB].filter(Boolean));
      if (!childFailure)
        childFailure = settled.find((result) => result.status === "rejected")?.reason;
      try {
        await other.query("ROLLBACK");
      } catch {
        otherCleanupFailure = true;
      }
      try {
        await other.end();
      } catch {
        otherCleanupFailure = true;
      }
    }
    if (childFailure) throw childFailure;
    if (otherCleanupFailure) throw new Error("CONCURRENT_MEMBER_CLEANUP_UNAVAILABLE");
  };
  await admin.connect();
  try {
    assert.match(role, /^[a-z][a-z0-9_]{0,62}$/u);
    await query(
      admin,
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
    );
    roleCreated = true;
    await query(
      admin,
      `GRANT USAGE ON SCHEMA bop_membership,bop_tenant,platform_audit,platform_helpers TO ${role}`,
    );
    await query(
      admin,
      `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    // MAINTAIN is the existing PG18 minimum for the owner's creation predicate
    // table fence; the three column grants alone permit only lifecycle/CAS writes.
    await query(
      admin,
      `GRANT SELECT,INSERT,MAINTAIN,UPDATE(lifecycle,version,updated_at) ON bop_membership.membership TO ${role}`,
    );
    await query(admin, `GRANT SELECT,UPDATE(version) ON bop_tenant.brand TO ${role}`);
    await query(admin, `GRANT SELECT,INSERT ON platform_audit.audit_record TO ${role}`);
    await query(admin, `GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
    const brand = createBrand({
      brandReference: approval.brandReference,
      code: "SYNTHETIC_PENDING",
      displayName: "Synthetic Pending Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Draft",
      version: 1,
      createdAt: origin,
      updatedAt: origin,
    });
    await query(
      admin,
      `INSERT INTO bop_tenant.brand(brand_id,code,display_name,default_locale,currency_code,lifecycle,version,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [
        brand.brandReference,
        brand.code,
        brand.displayName,
        brand.defaultLocale,
        brand.currencyCode,
        brand.lifecycle,
        brand.version,
        origin,
      ],
    );
    client = new pg.Client({ ...context.clientConfig, user: role, password });
    await client.connect();
    assert.equal((await query(client, "SELECT current_user AS principal")).rows[0].principal, role);
    const acl = (
      await query(
        admin,
        `SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,
      has_table_privilege($1,'bop_membership.membership','UPDATE') full_update,
      has_table_privilege($1,'bop_membership.membership','DELETE') delete_allowed,
      has_column_privilege($1,'bop_membership.membership','actor_id','UPDATE') actor_update,
      has_column_privilege($1,'bop_membership.membership','workforce_relationship_reference','UPDATE') relationship_update,
      has_table_privilege($1,'bop_membership.store_assignment','INSERT') store_assignment_write,
      has_table_privilege($1,'bop_permission.role_assignment','INSERT') role_assignment_write,
      has_table_privilege($1,'bop_identity.authentication_session','SELECT') session_read,
      has_table_privilege($1,'platform_audit.audit_record','UPDATE') audit_update,
      (SELECT pg_get_userbyid(relowner)=$1 FROM pg_class WHERE oid='bop_membership.membership'::regclass) table_owner
      FROM pg_roles WHERE rolname=$1`,
        [role],
      )
    ).rows[0];
    assert.deepEqual(acl, {
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      full_update: false,
      delete_allowed: false,
      actor_update: false,
      relationship_update: false,
      store_assignment_write: false,
      role_assignment_write: false,
      session_read: false,
      audit_update: false,
      table_owner: false,
    });
    const empty = await snapshot();
    assert.deepEqual(empty, { members: [], audits: [], heads: [] });

    mark("AutocommitZeroEffects");
    const raw = Object.freeze({ query: (sql, values) => query(client, sql, values) });
    await assert.rejects(
      make(raw, false, {}, async () => undefined).createPending(createRequest),
      denied,
    );
    assert.deepEqual(await snapshot(), empty);
    assert.equal(auditCalls, 0);

    mark("CaughtFailureRollsBackPendingAndAudit");
    let caught = false;
    await assert.rejects(
      transaction(false, async (source) => {
        await source.createPending(createRequest);
        try {
          await source.createPending(createRequest);
        } catch (error) {
          assert(denied(error));
          caught = true;
        }
      }),
      denied,
    );
    assert(caught);
    assert.deepEqual(await snapshot(), empty);

    mark("CreateActualPending");
    const created = await transaction(false, (source) => source.createPending(createRequest));
    originalPending = created.membership;
    assert.equal(originalPending.lifecycle, "PendingActivation");
    assert.equal(originalPending.version, 1);
    const pending = await snapshot();
    assert.equal(pending.members.length, 1);
    assert.equal(pending.audits.length, 1);
    assert.equal(pending.audits[0].actor_reference, approval.operatorReference);
    if (extension) {
      await extension.onPending({
        admin,
        approval,
        originalPending,
        origin,
        activationAt,
        end,
        query,
        context,
      });
    } else {
      await assert.rejects(
        transaction(false, (source) => source.createPending(createRequest)),
        denied,
      );
      assert.deepEqual(await snapshot(), pending);

      mark("WrongScopeCannotReadActualMember");
      await query(client, "BEGIN");
      try {
        await query(
          client,
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
          [id(99)],
        );
        assert.equal(
          (
            await query(
              client,
              "SELECT membership_id FROM bop_membership.membership WHERE membership_id=$1",
              [approval.membershipReference],
            )
          ).rowCount,
          0,
        );
      } finally {
        await query(client, "ROLLBACK");
      }
      await assert.rejects(
        transaction(true, (source) =>
          source.activateApproved({ ...activationRequest, expectedVersion: 2 }),
        ),
        denied,
      );
      assert.deepEqual(await snapshot(), pending);

      mark("LateApprovalRollsBackActivationAndAudit");
      const late = { allowed: true };
      late.beforeCommit = async () => {
        assert(late.written);
        late.allowed = false;
      };
      await assert.rejects(
        transaction(true, (source) => source.activateApproved(activationRequest), late),
        denied,
      );
      assert(late.authorityCalls >= 2);
      assert.deepEqual(await snapshot(), pending);

      mark("LatePolicyAndClockRollBack");
      for (const kind of ["policy", "clock"]) {
        const controls = {};
        controls.beforeCommit = async () => {
          assert(controls.written);
          if (kind === "policy") controls.policyChanged = true;
          else controls.now = new Date(Date.parse(activationAt) + 5000).toISOString();
        };
        await assert.rejects(
          transaction(true, (source) => source.activateApproved(activationRequest), controls),
          denied,
        );
        assert.deepEqual(await snapshot(), pending);
      }

      mark("ActualAuditAppendFailureRollsBack");
      const auditFault = { auditFault: true },
        beforeAuditCalls = auditCalls;
      await assert.rejects(
        transaction(true, (source) => source.activateApproved(activationRequest), auditFault),
        denied,
      );
      assert(auditFault.written);
      assert.equal(auditCalls, beforeAuditCalls + 1);
      assert.deepEqual(await snapshot(), pending);

      mark("ActivateExactPendingAndRejectStaleCas");
      const active = await transaction(true, (source) =>
        source.activateApproved(activationRequest),
      );
      assert.equal(active.membership.lifecycle, "Active");
      assert.equal(active.membership.version, 2);
      assert.equal(active.membership.createdAt, origin);
      assert.equal(active.membership.updatedAt, activationAt);
      const committed = await snapshot();
      assert.equal(committed.members[0].version, 2);
      assert.equal(committed.audits.length, 2);
      assert.equal(committed.audits[1].actor_reference, approval.actorReference);
      assert.equal(committed.heads[0].next_sequence, "3");
      await assert.rejects(
        transaction(true, (source) => source.activateApproved(activationRequest)),
        denied,
      );
      assert.deepEqual(await snapshot(), committed);
      assert.equal(
        (
          await query(
            admin,
            "SELECT count(*)::integer AS count FROM bop_membership.store_assignment WHERE brand_id=$1",
            [approval.brandReference],
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        (
          await query(
            admin,
            "SELECT count(*)::integer AS count FROM bop_permission.role_assignment WHERE brand_id=$1",
            [approval.brandReference],
          )
        ).rows[0].count,
        0,
      );
    }
    if (!extension) await verifyCrossBrandActivation();
  } catch (error) {
    failed = true;
    primaryFailure =
      extension &&
      error instanceof Error &&
      (/^Approved Workforce policy native failed at [A-Za-z]+; SQLSTATE=(?:none|[A-Z0-9]{5})$/u.test(
        error.message,
      ) ||
        error.message === "APPROVED_WORKFORCE_POLICY_NATIVE_CLEANUP_UNAVAILABLE")
        ? error
        : new Error(`Approved Membership native failed at ${stage}; SQLSTATE=${sqlState}`);
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
    try {
      await admin.end();
    } catch {
      cleanupFailed = true;
    }
  }
  if (failed) throw primaryFailure;
  if (cleanupFailed) throw new Error("APPROVED_MEMBERSHIP_NATIVE_CLEANUP_UNAVAILABLE");
}
