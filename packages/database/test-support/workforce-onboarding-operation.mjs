import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import pg from "pg";
import { verifyWorkforceOnboardingInvitationSource } from "./workforce-onboarding-invitation-source.mjs";
import {
  appendPlatformAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  verifyPlatformAuditChain,
} from "../../bop/audit/src/index.ts";
import {
  createIdentityActor,
  createPostgresWorkforceInvitationStore,
  createPostgresWorkforceOnboardingOperationStore,
  parseRawBrowserCredential,
  parseSelectorHash,
  parseWorkforceOnboardingOriginal,
  parseWorkforceOnboardingOperation,
  workforceOnboardingIntent,
  workforceOnboardingCodec,
} from "../../bop/identity/src/index.ts";
const id = (n) => `0190ed60-0320-7000-8000-${n.toString(16).padStart(12, "0")}`;
const denied = (error) => error?.code === "WORKFORCE_ONBOARDING_DENIED";
const purposeCode = "WORKFORCE_ONBOARDING";
const digest = (value) => `sha256:${sha256Hex(canonicalizeRfc8785(value))}`;

/** Actual005 invitation owner,032 journal,024 deferred Audit binding and real
 * public Audit chain on an isolated nonowner/nonbypass LOGIN. Approved operator,
 * qualification, Provider observation and clock are controlled InternalTest source boundaries. This
 * neither calls Cognito nor proves email delivery, acceptance, TOTP or roles. */
