import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import {
  appendPlatformAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
} from "../../bop/audit/src/index.ts";
import {
  createIdentityActor,
  createPostgresWorkforceInvitationStore,
  createPostgresWorkforceOnboardingInvitationSource,
  parseRawBrowserCredential,
} from "../../bop/identity/src/index.ts";

const denied = (error) => error?.code === "WORKFORCE_ONBOARDING_DENIED";
const purposeCode = "WORKFORCE_ONBOARDING";
/** Real005/032/034, owning consume and Audit on borrowed PostgreSQL transactions.
 * The consumed-OIDC holder and its target's fresh MFA remain controlled inputs;
 * this does not prove a signed callback, Cognito, delivery or role activation. */
export async function verifyWorkforceOnboardingInvitationSource(context, f) {
  const roles = [`onboard_read_${context.runId}`, `onboard_accept_${context.runId}`],
    passwords = roles.map(() => randomBytes(32).toString("hex")),
    clients = [],
    created = [];
  const query = f.query;
  let primaryFailure, cleanupFailure;
  const o = f.original(900),
    prepared = await f.transaction(o, (store) => store.prepare(o));
  assert(prepared.deliverySecret, "ACTUAL_NEW_INVITATION_SECRET_REQUIRED");
  const claimed = await f.transaction(o, (store) => store.claimDispatch(f.phaseRequest(o, 1)));
  const foundAt = new Date(Date.now() - 500).toISOString();
  const observed = await f.transaction(
    o,
    (store) =>
      store.recordInspection({
        ...f.phaseRequest(o, 2),
        observation: {
          profile: "CognitoWorkforceInvitationObservationV1",
          actorReference: o.actorReference,
          creationIntentDigest: prepared.record.intentDigest,
          emailDigest: o.emailDigest,
          observedAt: foundAt,
          validUntil: new Date(Date.parse(foundAt) + 5000).toISOString(),
          status: "Found",
          dispatchAccepted: null,
          provider: {
            username: `bop_${o.actorReference}`,
            subject: "controlled-native-reader-subject",
            status: "FORCE_CHANGE_PASSWORD",
            enabled: true,
            createdAt: claimed.record.dispatchStartedAt,
          },
        },
      }),
    { observedAt: foundAt },
  );
  assert.equal(observed.state, "ProviderObserved");
  const binding = Object.freeze({
    configuration: f.configuration,
    invitationReference: observed.invitationReference,
    originalIntentDigest: observed.intentDigest,
    selectorHash: observed.selectorHash,
  });
  const state = async () =>
    (
      await query(
        f.admin,
        `SELECT
    (SELECT jsonb_build_array(status,version,provider_evidence_id,consumed_at) FROM bop_identity.workforce_invitation WHERE invitation_id=$1) invitation,
    (SELECT count(*)::int FROM platform_audit.platform_actor_audit_record WHERE actor_id=$2 AND purpose_code=$3) audits,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(next_sequence,encode(last_record_hash,'hex'))),'[]'::jsonb) FROM platform_audit.platform_actor_audit_chain_head WHERE actor_id=$2 AND purpose_code=$3) heads`,
        [observed.invitationReference, o.actorReference, purposeCode],
      )
    ).rows[0];
  const host = async (connection, work, controls = {}) => {
    const guards = [],
      children = [],
      origin = new Date(Date.now() - 500).toISOString(),
      deadline = new Date(Date.parse(origin) + 5000).toISOString();
    const clock = { now: () => controls.now ?? origin };
    let live = true;
    const tx = Object.freeze({
      query(sql, values) {
        assert(live, "EXACT_LIVE_INVITATION_TRANSACTION_REQUIRED");
        return query(connection, sql, values);
      },
    });
    const register = async (actual, guard, final) => {
      assert.equal(actual, tx);
      guards.push({ guard, final });
    };
    const access =
      controls.secret === false
        ? {
            kind: "AuthorizationTransaction",
            authorizationTransactionReference: f.next(),
            async hold(actual, request) {
              assert.equal(actual, tx);
              if (controls.allowed === false) throw new Error("CONTROLLED_OIDC_BINDING_WITHDRAWN");
              return {
                authorizationTransactionReference: request.authorizationTransactionReference,
                binding: controls.binding ?? binding,
                consumedAt: origin,
                observedAt: request.observedAt,
                validUntil: request.validUntil,
              };
            },
          }
        : {
            kind: "Secret",
            secret: controls.wrongSecret
              ? parseRawBrowserCredential(randomBytes(32).toString("base64url"))
              : prepared.deliverySecret,
          };
    await query(connection, "BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await query(connection, "SET LOCAL statement_timeout='5s'");
      await query(connection, "SET LOCAL lock_timeout='2s'");
      const source = createPostgresWorkforceOnboardingInvitationSource({
        transaction: tx,
        configuration: controls.configuration ?? f.configuration,
        hasher: f.hasher,
        access,
        clock,
        originalObservedAt: origin,
        originalValidUntil: deadline,
        registerBeforeCommit: register,
      });
      const consume = async (evidence) => {
        const leafBinding = {
          operatorReference: o.actorReference,
          actorReference: o.actorReference,
          membershipReference: o.membershipReference,
          purposeCode,
          action: "AcceptInvitation",
          operationReference: f.next(),
          correlationReference: f.next(),
        };
        const operator = createIdentityActor({
          actorType: "User",
          actorReference: o.actorReference,
          accountKind: "Workforce",
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "RecentMfa",
          authenticatedAt: origin,
          recentMfaAt: origin,
        });
        const leaf = createPostgresWorkforceInvitationStore({
          transaction: tx,
          binding: leafBinding,
          clock,
          originalObservedAt: origin,
          originalValidUntil: deadline,
          authority: {
            async hold(actual, request) {
              assert.equal(actual, tx);
              assert.deepEqual(request.binding, leafBinding);
              return {
                binding: leafBinding,
                requestDigest: request.requestDigest,
                operator,
                validUntil: request.validUntil,
              };
            },
          },
          async appendAudit(actual, descriptor) {
            assert.equal(actual, tx);
            assert.equal(descriptor.operation, "InvitationAccepted");
            assert.equal(descriptor.actorReference, o.actorReference);
            assert.equal(descriptor.targetActorReference, o.actorReference);
            await tx.query(
              "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose',$2,true)",
              [o.actorReference, purposeCode],
            );
            await appendPlatformAuditRecordInTransaction(tx, {
              auditReference: f.next(),
              actorReference: o.actorReference,
              purposeCode,
              actionCode: "WORKFORCE_INVITATION_ACCEPTED",
              targetType: "WorkforceInvitation",
              targetReference: observed.invitationReference,
              operationReference: leafBinding.operationReference,
              intentDigest: `sha256:${sha256Hex(canonicalizeRfc8785({ invitationReference: evidence.invitation.invitationReference, originalIntentDigest: evidence.binding.originalIntentDigest, providerEvidenceReference }))}`,
              occurredAt: descriptor.occurredAt,
              reasonCode: o.reasonCode,
              retentionPolicyCode: "CONFIGURATION_AUDIT",
              retentionPolicyVersion: 1,
            });
          },
          registerBeforeCommit: register,
        });
        children.push(leaf);
        const providerEvidenceReference = f.next();
        return leaf.consumeInvitation({
          actorReference: o.actorReference,
          membershipReference: o.membershipReference,
          invitationReference: evidence.invitation.invitationReference,
          expectedVersion: 1,
          selectorHash: evidence.invitation.selectorHash,
          emailDigest: evidence.invitation.emailDigest,
          providerEvidenceReference,
          observedAt: origin,
        });
      };
      const result = await work({ source, consume, tx, origin, deadline });
      assert(guards.length > 0, "ACTUAL_INVITATION_READER_GUARD_REQUIRED");
      await controls.beforeCommit?.({ origin, deadline });
      for (const entry of guards) await entry.guard();
      await query(connection, "SET CONSTRAINTS ALL IMMEDIATE");
      for (const entry of guards) entry.final();
      await query(connection, "COMMIT");
      live = false;
      source.assertFinalized();
      for (const child of children) child.assertFinalized();
      return result;
    } catch (error) {
      try {
        await query(connection, "ROLLBACK");
      } catch {
        cleanupFailure = true;
      }
      live = false;
      throw error;
    }
  };
  try {
    f.mark("InvitationReaderMinimumPrivileges");
    for (let i = 0; i < roles.length; i++) {
      const role = roles[i];
      assert.match(role, /^[a-z][a-z0-9_]{0,62}$/u);
      await query(
        f.admin,
        `CREATE ROLE ${role} LOGIN PASSWORD '${passwords[i]}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
      );
      created.push(role);
      await query(f.admin, `GRANT USAGE ON SCHEMA bop_identity TO ${role}`);
      await query(
        f.admin,
        `GRANT EXECUTE ON FUNCTION bop_identity.workforce_onboarding_invitation_read(text,text,text,text) TO ${role}`,
      );
      if (i === 1) {
        await query(f.admin, `GRANT USAGE ON SCHEMA platform_audit,platform_helpers TO ${role}`);
        await query(
          f.admin,
          `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO ${role}`,
        );
        await query(
          f.admin,
          `GRANT SELECT,UPDATE(status,consumed_at,provider_evidence_id,version) ON bop_identity.workforce_invitation TO ${role}`,
        );
        await query(
          f.admin,
          `GRANT SELECT,INSERT ON platform_audit.platform_actor_audit_record TO ${role}`,
        );
        await query(
          f.admin,
          `GRANT SELECT,INSERT,UPDATE ON platform_audit.platform_actor_audit_chain_head TO ${role}`,
        );
      }
      const client = new pg.Client({ ...context.clientConfig, user: role, password: passwords[i] });
      clients.push(client);
      await client.connect();
    }
    const acl = (
      await query(
        f.admin,
        `SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,
      has_table_privilege($1,'bop_identity.workforce_invitation','SELECT') invitation_read,
      has_table_privilege($1,'bop_identity.workforce_invitation','UPDATE') invitation_update,
      has_table_privilege($1,'bop_identity.workforce_onboarding_operation','SELECT') journal_read,
      has_table_privilege($1,'bop_identity.workforce_onboarding_operation','INSERT') journal_write,
      has_table_privilege($1,'bop_identity.authentication_session','SELECT') session_read,
      has_table_privilege($1,'bop_membership.membership','INSERT') membership_write
      FROM pg_roles WHERE rolname=$1`,
        [roles[0]],
      )
    ).rows[0];
    assert.deepEqual(acl, {
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      invitation_read: false,
      invitation_update: false,
      journal_read: false,
      journal_write: false,
      session_read: false,
      membership_write: false,
    });
    await assert.rejects(
      query(clients[0], "SELECT selector_hash FROM bop_identity.workforce_invitation"),
      { code: "42501" },
    );
    await assert.rejects(
      query(clients[0], "SELECT snapshot_text FROM bop_identity.workforce_onboarding_operation"),
      { code: "42501" },
    );
    const baseline = await state();
    f.mark("InvitationReaderActualSecretAndOriginalScope");
    const evidence = await host(clients[0], async ({ source }) => source.hold());
    assert.deepEqual(evidence.record, observed);
    assert.deepEqual(evidence.binding, binding);
    assert.equal(evidence.invitation.status, "Pending");
    assert(!canonicalizeRfc8785(evidence).includes(prepared.deliverySecret));
    assert.deepEqual(await state(), baseline);
    f.mark("InvitationReaderWrongSecretConfigAndIntentDenied");
    await assert.rejects(
      host(clients[0], ({ source }) => source.hold(), { wrongSecret: true }),
      denied,
    );
    await assert.rejects(
      host(clients[0], ({ source }) => source.hold(), {
        configuration: { ...f.configuration, clientId: "otherclient" },
      }),
      denied,
    );
    await assert.rejects(
      host(clients[0], ({ source }) => source.hold(), {
        secret: false,
        binding: { ...binding, originalIntentDigest: `sha256:${"0".repeat(64)}` },
      }),
      denied,
    );
    assert.deepEqual(await state(), baseline);
    f.mark("InvitationReaderLateOidcWithdrawalRollsBackActualConsumeAndAudit");
    const late = {
      secret: false,
      allowed: true,
      beforeCommit: async () => {
        late.allowed = false;
      },
    };
    await assert.rejects(
      host(
        clients[1],
        async ({ source, consume }) => {
          const current = await source.hold();
          await source.handoffAccepted(await consume(current));
        },
        late,
      ),
      denied,
    );
    assert.deepEqual(await state(), baseline);
    f.mark("InvitationReaderCaughtBadHandoffCannotCommitActualConsume");
    let caught = false;
    await assert.rejects(
      host(
        clients[1],
        async ({ source, consume }) => {
          const current = await source.hold(),
            actual = await consume(current);
          try {
            await source.handoffAccepted({ ...actual, providerEvidenceReference: f.next() });
          } catch (error) {
            assert(denied(error));
            caught = true;
          }
        },
        { secret: false },
      ),
      denied,
    );
    assert(caught);
    assert.deepEqual(await state(), baseline);
    f.mark("InvitationReaderLateExpiryRollsBackActualConsumeAndAudit");
    const expired = {
      secret: false,
      beforeCommit: async ({ deadline }) => {
        expired.now = deadline;
      },
    };
    await assert.rejects(
      host(
        clients[1],
        async ({ source, consume }) => {
          const current = await source.hold();
          await source.handoffAccepted(await consume(current));
        },
        expired,
      ),
      denied,
    );
    assert.deepEqual(await state(), baseline);
    f.mark("InvitationReaderActualSameTransactionConsumeHandoffAndFinal");
    const accepted = await host(
      clients[1],
      async ({ source, consume }) => {
        const current = await source.hold(),
          saved = await consume(current);
        const handoff = await source.handoffAccepted(saved);
        assert.deepEqual(handoff.invitation, saved);
        return saved;
      },
      { secret: false },
    );
    assert.equal(accepted.status, "Accepted");
    const after = await state();
    assert.equal(after.invitation[0], "Accepted");
    assert.equal(after.invitation[1], 2);
    assert.equal(after.audits, baseline.audits + 1);
    f.mark("InvitationReaderHistoricalAcceptedCannotBeNewCallbackCapability");
    await assert.rejects(
      host(clients[0], ({ source }) => source.hold()),
      denied,
    );
    await assert.rejects(
      host(clients[0], ({ source }) => source.hold(), { secret: false }),
      denied,
    );
    assert.deepEqual(await state(), after);
  } catch (error) {
    primaryFailure = error;
  } finally {
    for (const client of clients) {
      try {
        await client.query("ROLLBACK");
      } catch {
        cleanupFailure = true;
      }
      try {
        await client.end();
      } catch {
        cleanupFailure = true;
      }
    }
    for (const role of created.reverse()) {
      try {
        await f.admin.query(`DROP OWNED BY ${role}`);
        await f.admin.query(`DROP ROLE ${role}`);
      } catch {
        cleanupFailure = true;
      }
    }
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailure) throw new Error("WORKFORCE_ONBOARDING_INVITATION_NATIVE_CLEANUP_UNAVAILABLE");
}
