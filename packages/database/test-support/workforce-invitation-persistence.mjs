import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import {
  createIdentityActor,
  createPostgresWorkforceInvitationStore,
} from "../../bop/identity/src/index.ts";

const id = (n) => `0190ed60-0050-7000-8000-${n.toString(16).padStart(12, "0")}`;
const denied = (error) => error?.code === "WORKFORCE_SECURITY_DENIED";

/** Actual production invitation writer, existing 005 table, direct minimum-role
 * connection and real transaction/guard ordering. Current onboarding authority,
 * Actor/MFA and Audit descriptor sink are controlled ports. No actual approval,
 * Provider enrollment/delivery, persisted Audit or complete onboarding is claimed. */
export async function verifyWorkforceInvitationPersistence(context) {
  const admin = new pg.Client(context.clientConfig),
    role = `invitation_native_${context.runId}`,
    password = randomBytes(32).toString("hex"),
    auditDescriptors = [];
  const origin = new Date(Date.now() - 1000).toISOString(),
    end = new Date(Date.parse(origin) + 5000).toISOString(),
    actor = id(1),
    inviter = id(2),
    member = id(3),
    selectorHash = "a".repeat(64),
    emailDigest = "b".repeat(64);
  let client,
    roleCreated = false,
    stage = "Setup",
    sqlState = "none",
    primaryFailure,
    cleanupFailed = false,
    failed = false;
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
  const rows = async () =>
    (
      await query(
        admin,
        "SELECT invitation_id::text,actor_id::text,membership_id::text,status,version,provider_evidence_id::text,consumed_at FROM bop_identity.workforce_invitation ORDER BY invitation_id",
      )
    ).rows;
  const command = (n = 10) => ({
    invitationReference: id(n),
    actorReference: actor,
    inviterActorReference: inviter,
    membershipReference: member,
    storeAssignmentReferences: [],
    emailDigest,
    selectorHash: n === 10 ? selectorHash : n.toString(16).padStart(64, "0"),
    observedAt: origin,
  });
  const pending = { selectorHash, emailDigest, actorReference: actor, membershipReference: member };
  const consume = {
    ...pending,
    invitationReference: id(10),
    expectedVersion: 1,
    providerEvidenceReference: id(20),
    observedAt: origin,
  };
  const make = (tx, action, controls, register) => {
    const binding = {
      operatorReference: action === "AcceptInvitation" ? (controls.actor ?? actor) : inviter,
      actorReference: controls.actor ?? actor,
      membershipReference: controls.member ?? member,
      purposeCode: "WORKFORCE_ONBOARDING",
      action,
      operationReference: id(30),
      correlationReference: id(31),
    };
    const operator = createIdentityActor({
      actorType: "User",
      actorReference: binding.operatorReference,
      accountKind: action === "AcceptInvitation" ? "Workforce" : "Platform",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "RecentMfa",
      authenticatedAt: origin,
      recentMfaAt: origin,
    });
    return createPostgresWorkforceInvitationStore({
      transaction: tx,
      binding,
      clock: { now: () => controls.now ?? origin },
      originalObservedAt: origin,
      originalValidUntil: end,
      authority: {
        async hold(actual, input) {
          assert.equal(actual, tx, "SAME_BORROWED_TRANSACTION_REQUIRED");
          assert.deepEqual(input.binding, binding);
          assert.match(input.requestDigest, /^sha256:[0-9a-f]{64}$/u);
          controls.authorityCalls = (controls.authorityCalls ?? 0) + 1;
          if (controls.allowed === false) throw new Error("CONTROLLED_AUTHORITY_WITHDRAWN");
          return {
            binding,
            requestDigest: input.requestDigest,
            operator,
            validUntil: input.validUntil,
          };
        },
      },
      async appendAudit(actual, descriptor) {
        assert.equal(actual, tx, "SAME_AUDIT_TRANSACTION_REQUIRED");
        assert.equal(descriptor.actorReference, binding.operatorReference);
        assert.equal(descriptor.targetActorReference, binding.actorReference);
        assert.equal(descriptor.idempotencyKey, binding.operationReference);
        assert.equal(descriptor.correlationId, binding.correlationReference);
        assert.equal(descriptor.purposeCode, binding.purposeCode);
        assert.equal(descriptor.occurredAt, origin);
        auditDescriptors.push(descriptor);
      },
      registerBeforeCommit: register,
    });
  };
  const transaction = async (action, work, controls = {}) => {
    const guards = [],
      tx = Object.freeze({ query: (sql, values) => query(client, sql, values) });
    await query(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await query(client, "SET LOCAL statement_timeout='5s'");
      await query(client, "SET LOCAL lock_timeout='2s'");
      const store = make(tx, action, controls, async (actual, guard, final) => {
        assert.equal(actual, tx);
        guards.push({ guard, final });
      });
      const result = await work(store);
      assert.equal(guards.length, 1, "REAL_HOST_GUARD_REQUIRED");
      await controls.beforeCommit?.();
      for (const entry of guards) await entry.guard();
      for (const entry of guards) entry.final();
      await query(client, "COMMIT");
      store.assertFinalized();
      return result;
    } catch (error) {
      await query(client, "ROLLBACK");
      throw error;
    }
  };
  await admin.connect();
  try {
    assert.match(role, /^[a-z][a-z0-9_]{0,62}$/u);
    await query(
      admin,
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
    );
    roleCreated = true;
    await query(admin, `GRANT USAGE ON SCHEMA bop_identity,platform_helpers TO ${role}`);
    // This precise primitive is required by the existing UUIDv7 column domain.
    await query(admin, `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO ${role}`);
    await query(
      admin,
      `GRANT SELECT,INSERT,UPDATE(status,consumed_at,provider_evidence_id,version) ON bop_identity.workforce_invitation TO ${role}`,
    );
    client = new pg.Client({ ...context.clientConfig, user: role, password });
    await client.connect();
    const acl = (
      await query(
        admin,
        `SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,
      has_table_privilege($1,'bop_identity.workforce_invitation','UPDATE') full_update,
      has_table_privilege($1,'bop_identity.workforce_invitation','DELETE') delete_allowed,
      has_column_privilege($1,'bop_identity.workforce_invitation','actor_id','UPDATE') actor_update,
      has_column_privilege($1,'bop_identity.workforce_invitation','selector_hash','UPDATE') selector_update,
      has_table_privilege($1,'bop_identity.authentication_session','SELECT') session_read,
      has_table_privilege($1,'bop_membership.membership','INSERT') member_write,
      (SELECT pg_get_userbyid(relowner)=$1 FROM pg_class WHERE oid='bop_identity.workforce_invitation'::regclass) table_owner
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
      selector_update: false,
      session_read: false,
      member_write: false,
      table_owner: false,
    });
    assert.equal((await query(client, "SELECT current_user AS principal")).rows[0].principal, role);
    assert.deepEqual(await rows(), []);

    mark("AutocommitRefusesBeforeWrite");
    const autocommit = Object.freeze({ query: (sql, values) => query(client, sql, values) });
    const unsafe = make(autocommit, "IssueInvitation", {}, async () => undefined);
    await assert.rejects(unsafe.createInvitation(command()), denied);
    assert.deepEqual(await rows(), []);
    assert.equal(auditDescriptors.length, 0);

    mark("CreateAndReadPending");
    const created = await transaction("IssueInvitation", (store) =>
      store.createInvitation(command()),
    );
    assert.equal(created.status, "Pending");
    assert.equal(created.version, 1);
    assert.equal(Date.parse(created.expiresAt) - Date.parse(created.createdAt), 86400000);
    assert.deepEqual(created.storeAssignmentReferences, []);
    assert.equal(auditDescriptors.length, 1);
    assert.equal(auditDescriptors[0].operation, "InvitationIssued");
    const found = await transaction("AcceptInvitation", (store) => store.readPending(pending));
    assert.deepEqual(found, created);
    const baseline = await rows();
    assert.equal(baseline.length, 1);
    const auditsBeforeRead = auditDescriptors.length;

    mark("WrongScopeAndEmailCannotReadOrConsume");
    assert.equal(
      await transaction("AcceptInvitation", (store) =>
        store.readPending({ ...pending, emailDigest: "c".repeat(64) }),
      ),
      null,
    );
    assert.equal(
      await transaction(
        "AcceptInvitation",
        (store) =>
          store.readPending({ ...pending, actorReference: id(40), membershipReference: id(41) }),
        { actor: id(40), member: id(41) },
      ),
      null,
    );
    await assert.rejects(
      transaction(
        "AcceptInvitation",
        (store) =>
          store.consumeInvitation({
            ...consume,
            actorReference: id(40),
            membershipReference: id(41),
          }),
        { actor: id(40), member: id(41) },
      ),
      denied,
    );
    await assert.rejects(
      transaction("AcceptInvitation", (store) =>
        store.readPending({ ...pending, actorReference: id(40) }),
      ),
      denied,
    );
    assert.deepEqual(await rows(), baseline);
    assert.equal(auditDescriptors.length, auditsBeforeRead);

    mark("LateAuthorityRollsBackActualConsumption");
    const late = { allowed: true };
    late.beforeCommit = async () => {
      late.allowed = false;
    };
    await assert.rejects(
      transaction("AcceptInvitation", (store) => store.consumeInvitation(consume), late),
      denied,
    );
    assert(late.authorityCalls >= 4, "ACTUAL_LATE_AUTHORITY_CHECK_REQUIRED");
    assert.equal(auditDescriptors.at(-1).operation, "InvitationAccepted");
    assert.deepEqual(await rows(), baseline);

    mark("ConsumeExactlyOnce");
    const accepted = await transaction("AcceptInvitation", (store) =>
      store.consumeInvitation(consume),
    );
    assert.equal(accepted.status, "Accepted");
    assert.equal(accepted.version, 2);
    assert.equal(accepted.providerEvidenceReference, consume.providerEvidenceReference);
    assert.equal(accepted.consumedAt, origin);
    const committed = await rows(),
      beforeReplayAudit = auditDescriptors.length;
    assert.equal(committed[0].status, "Accepted");
    assert.equal(committed[0].version, 2);
    assert.equal(committed[0].provider_evidence_id, consume.providerEvidenceReference);
    await assert.rejects(
      transaction("AcceptInvitation", (store) => store.consumeInvitation(consume)),
      denied,
    );
    assert.equal(
      await transaction("AcceptInvitation", (store) => store.readPending(pending)),
      null,
    );
    assert.deepEqual(await rows(), committed);
    assert.equal(auditDescriptors.length, beforeReplayAudit);

    mark("CaughtPoisonCannotCommitEarlierInsert");
    let caught = false;
    await assert.rejects(
      transaction("IssueInvitation", async (store) => {
        await store.createInvitation(command(11));
        try {
          await store.readPending({ ...pending, actorReference: id(40) });
        } catch (error) {
          assert(denied(error));
          caught = true;
        }
        return "caller swallowed the refusal";
      }),
      denied,
    );
    assert(caught, "CAUGHT_OWNER_REFUSAL_REQUIRED");
    assert.deepEqual(await rows(), committed);
  } catch {
    failed = true;
    primaryFailure = new Error(
      `Workforce invitation native failed at ${stage}; SQLSTATE=${sqlState}`,
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
  if (failed) throw primaryFailure;
  if (cleanupFailed) throw new Error("WORKFORCE_INVITATION_NATIVE_CLEANUP_UNAVAILABLE");
}
