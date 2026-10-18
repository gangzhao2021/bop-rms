import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import {
  createIdentityActor,
  createPostgresWorkforceInvitationStore,
  createPostgresWorkforceAccountBindingAcceptanceWriter,
  createPostgresWorkforceAuthenticationSource,
  parseWorkforceAccountBindingAcceptanceCommand,
  parseWorkforceAccountBindingCommand,
  workforceAccountBindingOriginal,
  workforceAccountBindingIntent,
  workforceAccountBindingCodec,
  buildWorkforceAccountBinding,
} from "../../bop/identity/src/index.ts";
import {
  appendPlatformAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
} from "../../bop/audit/src/index.ts";
const id = (n) => `0190ed60-0061-7000-8000-${n.toString(16).padStart(12, "0")}`;

/** Real invitation consume, binding, immutable Audit, RLS and COMMIT. Original
 * independent approval and intended target's signed-callback/TOTP origin are
 * controlled authority boundaries here; no signed callback/UI completion is claimed.
 * The existing fixture controls only the outbound Cognito SDK boundary. */
export async function verifyWorkforceAccountBindingAcceptance(
  context,
  { fixture: f, workforce, importerTransactions },
) {
  f.mark("Invitation acceptance binding minimum-role setup");
  const role = `binding_accept_${context.runId}`,
    password = randomBytes(32).toString("hex");
  assert.match(role, /^[a-z][a-z0-9_]{0,62}$/u);
  await f.admin.query(
    `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
  );
  f.extraRoles.push(role);
  await f.admin.query(
    `GRANT USAGE ON SCHEMA bop_identity,platform_audit,platform_helpers TO ${role}`,
  );
  await f.admin.query(
    `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),bop_identity.workforce_account_binding_import_capable(),bop_identity.workforce_account_binding_acceptance_admit(uuid,uuid,uuid,text),bop_identity.workforce_account_binding_read(uuid,text,text,text),bop_identity.workforce_account_invitation_read(uuid,uuid),platform_audit.matches_workforce_account_binding_audit(uuid,uuid,text,uuid,uuid,text,timestamptz,text) TO ${role}`,
  );
  await f.admin.query(
    `GRANT INSERT,SELECT(snapshot_text,source_digest,recorded_by,operation_id) ON bop_identity.workforce_account_binding TO ${role}`,
  );
  await f.admin.query(
    `GRANT SELECT,INSERT,UPDATE(status,consumed_at,provider_evidence_id,version) ON bop_identity.workforce_invitation TO ${role}`,
  );
  await f.admin.query(
    `GRANT SELECT,INSERT ON platform_audit.platform_actor_audit_record TO ${role}`,
  );
  await f.admin.query(
    `GRANT SELECT,INSERT,UPDATE ON platform_audit.platform_actor_audit_chain_head TO ${role}`,
  );
  const privileges = (
    await f.admin.query(
      `SELECT has_function_privilege($1,'bop_identity.workforce_account_binding_import_admit(uuid,uuid,uuid,text)','EXECUTE') importer,has_function_privilege($1,'bop_identity.workforce_account_binding_acceptance_admit(uuid,uuid,uuid,text)','EXECUTE') acceptance`,
      [role],
    )
  ).rows[0];
  assert.deepEqual(privileges, { importer: false, acceptance: true });
  let sequence = 1000,
    allocations = 0;
  const next = () => {
    allocations++;
    return id(sequence++);
  };
  const transact = async (work, beforeGuard) => {
    const client = new pg.Client({ ...context.clientConfig, user: role, password });
    await client.connect();
    f.clients.add(client);
    let primaryFailure, answer;
    const guards = [],
      sources = [],
      tx = Object.freeze({ query: (sql, values = []) => client.query(sql, [...values]) });
    const register = async (actual, guard, final) => {
      assert.equal(actual, tx);
      guards.push({ guard, final });
    };
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL statement_timeout='5s'");
      answer = await work(tx, register, sources);
      await beforeGuard?.();
      for (const entry of guards) await entry.guard();
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      for (const entry of guards) entry.final();
      await client.query("COMMIT");
      for (const source of sources) source.assertFinalized();
    } catch (error) {
      primaryFailure = error;
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        primaryFailure = new AggregateError([error, rollbackError], "Acceptance rollback failed");
      }
    }
    f.clients.delete(client);
    try {
      await client.end();
    } catch (cleanupError) {
      if (primaryFailure)
        throw new AggregateError([primaryFailure, cleanupError], "Acceptance cleanup failed", {
          cause: cleanupError,
        });
      throw cleanupError;
    }
    if (primaryFailure) throw primaryFailure;
    return answer;
  };
  const instant = () => f.state.now,
    end = () => new Date(Date.parse(instant()) + 5000).toISOString();
  const actor = (reference) =>
    createIdentityActor({
      actorType: "User",
      actorReference: reference,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "RecentMfa",
      authenticatedAt: instant(),
      recentMfaAt: instant(),
    });
  const make = (n) => ({
    actorReference: id(n),
    invitationReference: id(n + 1),
    membershipReference: id(n + 2),
    providerEvidenceReference: id(n + 3),
    operationReference: id(n + 4),
    subject: `opaque-native-workforce-acceptance-${n}`,
    selectorHash: randomBytes(32).toString("hex"),
    emailDigest: randomBytes(32).toString("hex"),
  });
  const controls = { allowed: true };
  const invite = (tx, register, p, action, original) => {
    const binding = {
      operatorReference: p.actorReference,
      actorReference: p.actorReference,
      membershipReference: p.membershipReference,
      purposeCode: "WORKFORCE_ONBOARDING",
      action,
      operationReference: action === "IssueInvitation" ? id(sequence++) : p.operationReference,
      correlationReference: id(sequence++),
    };
    return createPostgresWorkforceInvitationStore({
      transaction: tx,
      binding,
      clock: f.clock,
      originalObservedAt: original,
      originalValidUntil: new Date(Date.parse(original) + 5000).toISOString(),
      authority: {
        async hold(actual, input) {
          assert.equal(actual, tx);
          assert.deepEqual(input.binding, binding);
          if (!controls.allowed) throw new Error("CONTROLLED_APPROVAL_WITHDRAWN");
          return {
            binding,
            requestDigest: input.requestDigest,
            operator: actor(p.actorReference),
            validUntil: input.validUntil,
          };
        },
      },
      async appendAudit(actual, descriptor) {
        assert.equal(actual, tx);
        await tx.query(
          "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose',$2,true)",
          [descriptor.actorReference, descriptor.purposeCode],
        );
        await appendPlatformAuditRecordInTransaction(tx, {
          auditReference: next(),
          actorReference: descriptor.actorReference,
          purposeCode: descriptor.purposeCode,
          actionCode:
            descriptor.operation === "InvitationIssued"
              ? "WORKFORCE_INVITATION_ISSUED"
              : "WORKFORCE_INVITATION_ACCEPTED",
          targetType: "WorkforceInvitation",
          targetReference: p.invitationReference,
          operationReference: descriptor.idempotencyKey,
          intentDigest: `sha256:${sha256Hex(canonicalizeRfc8785(descriptor))}`,
          occurredAt: descriptor.occurredAt,
          reasonCode: "CONTROLLED_ONBOARDING_AUTHORITY",
          retentionPolicyCode: "CONFIGURATION_AUDIT",
          retentionPolicyVersion: 1,
        });
        // Complete this actual Actor/purpose chain before another owning source
        // installs its purpose GUC. These checks do not commit either effect.
        await tx.query(
          "SET CONSTRAINTS platform_audit.platform_actor_audit_record_complete IMMEDIATE",
          [],
        );
        await tx.query(
          "SET CONSTRAINTS platform_audit.platform_actor_audit_record_complete DEFERRED",
          [],
        );
      },
      registerBeforeCommit: register,
    });
  };
  const issue = (p) =>
    transact(async (tx, register, sources) => {
      const origin = instant(),
        source = invite(tx, register, p, "IssueInvitation", origin);
      sources.push(source);
      return source.createInvitation({
        invitationReference: p.invitationReference,
        actorReference: p.actorReference,
        inviterActorReference: p.actorReference,
        membershipReference: p.membershipReference,
        storeAssignmentReferences: [],
        emailDigest: p.emailDigest,
        selectorHash: p.selectorHash,
        observedAt: origin,
      });
    });
  const command = (p) =>
    parseWorkforceAccountBindingAcceptanceCommand({
      profile: "WorkforceAccountBindingAcceptanceV1",
      operationReference: p.operationReference,
      actorReference: p.actorReference,
      subject: p.subject,
      invitationReference: p.invitationReference,
      originalMembershipReference: p.membershipReference,
      providerEvidenceReference: p.providerEvidenceReference,
      recordedByReference: p.actorReference,
      approvedByReference: id(900),
      approvalEvidenceReference: id(901),
      reasonCode: "ACCEPT_APPROVED_WORKFORCE_INVITATION",
    });
  const writer = (tx, register, sources, p, origin) => {
    const source = createPostgresWorkforceAccountBindingAcceptanceWriter({
      transaction: tx,
      configuration: workforce.configuration,
      operatorReference: p.actorReference,
      provisioningRoleName: role,
      clock: f.clock,
      hasher: workforce.hasher,
      envelopes: workforce.envelopes,
      originalObservedAt: origin,
      originalValidUntil: new Date(Date.parse(origin) + 5000).toISOString(),
      authority: {
        async hold(actual, input) {
          assert.equal(actual, tx);
          assert.deepEqual(input.command, command(p));
          assert.match(input.intentDigest, /^sha256:[a-f0-9]{64}$/u);
          if (!controls.allowed) throw new Error("CONTROLLED_CALLBACK_AUTHORITY_WITHDRAWN");
          return {
            operator: actor(p.actorReference),
            approvedByReference: id(900),
            approvalEvidenceReference: id(901),
            validUntil: input.validUntil,
            authorizationTransactionReference: id(902),
            invitationReference: p.invitationReference,
            originalOnboardingIntentDigest: `sha256:${"c".repeat(64)}`,
          };
        },
      },
      nextReference: next,
      appendAudit: appendPlatformAuditRecordInTransaction,
      registerBeforeCommit: register,
    });
    sources.push(source);
    return source;
  };
  const accept = (p, beforeGuard) =>
    transact(async (tx, register, sources) => {
      const origin = instant(),
        source = invite(tx, register, p, "AcceptInvitation", origin);
      sources.push(source);
      await source.consumeInvitation({
        selectorHash: p.selectorHash,
        emailDigest: p.emailDigest,
        actorReference: p.actorReference,
        membershipReference: p.membershipReference,
        invitationReference: p.invitationReference,
        expectedVersion: 1,
        providerEvidenceReference: p.providerEvidenceReference,
        observedAt: origin,
      });
      return writer(tx, register, sources, p, origin).accept(command(p));
    }, beforeGuard);
  const databaseState = async (p) =>
    (
      await f.admin.query(
        `SELECT
    (SELECT status FROM bop_identity.workforce_invitation WHERE invitation_id=$1) status,
    (SELECT version FROM bop_identity.workforce_invitation WHERE invitation_id=$1) version,
    (SELECT count(*)::int FROM bop_identity.workforce_account_binding WHERE actor_id=$2) bindings,
    (SELECT count(*)::int FROM platform_audit.platform_actor_audit_record WHERE actor_id=$2 AND action_code IN ('WORKFORCE_ACCOUNT_BOUND','WORKFORCE_INVITATION_ACCEPTED')) audits`,
        [p.invitationReference, p.actorReference],
      )
    ).rows[0];
  f.mark("Actual Pending invitation consume and Acceptance binding one transaction");
  const p = make(100),
    pending = await issue(p);
  assert.equal(pending.status, "Pending");
  const binding = await accept(p);
  assert.deepEqual(await databaseState(p), {
    status: "Accepted",
    version: 2,
    bindings: 1,
    audits: 2,
  });
  assert.equal(binding.originalCommand.profile, "WorkforceAccountBindingAcceptanceV1");
  assert.equal(binding.recordedByReference, p.actorReference);
  assert.equal(canonicalizeRfc8785(binding).includes(p.subject), false);
  const before = allocations;
  assert.deepEqual(
    await transact(async (tx, register, sources) =>
      writer(tx, register, sources, p, instant()).accept(command(p)),
    ),
    binding,
  );
  assert.equal(allocations, before);
  assert.deepEqual(await databaseState(p), {
    status: "Accepted",
    version: 2,
    bindings: 1,
    audits: 2,
  });
  f.mark("Actual late callback withdrawal rolls back invitation, binding and both Audit effects");
  const q = make(200);
  await issue(q);
  await assert.rejects(
    accept(q, () => {
      controls.allowed = false;
    }),
  );
  controls.allowed = true;
  assert.deepEqual(await databaseState(q), {
    status: "Pending",
    version: 1,
    bindings: 0,
    audits: 0,
  });
  f.mark("Original runtime grants read Acceptance source without any new privilege");
  const readSources = [],
    entries = [];
  await f.transactions.run(async (tx) => {
    const origin = instant(),
      source = createPostgresWorkforceAuthenticationSource({
        transaction: tx,
        configuration: workforce.configuration,
        hasher: workforce.hasher,
        envelopes: workforce.envelopes,
        clock: f.clock,
        originalObservedAt: origin,
        originalValidUntil: end(),
        registerBeforeCommit: async (actual, guard, final) => {
          assert.equal(actual, tx);
          entries.push({ guard, final });
        },
      });
    readSources.push(source);
    const actual = await source.resolveVerifiedSubject({
      issuer: workforce.configuration.issuer,
      clientId: workforce.configuration.clientIds[0],
      subject: p.subject,
      authenticatedAt: origin,
      observedAt: origin,
    });
    assert.equal(actual.actorReference, p.actorReference);
    assert.equal(actual.verificationLevel, "SingleFactor");
    for (const entry of entries) await entry.guard();
    for (const entry of entries) entry.final();
  });
  for (const source of readSources) source.assertFinalized();
  const insert = async (tx, b) => {
    await tx.query(
      "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose','WORKFORCE_ACCOUNT_BINDING',true),set_config('bop.workforce_account_environment',$2,true),set_config('bop.workforce_account_issuer',$3,true),set_config('bop.workforce_account_actor_id',$4,true),set_config('bop.workforce_account_subject_hash',$5,true),set_config('bop.workforce_account_purpose','WORKFORCE_ACCOUNT_BINDING',true)",
      [
        b.recordedByReference,
        b.configuration.environment,
        b.configuration.issuer,
        b.actorReference,
        b.subjectHash,
      ],
    );
    await tx.query(
      `INSERT INTO bop_identity.workforce_account_binding(actor_id,environment,issuer,subject_hash,invitation_id,original_membership_id,provider_evidence_id,operation_id,recorded_by,approved_by,approval_id,reason_code,intent_digest,audit_id,recorded_at,source_digest,snapshot_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        b.actorReference,
        b.configuration.environment,
        b.configuration.issuer,
        b.subjectHash,
        b.invitationReference,
        b.originalMembershipReference,
        b.providerEvidenceReference,
        b.operationReference,
        b.recordedByReference,
        b.approvedByReference,
        b.approvalEvidenceReference,
        b.reasonCode,
        b.intentDigest,
        b.auditReference,
        b.recordedAt,
        b.sourceDigest,
        canonicalizeRfc8785(b),
      ],
    );
  };
  f.mark("Actual writer roles refuse the other immutable origin before duplicate row constraints");
  await assert.rejects(
    importerTransactions.run((tx) => insert(tx, binding)),
    (error) => error.code === "23514" || error.code === "42501",
  );
  const imported = parseWorkforceAccountBindingCommand({
      ...command(p),
      profile: "WorkforceAccountBindingImportV1",
    }),
    original = workforceAccountBindingOriginal(imported, binding.subjectHash),
    { sourceDigest, ...body } = binding;
  void sourceDigest;
  const forgedImport = buildWorkforceAccountBinding(
    {
      ...body,
      originalCommand: original,
      intentDigest: workforceAccountBindingIntent(
        workforce.configuration,
        original,
        workforceAccountBindingCodec,
      ),
    },
    workforceAccountBindingCodec,
  );
  await assert.rejects(
    transact((tx) => insert(tx, forgedImport)),
    (error) => error.code === "23514" || error.code === "42501",
  );
  assert.deepEqual(await databaseState(p), {
    status: "Accepted",
    version: 2,
    bindings: 1,
    audits: 2,
  });
}