export async function verifyWorkforceOnboardingOperationPersistence(context) {
  const admin = new pg.Client(context.clientConfig),
    role = `onboard_journal_${context.runId}`,
    password = randomBytes(32).toString("hex"),
    key = randomBytes(32);
  const configuration = {
    environment: "controlled",
    issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Controlled",
    clientId: "controlledclient",
  };
  const operatorReference = id(1),
    approvedByReference = id(2);
  let client,
    roleCreated = false,
    allocated = 10000,
    generated = 0,
    creatorCalls = 0,
    stage = "Setup",
    sqlState = "none",
    primaryFailure,
    cleanupFailed = false,
    capturedInsert;
  const query = async (connection, sql, values = []) => {
    try {
      if (
        connection === client &&
        sql.startsWith("INSERT INTO bop_identity.workforce_onboarding_operation")
      )
        capturedInsert = { sql, values: [...values] };
      return await connection.query(sql, [...values]);
    } catch (error) {
      if (/^[0-9A-Z]{5}$/u.test(error?.code ?? "")) sqlState = error.code;
      throw error;
    }
  };
  const mark = (value) => {
    stage = value;
    sqlState = "none";
  };
  const next = () => id(allocated++);
  const counts = async () =>
    (
      await query(
        admin,
        `SELECT
    (SELECT count(*)::int FROM bop_identity.workforce_onboarding_operation WHERE operator_id=$1) operations,
    (SELECT count(*)::int FROM bop_identity.workforce_invitation WHERE inviter_actor_id=$1) invitations,
    (SELECT count(*)::int FROM platform_audit.platform_actor_audit_record WHERE actor_id=$1 AND purpose_code=$2) audits,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(next_sequence,encode(last_record_hash,'hex'))),'[]'::jsonb) FROM platform_audit.platform_actor_audit_chain_head WHERE actor_id=$1 AND purpose_code=$2) heads`,
        [operatorReference, purposeCode],
      )
    ).rows[0];
  const original = (base = 100) =>
    parseWorkforceOnboardingOriginal({
      profile: "WorkforceOnboardingOriginalV1",
      configuration,
      operationReference: id(base),
      operatorReference,
      actorReference: id(base + 1),
      brandReference: id(base + 2),
      membershipReference: id(base + 3),
      storeAssignmentReferences: [],
      emailDigest: parseSelectorHash("a".repeat(64)),
      approvedByReference,
      approvalEvidenceReference: id(base + 4),
      relationshipEvidenceReference: id(base + 5),
      approvedPlanDigest: `sha256:${"b".repeat(64)}`,
      reasonCode: "APPROVED_ONBOARDING",
    });
  const hasher = {
    hash: (value) => parseSelectorHash(createHmac("sha256", key).update(value).digest("hex")),
    equals: (a, b) => a === b,
  };
  const envelopes = {
    async encrypt(text, encryptionContext) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(encryptionContext));
      return {
        algorithm: "SYNTHETIC_AES_256_GCM",
        keyReference: "controlled-native-key",
        ciphertext: Buffer.concat([
          iv,
          cipher.update(text),
          cipher.final(),
          cipher.getAuthTag(),
        ]).toString("base64url"),
        encryptionContext,
      };
    },
    async decrypt(envelope, encryptionContext) {
      const bytes = Buffer.from(envelope.ciphertext, "base64url"),
        decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(encryptionContext));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString();
    },
  };
  const make = (tx, o, controls, register, children) => {
    const observedAt = controls.observedAt ?? new Date(Date.now() - 1000).toISOString(),
      validUntil = new Date(Date.parse(observedAt) + 5000).toISOString();
    const binding = {
      operatorReference,
      actorReference: o.actorReference,
      brandReference: o.brandReference,
      membershipReference: o.membershipReference,
      purposeCode,
    };
    const operator = createIdentityActor({
      actorType: "User",
      actorReference: operatorReference,
      accountKind: "Platform",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "RecentMfa",
      authenticatedAt: observedAt,
      recentMfaAt: observedAt,
    });
    const clock = { now: () => controls.now ?? observedAt };
    const current = () => {
      if (controls.allowed === false) throw new Error("CONTROLLED_APPROVAL_WITHDRAWN");
      controls.authorityCalls = (controls.authorityCalls ?? 0) + 1;
    };
    return createPostgresWorkforceOnboardingOperationStore({
      transaction: tx,
      configuration,
      binding,
      clock,
      originalObservedAt: observedAt,
      originalValidUntil: validUntil,
      authority: {
        async hold(actual, input) {
          assert.equal(actual, tx);
          assert.deepEqual(input.binding, binding);
          assert.match(input.requestDigest, /^sha256:[a-f0-9]{64}$/u);
          current();
          return {
            binding,
            action: input.action,
            requestDigest: input.requestDigest,
            operator,
            validUntil: input.validUntil,
          };
        },
      },
      hasher,
      envelopes,
      credentials: {
        generate() {
          generated++;
          return parseRawBrowserCredential(randomBytes(32).toString("base64url"));
        },
      },
      nextReference: next,
      async createInvitation(actual, command) {
        assert.equal(actual, tx);
        creatorCalls++;
        const leafBinding = {
          operatorReference,
          actorReference: o.actorReference,
          membershipReference: o.membershipReference,
          purposeCode,
          action: "IssueInvitation",
          operationReference: next(),
          correlationReference: next(),
        };
        const leaf = createPostgresWorkforceInvitationStore({
          transaction: tx,
          binding: leafBinding,
          clock,
          originalObservedAt: observedAt,
          originalValidUntil: validUntil,
          authority: {
            async hold(heldTx, input) {
              assert.equal(heldTx, tx);
              assert.deepEqual(input.binding, leafBinding);
              current();
              return {
                binding: leafBinding,
                requestDigest: input.requestDigest,
                operator,
                validUntil: input.validUntil,
              };
            },
          },
          async appendAudit(heldTx, descriptor) {
            assert.equal(heldTx, tx);
            assert.equal(descriptor.operation, "InvitationIssued");
            assert.equal(descriptor.actorReference, operatorReference);
            assert.equal(descriptor.targetActorReference, o.actorReference);
            assert.equal(descriptor.idempotencyKey, leafBinding.operationReference);
            await query(
              client,
              "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose',$2,true)",
              [operatorReference, purposeCode],
            );
            await appendPlatformAuditRecordInTransaction(tx, {
              auditReference: next(),
              actorReference: operatorReference,
              purposeCode,
              actionCode: "WORKFORCE_INVITATION_ISSUED",
              targetType: "WorkforceInvitation",
              targetReference: command.invitationReference,
              operationReference: leafBinding.operationReference,
              intentDigest: digest(command),
              occurredAt: descriptor.occurredAt,
              reasonCode: o.reasonCode,
              retentionPolicyCode: "CONFIGURATION_AUDIT",
              retentionPolicyVersion: 1,
            });
          },
          registerBeforeCommit: register,
        });
        children.push(leaf);
        return leaf.createInvitation(command);
      },
      registerBeforeCommit: register,
    });
  };
  const transaction = async (o, work, controls = {}) => {
    const guards = [],
      children = [];
    let open = true;
    const tx = Object.freeze({
      query: (sql, values) => {
        assert(open, "EXACT_LIVE_TRANSACTION_REQUIRED");
        return query(client, sql, values);
      },
    });
    await query(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await query(client, "SET LOCAL statement_timeout='5s'");
      await query(client, "SET LOCAL lock_timeout='2s'");
      const store = make(
        tx,
        o,
        controls,
        async (actual, guard, final) => {
          assert.equal(actual, tx);
          guards.push({ guard, final });
        },
        children,
      );
      const result = await work(store);
      assert(guards.length >= 1, "REAL_HOST_GUARD_REQUIRED");
      await controls.beforeCommit?.();
      for (const entry of guards) await entry.guard();
      for (const entry of guards) entry.final();
      await query(client, "COMMIT");
      open = false;
      store.assertFinalized();
      for (const child of children) child.assertFinalized();
      return result;
    } catch (error) {
      const originalState = sqlState;
      try {
        await query(client, "ROLLBACK");
      } catch {
        cleanupFailed = true;
      }
      open = false;
      sqlState = originalState;
      throw error;
    }
  };
  const phaseRequest = (o, expectedVersion) => ({
    operationReference: o.operationReference,
    intentDigest: workforceOnboardingIntent(o, workforceOnboardingCodec),
    expectedVersion,
  });
  const scope = async (o) =>
    query(
      client,
      "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose',$2,true),set_config('bop.onboarding_environment',$3,true),set_config('bop.onboarding_issuer',$4,true),set_config('bop.onboarding_client_id',$5,true),set_config('bop.onboarding_actor_id',$6,true),set_config('bop.onboarding_brand_id',$7,true),set_config('bop.onboarding_member_id',$8,true)",
      [
        operatorReference,
        purposeCode,
        configuration.environment,
        configuration.issuer,
        configuration.clientId,
        o.actorReference,
        o.brandReference,
        o.membershipReference,
      ],
    );
  try {
    await admin.connect();
    assert.match(role, /^[a-z][a-z0-9_]{0,62}$/u);
    await query(
      admin,
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
    );
    roleCreated = true;
    await query(
      admin,
      `GRANT USAGE ON SCHEMA bop_identity,platform_audit,platform_helpers TO ${role}`,
    );
    await query(admin, `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO ${role}`);
    await query(
      admin,
      `GRANT SELECT,INSERT ON bop_identity.workforce_onboarding_operation TO ${role}`,
    );
    // SELECT FOR SHARE/UPDATE needs one UPDATE column, never arbitrary invitation edits.
    await query(
      admin,
      `GRANT SELECT,INSERT,UPDATE(version) ON bop_identity.workforce_invitation TO ${role}`,
    );
    await query(
      admin,
      `GRANT SELECT,INSERT ON platform_audit.platform_actor_audit_record TO ${role}`,
    );
    await query(
      admin,
      `GRANT SELECT,INSERT,UPDATE ON platform_audit.platform_actor_audit_chain_head TO ${role}`,
    );
    await query(
      admin,
      `GRANT EXECUTE ON FUNCTION bop_identity.workforce_onboarding_scope(uuid,uuid,uuid,uuid,text,text,text),bop_identity.workforce_onboarding_operation_admit(uuid,uuid,uuid,uuid),bop_identity.workforce_onboarding_instant(text) TO ${role}`,
    );
    await query(
      admin,
      `GRANT EXECUTE ON FUNCTION platform_audit.matches_workforce_onboarding_operation_audit(uuid,uuid,text,uuid,uuid,text,timestamptz,text) TO ${role}`,
    );
    client = new pg.Client({ ...context.clientConfig, user: role, password });
    await client.connect();
    const acl = (
      await query(
        admin,
        `SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,
      has_table_privilege($1,'bop_identity.workforce_onboarding_operation','UPDATE') journal_update,
      has_table_privilege($1,'bop_identity.workforce_onboarding_operation','DELETE') journal_delete,
      has_table_privilege($1,'bop_identity.workforce_onboarding_operation','TRUNCATE') journal_truncate,
      has_table_privilege($1,'bop_identity.workforce_invitation','UPDATE') invitation_update,
      has_column_privilege($1,'bop_identity.workforce_invitation','selector_hash','UPDATE') selector_update,
      has_table_privilege($1,'bop_identity.authentication_session','SELECT') session_read,
      has_table_privilege($1,'bop_membership.membership','INSERT') membership_write,
      (SELECT pg_get_userbyid(relowner)=$1 FROM pg_class WHERE oid='bop_identity.workforce_onboarding_operation'::regclass) table_owner
      FROM pg_roles WHERE rolname=$1`,
        [role],
      )
    ).rows[0];
    assert.deepEqual(acl, {
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      journal_update: false,
      journal_delete: false,
      journal_truncate: false,
      invitation_update: false,
      selector_update: false,
      session_read: false,
      membership_write: false,
      table_owner: false,
    });
    assert.equal((await query(client, "SELECT current_user AS principal")).rows[0].principal, role);
    const o = original(),
      baseline = await counts();
    mark("AutocommitNoInvitationOrAudit");
    const unsafeTx = Object.freeze({ query: (sql, values) => query(client, sql, values) });
    const unsafe = make(unsafeTx, o, {}, async () => undefined, []);
    await assert.rejects(unsafe.prepare(o), denied);
    assert.deepEqual(await counts(), baseline);
    assert.equal(generated, 0);
    assert.equal(creatorCalls, 0);
    mark("ActualPendingAndTwoAuditRecords");
    const p = await transaction(o, (store) => store.prepare(o));
    assert.equal(p.outcome, "Prepared");
    assert.equal(typeof p.deliverySecret, "string");
    assert.equal(p.record.state, "Prepared");
    assert.equal(p.record.version, 1);
    const afterPrepare = await counts();
    assert.equal(afterPrepare.operations - baseline.operations, 1);
    assert.equal(afterPrepare.invitations - baseline.invitations, 1);
    assert.equal(afterPrepare.audits - baseline.audits, 2);
    const stored = (
      await query(
        admin,
        "SELECT snapshot_text,selector_hash FROM bop_identity.workforce_onboarding_operation WHERE operation_id=$1",
        [o.operationReference],
      )
    ).rows[0];
    assert.equal(stored.snapshot_text, canonicalizeRfc8785(p.record));
    assert(!stored.snapshot_text.includes(p.deliverySecret));
    assert.equal(stored.selector_hash, hasher.hash(p.deliverySecret));
    mark("OriginalBeforeAllocationNoSecret");
    const allocations = allocated,
      generations = generated,
      creates = creatorCalls;
    const replay = await transaction(o, (store) => store.prepare(o));
    assert.deepEqual(replay, { record: p.record, outcome: "Original", deliverySecret: null });
    assert.equal(allocated, allocations);
    assert.equal(generated, generations);
    assert.equal(creatorCalls, creates);
    assert.deepEqual(await counts(), afterPrepare);
    mark("ActualClaimRollbackAndMissingAudit");
    const lateClaim = {
      allowed: true,
      beforeCommit: async () => {
        lateClaim.allowed = false;
      },
    };
    await assert.rejects(
      transaction(o, (store) => store.claimDispatch(phaseRequest(o, 1)), lateClaim),
      denied,
    );
    assert.deepEqual(await counts(), afterPrepare);
    const raw = capturedInsert;
    assert(raw, "ACTUAL_ROLLED_BACK_OWNER_INSERT_REQUIRED");
    await query(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await scope(o);
      await query(client, "SELECT bop_identity.workforce_onboarding_operation_admit($1,$2,$3,$4)", [
        operatorReference,
        o.operationReference,
        o.actorReference,
        o.membershipReference,
      ]);
      await query(client, raw.sql, raw.values);
      await assert.rejects(query(client, "COMMIT"), { code: "23514" });
    } finally {
      await query(client, "ROLLBACK");
    }
    assert.deepEqual(await counts(), afterPrepare);
    mark("GenuineMatchingAuditFromAnotherTransactionCannotCompleteJournal");
    const rawRecord = JSON.parse(raw.values[22]);
    await query(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await scope(o);
      const auditTx = Object.freeze({ query: (sql, values) => query(client, sql, values) });
      await appendPlatformAuditRecordInTransaction(auditTx, {
        auditReference: rawRecord.auditReference,
        actorReference: operatorReference,
        purposeCode,
        actionCode: "WORKFORCE_ONBOARDING_RECORDED",
        targetType: "WorkforceOnboardingOperation",
        targetReference: o.operationReference,
        operationReference: rawRecord.phaseOperationReference,
        intentDigest: rawRecord.phaseRequestDigest,
        occurredAt: rawRecord.occurredAt,
        reasonCode: o.reasonCode,
        retentionPolicyCode: "CONFIGURATION_AUDIT",
        retentionPolicyVersion: 1,
      });
      await query(client, "COMMIT");
    } finally {
      await query(client, "ROLLBACK");
    }
    const withOldAudit = await counts();
    assert.equal(withOldAudit.operations, afterPrepare.operations);
    assert.equal(withOldAudit.audits, afterPrepare.audits + 1);
    await query(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await scope(o);
      await query(client, "SELECT bop_identity.workforce_onboarding_operation_admit($1,$2,$3,$4)", [
        operatorReference,
        o.operationReference,
        o.actorReference,
        o.membershipReference,
      ]);
      await query(client, raw.sql, raw.values);
      await assert.rejects(query(client, "COMMIT"), { code: "23514" });
    } finally {
      await query(client, "ROLLBACK");
    }
    assert.deepEqual(await counts(), withOldAudit);
    mark("OneDurableClaimAndOriginalRetry");
    const c = await transaction(o, (store) => store.claimDispatch(phaseRequest(o, 1)));
    assert.equal(c.outcome, "Claimed");
    assert.equal(c.record.state, "DispatchClaimed");
    const afterClaim = await counts(),
      claimAllocations = allocated;
    const repeated = await transaction(o, (store) => store.claimDispatch(phaseRequest(o, 1)));
    assert.deepEqual(repeated, { record: c.record, outcome: "Original" });
    assert.equal(allocated, claimAllocations);
    assert.deepEqual(await counts(), afterClaim);
    mark("UnknownInspectionNeverUnclaimsOrRenews");
    const inspectAt = new Date(Date.now() - 1000).toISOString();
    const observation = {
      profile: "CognitoWorkforceInvitationObservationV1",
      actorReference: o.actorReference,
      creationIntentDigest: c.record.intentDigest,
      emailDigest: o.emailDigest,
      observedAt: inspectAt,
      validUntil: new Date(Date.parse(inspectAt) + 5000).toISOString(),
      status: "Unknown",
      dispatchAccepted: null,
      provider: null,
    };
    const unknown = await transaction(
      o,
      (store) => store.recordInspection({ ...phaseRequest(o, 2), observation }),
      { observedAt: inspectAt },
    );
    assert.equal(unknown.state, "ProviderUnknown");
    assert.equal(unknown.expiresAt, p.record.expiresAt);
    assert.equal(unknown.dispatchStartedAt, c.record.dispatchStartedAt);
    assert.equal(unknown.provider, null);
    const beforeUnknownRetry = await counts(),
      beforeUnknownAllocations = allocated;
    const unknownRetry = await transaction(o, (store) => store.claimDispatch(phaseRequest(o, 1)));
    assert.equal(unknownRetry.outcome, "Original");
    assert.deepEqual(unknownRetry.record, unknown);
    assert.equal(allocated, beforeUnknownAllocations);
    assert.deepEqual(await counts(), beforeUnknownRetry);
    mark("ControlledInspectionStoresRealEncryptedSubjectOnly");
    const foundAt = new Date(Date.now() - 1000).toISOString(),
      subject = "controlled-native-onboarding-sub";
    const foundObservation = {
      ...observation,
      observedAt: foundAt,
      validUntil: new Date(Date.parse(foundAt) + 5000).toISOString(),
      status: "Found",
      provider: {
        username: `bop_${o.actorReference}`,
        subject,
        status: "FORCE_CHANGE_PASSWORD",
        enabled: true,
        createdAt: c.record.dispatchStartedAt,
      },
    };
    // Controlled observed Provider facts exercise persistence only, not an AWS result.
    const beforeObserved = await counts(),
      lateObserved = {
        observedAt: foundAt,
        allowed: true,
        beforeCommit: async () => {
          lateObserved.allowed = false;
        },
      };
    await assert.rejects(
      transaction(
        o,
        (store) => store.recordInspection({ ...phaseRequest(o, 3), observation: foundObservation }),
        lateObserved,
      ),
      denied,
    );
    assert.deepEqual(await counts(), beforeObserved);
    const observedInsert = capturedInsert;
    assert(observedInsert, "ACTUAL_ROLLED_BACK_OBSERVED_INSERT_REQUIRED");
    const malformed = JSON.parse(observedInsert.values[22]);
    assert.equal(malformed.state, "ProviderObserved");
    assert.equal(malformed.version, 4);
    // Keep every actual owner-produced tuple/chain pin, altering only the key
    // to256 UTF16 units and its genuine RFC8785 source hash. This would commit
    // without the selected SQL key-length constraint; there is a real currentTX Audit.
    malformed.provider.encryptedSubject.keyReference = "\u{1f600}".repeat(128);
    const { sourceDigest: discardedDigest, ...malformedBody } = malformed;
    void discardedDigest;
    malformed.sourceDigest = digest(malformedBody);
    assert.throws(() => parseWorkforceOnboardingOperation(malformed, workforceOnboardingCodec));
    const malformedValues = [...observedInsert.values];
    malformedValues[21] = malformed.sourceDigest;
    malformedValues[22] = canonicalizeRfc8785(malformed);
    mark("ActualSqlRejectsUtf16OverflowWithMatchingCurrentAudit");
    await query(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await scope(o);
      await query(client, "SELECT bop_identity.workforce_onboarding_operation_admit($1,$2,$3,$4)", [
        operatorReference,
        o.operationReference,
        o.actorReference,
        o.membershipReference,
      ]);
      const auditTx = Object.freeze({ query: (sql, values) => query(client, sql, values) });
      await appendPlatformAuditRecordInTransaction(auditTx, {
        auditReference: malformed.auditReference,
        actorReference: operatorReference,
        purposeCode,
        actionCode: "WORKFORCE_ONBOARDING_RECORDED",
        targetType: "WorkforceOnboardingOperation",
        targetReference: o.operationReference,
        operationReference: malformed.phaseOperationReference,
        intentDigest: malformed.phaseRequestDigest,
        occurredAt: malformed.occurredAt,
        reasonCode: o.reasonCode,
        retentionPolicyCode: "CONFIGURATION_AUDIT",
        retentionPolicyVersion: 1,
      });
      await assert.rejects(query(client, observedInsert.sql, malformedValues), { code: "23514" });
    } finally {
      await query(client, "ROLLBACK");
    }
    assert.deepEqual(await counts(), beforeObserved);
    mark("ControlledInspectionStoresRealEncryptedSubjectOnly");
    const currentFoundAt = new Date(Date.now() - 1000).toISOString(),
      currentFound = {
        ...foundObservation,
        observedAt: currentFoundAt,
        validUntil: new Date(Date.parse(currentFoundAt) + 5000).toISOString(),
      };
    const observed = await transaction(
      o,
      (store) => store.recordInspection({ ...phaseRequest(o, 3), observation: currentFound }),
      { observedAt: currentFoundAt },
    );
    assert.equal(observed.state, "ProviderObserved");
    assert.equal(observed.provider.status, "FORCE_CHANGE_PASSWORD");
    assert.equal(observed.expiresAt, p.record.expiresAt);
    assert(!canonicalizeRfc8785(observed).includes(subject));
    assert.equal(
      await envelopes.decrypt(
        observed.provider.encryptedSubject,
        observed.provider.encryptedSubject.encryptionContext,
      ),
      subject,
    );
    assert.equal(
      (
        await query(
          admin,
          "SELECT status,provider_evidence_id FROM bop_identity.workforce_invitation WHERE invitation_id=$1",
          [p.record.invitationReference],
        )
      ).rows[0].status,
      "Pending",
    );
    await verifyWorkforceOnboardingInvitationSource(context, {
      admin,
      configuration,
      hasher,
      original,
      transaction,
      phaseRequest,
      next,
      query,
      mark,
    });
    mark("CaughtFailureRollsBackPendingJournalAndBothAudits");
    const other = original(200),
      beforeCaught = await counts();
    let caught = false;
    await assert.rejects(
      transaction(other, async (store) => {
        await store.prepare(other);
        try {
          await store.resolveOriginal({
            operationReference: other.operationReference,
            intentDigest: `sha256:${"c".repeat(64)}`,
          });
        } catch (error) {
          assert(denied(error));
          caught = true;
        }
      }),
      denied,
    );
    assert(caught);
    assert.deepEqual(await counts(), beforeCaught);
    mark("LateAuthorityRollsBackPendingJournalAndBothAudits");
    const late = {
      allowed: true,
      beforeCommit: async () => {
        late.allowed = false;
      },
    };
    await assert.rejects(
      transaction(original(300), (store) => store.prepare(original(300)), late),
      denied,
    );
    assert.deepEqual(await counts(), beforeCaught);
    mark("ExactOriginalScopeAndIntent");
    await assert.rejects(
      transaction(o, (store) =>
        store.prepare({ ...o, approvedPlanDigest: `sha256:${"d".repeat(64)}` }),
      ),
      denied,
    );
    assert.deepEqual(await counts(), beforeCaught);
    await query(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await scope({ ...o, actorReference: id(999) });
      assert.equal(
        (
          await query(
            client,
            "SELECT version FROM bop_identity.workforce_onboarding_operation WHERE operation_id=$1",
            [o.operationReference],
          )
        ).rows.length,
        0,
      );
    } finally {
      await query(client, "ROLLBACK");
    }
    mark("ActualHistoricalPrepareAndOriginalTwentyFourHourExpiry");
    const historic = original(400),
      historicAt = new Date(Date.now() - 86401000).toISOString();
    const hp = await transaction(historic, (store) => store.prepare(historic), {
      observedAt: historicAt,
    });
    const expiredAt = new Date(Date.now() - 500).toISOString(),
      expiry = await transaction(
        historic,
        (store) => store.recordExpired(phaseRequest(historic, 1)),
        { observedAt: expiredAt },
      );
    assert.equal(expiry.state, "Expired");
    assert.equal(expiry.createdAt, hp.record.createdAt);
    assert.equal(expiry.expiresAt, hp.record.expiresAt);
    assert.equal(Date.parse(expiry.expiresAt) - Date.parse(expiry.createdAt), 86400000);
    const beforeExpiredReplay = await counts(),
      expiryAllocations = allocated;
    const expiredOriginal = await transaction(historic, (store) => store.prepare(historic));
    assert.equal(expiredOriginal.deliverySecret, null);
    assert.equal(expiredOriginal.outcome, "Original");
    assert.deepEqual(expiredOriginal.record, expiry);
    assert.equal(allocated, expiryAllocations);
    assert.deepEqual(await counts(), beforeExpiredReplay);
    mark("RealAuditChainAndImmutableJournal");
    const rows = (
      await query(
        admin,
        "SELECT audit_id,actor_id,purpose_code,action_code,target_type,target_id,operation_id,encode(intent_digest,'hex') intent_digest,occurred_at,reason_code,retention_policy_code,retention_policy_version,chain_profile,chain_sequence::text sequence,CASE WHEN previous_record_hash IS NULL THEN NULL ELSE encode(previous_record_hash,'hex') END previous_hash,encode(record_hash,'hex') record_hash,recorded_at FROM platform_audit.platform_actor_audit_record WHERE actor_id=$1 AND purpose_code=$2 ORDER BY chain_sequence",
        [operatorReference, purposeCode],
      )
    ).rows;
    const chain = rows.map((r) => ({
      profile: r.chain_profile,
      sequence: Number(r.sequence),
      previousHash: r.previous_hash,
      recordHash: r.record_hash,
      recordedAt: r.recorded_at.toISOString(),
      content: {
        auditReference: r.audit_id,
        actorReference: r.actor_id,
        purposeCode: r.purpose_code,
        actionCode: r.action_code,
        targetType: r.target_type,
        targetReference: r.target_id,
        operationReference: r.operation_id,
        intentDigest: `sha256:${r.intent_digest}`,
        occurredAt: r.occurred_at.toISOString(),
        reasonCode: r.reason_code,
        retentionPolicyCode: r.retention_policy_code,
        retentionPolicyVersion: r.retention_policy_version,
      },
    }));
    assert(chain.length >= 7);
    assert.equal(verifyPlatformAuditChain(chain), true);
    const head = (
      await query(
        admin,
        "SELECT next_sequence::text sequence,encode(last_record_hash,'hex') hash FROM platform_audit.platform_actor_audit_chain_head WHERE actor_id=$1 AND purpose_code=$2",
        [operatorReference, purposeCode],
      )
    ).rows[0];
    assert.equal(head.sequence, String(chain.length + 1));
    assert.equal(head.hash, chain.at(-1).recordHash);
    const links = (
      await query(
        admin,
        "SELECT count(*)::int total,count(DISTINCT phase_operation_id)::int phases,count(DISTINCT audit_id)::int audits FROM bop_identity.workforce_onboarding_operation WHERE operator_id=$1",
        [operatorReference],
      )
    ).rows[0];
    assert.equal(links.total, links.phases);
    assert.equal(links.total, links.audits);
    await assert.rejects(
      query(
        admin,
        "UPDATE bop_identity.workforce_onboarding_operation SET state='Rejected' WHERE operator_id=$1",
        [operatorReference],
      ),
      { code: "23514" },
    );
    await assert.rejects(
      query(admin, "DELETE FROM bop_identity.workforce_onboarding_operation WHERE operator_id=$1", [
        operatorReference,
      ]),
      { code: "23514" },
    );
    // Test-admin has the primitive privilege, so this proves the owning statement
    // trigger rather than the separately asserted minimum-role ACL denial.
    await assert.rejects(query(admin, "TRUNCATE bop_identity.workforce_onboarding_operation"), {
      code: "23514",
    });
    assert.deepEqual(await counts(), beforeExpiredReplay);
  } catch {
    primaryFailure = new Error(
      `Workforce onboarding journal native failed at ${stage}; SQLSTATE=${sqlState}`,
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
    try {
      await admin.end();
    } catch {
      cleanupFailed = true;
    }
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailed) throw new Error("WORKFORCE_ONBOARDING_NATIVE_CLEANUP_UNAVAILABLE");
}
