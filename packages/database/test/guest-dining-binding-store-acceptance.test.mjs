import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createGuestSessionRecord,
  createPostgresGuestSessionEntryStore,
  createPostgresGuestDiningBindingStore,
  prepareGuestDiningBinding,
} from "../../bop/identity/src/index.ts";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => `018f5300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const hash = (n) => n.toString(16).padStart(64, "0");
const at = (seconds) =>
  new Date(Date.parse("2026-09-08T12:00:00.000Z") + seconds * 1000).toISOString();
const scope = { brandReference: id(2), storeReference: id(3) };
const equals = (a, b) => a === b;

function fixture(base) {
  const predecessor = createGuestSessionRecord({
    session: {
      sessionReference: id(base),
      status: "Active",
      version: 1,
      ...scope,
      publicStoreReference: id(4),
      publicTableReference: id(40),
      channel: "DineIn",
      locale: "en-CA",
      qrReference: id(5),
      qrRevocationVersion: 1,
      diningState: "ContextOnly",
      diningSessionReference: null,
      diningParticipantReference: null,
      createdAt: at(-60),
      lastSeenAt: at(-60),
      idleExpiresAt: at(14340),
      absoluteExpiresAt: at(86340),
      orderClosedAt: null,
      closureExpiresAt: null,
      rotatedFromGuestSessionReference: null,
      revocationReason: null,
      revokedAt: null,
    },
    sessionSelectorHash: hash(base),
    csrfSelectorHash: hash(base + 1),
    operationReference: id(base + 2),
    operationIntentHash: hash(base + 2),
  });
  const candidate = createGuestSessionRecord({
    ...predecessor,
    session: {
      ...predecessor.session,
      sessionReference: id(base + 3),
      diningState: "DiningBound",
      diningSessionReference: id(base + 20),
      diningParticipantReference: id(base + 21),
      createdAt: at(0),
      lastSeenAt: at(0),
      idleExpiresAt: at(14400),
      absoluteExpiresAt: at(86400),
      rotatedFromGuestSessionReference: id(base),
    },
    sessionSelectorHash: hash(base + 3),
    csrfSelectorHash: hash(base + 4),
    operationReference: id(base + 5),
    operationIntentHash: hash(base + 5),
  });
  const preparation = prepareGuestDiningBinding({
    operationReference: id(base + 5),
    admissionReference: id(base + 6),
    predecessor,
    candidate,
    recoverySelectorHash: hash(base + 7),
    preparedAt: at(0),
    expiresAt: at(300),
  });
  const proof = {
    sessionSelectorHash: candidate.sessionSelectorHash,
    csrfSelectorHash: candidate.csrfSelectorHash,
    recoverySelectorHash: hash(base + 7),
  };
  const acknowledge = {
    operationReference: preparation.operationReference,
    currentSelectorHash: predecessor.sessionSelectorHash,
    proof,
    observedAt: at(1),
  };
  const activate = {
    ...acknowledge,
    observedAt: at(3),
    ownerEvidence: {
      guestSessionReference: predecessor.session.sessionReference,
      decision: "Allowed",
      operationReference: preparation.operationReference,
      admissionReference: preparation.admissionReference,
      storeReference: scope.storeReference,
      publicTableReference: predecessor.session.publicTableReference,
      diningSessionReference: candidate.session.diningSessionReference,
      diningParticipantReference: candidate.session.diningParticipantReference,
      evaluatedAt: at(2),
      validUntil: at(300),
    },
  };
  const complete = {
    operationReference: preparation.operationReference,
    sessionSelectorHash: proof.sessionSelectorHash,
    csrfSelectorHash: proof.csrfSelectorHash,
    observedAt: at(4),
  };
  return { preparation, predecessor, candidate, proof, acknowledge, activate, complete };
}

it("atomically persists Dining credential delivery, activation, Audit and response-loss continuation", async () => {
  await withIsolatedDatabase({ caseId: "wp2295_binding" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2295_${context.runId}`;
    assert.match(role, /^wp2295_[a-f0-9]+$/u);
    let active = 0;
    let auditId = 1000;
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(
        `GRANT USAGE ON SCHEMA bop_identity,platform_helpers,platform_audit TO ${role}`,
      );
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT,INSERT ON bop_identity.guest_session,bop_identity.guest_session_operation,bop_identity.guest_dining_binding_preparation,platform_audit.audit_record TO ${role}`,
      );
      await admin.query(
        `GRANT UPDATE (status,revocation_reason,revoked_at,version) ON bop_identity.guest_session TO ${role}`,
      );
      await admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
      function runner({ failAudit = false, loseAck = false, readOnly = false } = {}) {
        return {
          async run(action) {
            const client = new Client({
              ...context.clientConfig,
              query_timeout: 5000,
              connectionTimeoutMillis: 2000,
            });
            await client.connect();
            active++;
            let committed = false;
            try {
              await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
              await client.query(`SET LOCAL ROLE ${role}`);
              await client.query("SET LOCAL lock_timeout='5s'");
              await client.query("SET LOCAL statement_timeout='5s'");
              const value = await action({
                async query(sql, values) {
                  if (failAudit && sql.startsWith("UPDATE platform_audit.audit_chain_head"))
                    throw new Error("synthetic audit failure");
                  return client.query(sql, [...values]);
                },
              });
              await client.query("COMMIT");
              committed = true;
              const cleared = await client.query(
                "SELECT current_setting('bop.brand_id',true) AS brand,current_setting('bop.store_id',true) AS store",
              );
              assert.ok([null, ""].includes(cleared.rows[0].brand));
              assert.ok([null, ""].includes(cleared.rows[0].store));
              if (loseAck) throw new Error("synthetic lost acknowledgement");
              return value;
            } catch (error) {
              if (!committed) await client.query("ROLLBACK");
              throw error;
            } finally {
              await client.end();
              active--;
            }
          },
        };
      }
      const audit = {
        async append(tx, descriptor) {
          await appendAuditRecordInTransaction(tx, {
            auditId: id(auditId++),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "System" },
            actionCode: `IDENTITY_GUEST_DINING_BINDING_${descriptor.action.toUpperCase()}`,
            targetType: "GuestDiningBindingPreparation",
            targetId: descriptor.operationReference,
            reasonCode: "AUTHORIZED_GUEST_BINDING",
            correlationId: id(999),
            occurredAt: descriptor.occurredAt,
            sourceChannel: "CUSTOMER_PWA",
            dataClassification: "Restricted",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          });
        },
      };
      const store = createPostgresGuestDiningBindingStore(runner(), scope, audit, equals);
      const sessions = createPostgresGuestSessionEntryStore(runner(), scope);
      const count = async (table) => {
        assert.ok(
          ["bop_identity.guest_dining_binding_preparation", "platform_audit.audit_record"].includes(
            table,
          ),
        );
        return Number((await admin.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
      };
      const f = fixture(100);
      await sessions.create({ record: f.predecessor });
      await store.prepare(f.preparation, at(0));
      await store.prepare(f.preparation, at(1));
      assert.equal(await sessions.resolve(f.candidate.sessionSelectorHash), null);
      assert.equal(await count("bop_identity.guest_dining_binding_preparation"), 1);
      assert.equal(await count("platform_audit.audit_record"), 1);
      await assert.rejects(store.activate(f.activate), { code: "GUEST_SESSION_UNAVAILABLE" });
      await assert.rejects(
        store.acknowledge({
          ...f.acknowledge,
          proof: { ...f.proof, recoverySelectorHash: hash(999) },
        }),
        { code: "GUEST_SESSION_UNAVAILABLE" },
      );
      await assert.rejects(store.acknowledge({ ...f.acknowledge, observedAt: at(300) }), {
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      await store.acknowledge(f.acknowledge);
      await store.acknowledge({ ...f.acknowledge, observedAt: at(2) });
      assert.equal(await count("bop_identity.guest_dining_binding_preparation"), 2);
      await assert.rejects(
        store.activate({
          ...f.activate,
          ownerEvidence: { ...f.activate.ownerEvidence, storeReference: id(90) },
        }),
        { code: "GUEST_SESSION_UNAVAILABLE" },
      );
      for (const key of [
        "guestSessionReference",
        "admissionReference",
        "operationReference",
        "publicTableReference",
        "diningSessionReference",
        "diningParticipantReference",
      ]) {
        await assert.rejects(
          store.activate({
            ...f.activate,
            ownerEvidence: { ...f.activate.ownerEvidence, [key]: id(90) },
          }),
          { code: "GUEST_SESSION_UNAVAILABLE" },
        );
      }
      for (const change of [
        { evaluatedAt: at(0) },
        { evaluatedAt: at(4) },
        { validUntil: at(3) },
      ]) {
        await assert.rejects(
          store.activate({
            ...f.activate,
            ownerEvidence: { ...f.activate.ownerEvidence, ...change },
          }),
          { code: "GUEST_SESSION_UNAVAILABLE" },
        );
      }
      assert.equal(await count("bop_identity.guest_dining_binding_preparation"), 2);
      assert.equal(await count("platform_audit.audit_record"), 2);
      const race = await Promise.allSettled([
        store.activate(f.activate),
        store.activate(f.activate),
      ]);
      assert.equal(race.filter((value) => value.status === "fulfilled").length, 1);
      assert.equal(race.filter((value) => value.status === "rejected").length, 1);
      assert.equal(
        (await sessions.resolve(f.predecessor.sessionSelectorHash)).session.status,
        "Revoked",
      );
      assert.deepEqual(await sessions.resolve(f.candidate.sessionSelectorHash), f.candidate);
      assert.equal(await count("bop_identity.guest_dining_binding_preparation"), 3);
      assert.equal(await count("platform_audit.audit_record"), 3);
      assert.equal(
        (await store.complete(f.complete)).sessionReference,
        f.candidate.session.sessionReference,
      );
      await assert.rejects(store.activate(f.activate), { code: "GUEST_SESSION_UNAVAILABLE" });
      await assert.rejects(
        store.complete({ ...f.complete, sessionSelectorHash: f.predecessor.sessionSelectorHash }),
        { code: "GUEST_SESSION_UNAVAILABLE" },
      );
      const foreign = createPostgresGuestDiningBindingStore(
        runner(),
        { ...scope, storeReference: id(90) },
        audit,
        equals,
      );
      await assert.rejects(foreign.complete(f.complete), { code: "GUEST_SESSION_UNAVAILABLE" });
      await runner().run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, id(90)],
        );
        assert.equal(
          (await tx.query("SELECT record FROM bop_identity.guest_dining_binding_preparation", []))
            .rows.length,
          0,
        );
      });
      await assert.rejects(
        admin.query("UPDATE bop_identity.guest_dining_binding_preparation SET status=status"),
        { code: "55000" },
      );
      await assert.rejects(
        admin.query("DELETE FROM bop_identity.guest_dining_binding_preparation"),
        {
          code: "55000",
        },
      );
      await assert.rejects(
        admin.query("TRUNCATE bop_identity.guest_dining_binding_preparation CASCADE"),
        {
          code: "55000",
        },
      );
      const history = (
        await admin.query(
          "SELECT record FROM bop_identity.guest_dining_binding_preparation ORDER BY revision",
        )
      ).rows;
      assert.deepEqual(history[0].record, f.preparation);
      await assert.rejects(
        admin.query(`INSERT INTO bop_identity.guest_dining_binding_preparation
        (operation_id,revision,brand_id,store_id,predecessor_id,candidate_id,admission_id,status,record)
        SELECT operation_id,revision,brand_id,store_id,predecessor_id,candidate_id,admission_id,status,
        record || '{"rawCredential":"synthetic-forbidden"}'::jsonb
        FROM bop_identity.guest_dining_binding_preparation WHERE revision=1`),
        { code: "23514" },
      );

      const next = fixture(200);
      await sessions.create({ record: next.predecessor });
      await store.prepare(next.preparation, at(0));
      await store.acknowledge(next.acknowledge);
      const failing = createPostgresGuestDiningBindingStore(
        runner({ failAudit: true }),
        scope,
        audit,
        equals,
      );
      await assert.rejects(failing.activate(next.activate), { code: "GUEST_SESSION_UNAVAILABLE" });
      const readOnly = createPostgresGuestDiningBindingStore(
        runner({ readOnly: true }),
        scope,
        audit,
        equals,
      );
      await assert.rejects(readOnly.activate(next.activate), { code: "GUEST_SESSION_UNAVAILABLE" });
      assert.equal(
        (await sessions.resolve(next.predecessor.sessionSelectorHash)).session.status,
        "Active",
      );
      assert.equal(await sessions.resolve(next.candidate.sessionSelectorHash), null);
      assert.equal(await count("bop_identity.guest_dining_binding_preparation"), 5);
      assert.equal(await count("platform_audit.audit_record"), 5);
      const lost = createPostgresGuestDiningBindingStore(
        runner({ loseAck: true }),
        scope,
        audit,
        equals,
      );
      await assert.rejects(lost.activate(next.activate), { code: "GUEST_SESSION_UNAVAILABLE" });
      const recreated = createPostgresGuestDiningBindingStore(runner(), scope, audit, equals);
      for (const seconds of [4, 5, 301])
        assert.equal(
          (await recreated.complete({ ...next.complete, observedAt: at(seconds) }))
            .sessionReference,
          next.candidate.session.sessionReference,
        );
      assert.equal(await count("bop_identity.guest_dining_binding_preparation"), 6);
      assert.equal(await count("platform_audit.audit_record"), 6);
      assert.equal(
        (await admin.query("SELECT next_sequence FROM platform_audit.audit_chain_head")).rows[0]
          .next_sequence,
        "7",
      );
      const stale = fixture(300);
      await sessions.create({ record: stale.predecessor });
      await store.prepare(stale.preparation, at(0));
      await admin.query(
        "UPDATE bop_identity.guest_session SET version=version+1 WHERE guest_session_id=$1",
        [stale.predecessor.session.sessionReference],
      );
      await assert.rejects(store.acknowledge(stale.acknowledge), {
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      await assert.rejects(store.prepare(stale.preparation, at(300)), {
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      assert.equal(await count("bop_identity.guest_dining_binding_preparation"), 7);
      assert.equal(await count("platform_audit.audit_record"), 7);

      // WP-2295: caller mutation between invocation and database work must not change authority.
      const mutateBeforeTransaction = (mutate) => ({
        async run(action) {
          await Promise.resolve();
          mutate();
          return runner().run(action);
        },
      });
      const captured = fixture(700);
      await sessions.create({ record: captured.predecessor });
      await store.prepare(captured.preparation, at(0));
      const changedProof = {
        ...captured.acknowledge,
        proof: { ...captured.proof, csrfSelectorHash: hash(999) },
      };
      const mutatingProofStore = createPostgresGuestDiningBindingStore(
        mutateBeforeTransaction(() => {
          changedProof.proof.csrfSelectorHash = captured.proof.csrfSelectorHash;
        }),
        scope,
        audit,
        equals,
      );
      await assert.rejects(mutatingProofStore.acknowledge(changedProof), {
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      assert.equal(
        (
          await admin.query(
            "SELECT max(revision) AS revision FROM bop_identity.guest_dining_binding_preparation WHERE operation_id=$1",
            [captured.preparation.operationReference],
          )
        ).rows[0].revision,
        1,
      );
      await store.acknowledge(captured.acknowledge);
      const changedEvidence = {
        ...captured.activate,
        ownerEvidence: { ...captured.activate.ownerEvidence, admissionReference: id(999) },
      };
      const mutatingEvidenceStore = createPostgresGuestDiningBindingStore(
        mutateBeforeTransaction(() => {
          changedEvidence.ownerEvidence.admissionReference =
            captured.activate.ownerEvidence.admissionReference;
        }),
        scope,
        audit,
        equals,
      );
      await assert.rejects(mutatingEvidenceStore.activate(changedEvidence), {
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      assert.equal(
        (await sessions.resolve(captured.predecessor.sessionSelectorHash)).session.status,
        "Active",
      );
      assert.equal(
        (
          await admin.query(
            "SELECT max(revision) AS revision FROM bop_identity.guest_dining_binding_preparation WHERE operation_id=$1",
            [captured.preparation.operationReference],
          )
        ).rows[0].revision,
        2,
      );
      await store.activate(captured.activate);
      const changedCsrf = {
        operationReference: captured.preparation.operationReference,
        sessionSelectorHash: captured.candidate.sessionSelectorHash,
        csrfSelectorHash: hash(999),
        observedAt: at(4),
      };
      const mutatingCsrfStore = createPostgresGuestDiningBindingStore(
        mutateBeforeTransaction(() => {
          changedCsrf.csrfSelectorHash = captured.candidate.csrfSelectorHash;
        }),
        scope,
        audit,
        equals,
      );
      await assert.rejects(mutatingCsrfStore.complete(changedCsrf), {
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      const originalScope = { ...scope };
      const stableScopeStore = createPostgresGuestDiningBindingStore(
        runner(),
        originalScope,
        audit,
        equals,
      );
      originalScope.storeReference = id(999);
      const completion = await stableScopeStore.complete({
        operationReference: captured.preparation.operationReference,
        sessionSelectorHash: captured.candidate.sessionSelectorHash,
        csrfSelectorHash: captured.candidate.csrfSelectorHash,
        observedAt: at(4),
      });
      assert.equal(completion.storeReference, scope.storeReference);
      assert.equal(completion.sessionReference, captured.candidate.session.sessionReference);
      assert.equal(await count("bop_identity.guest_dining_binding_preparation"), 10);
      assert.equal(await count("platform_audit.audit_record"), 10);
      // The predecessor FK is scoped; context policy also rejects foreign-scope inserts.
      const scopedFixture = fixture(800);
      await sessions.create({ record: scopedFixture.predecessor });
      const insertPreparation = (client, preparation) =>
        client.query(
          "INSERT INTO bop_identity.guest_dining_binding_preparation (operation_id,revision,brand_id,store_id,predecessor_id,candidate_id,admission_id,status,record) VALUES ($1,1,$2,$3,$4,$5,$6,'Prepared',$7::jsonb)",
          [
            preparation.operationReference,
            preparation.predecessor.session.brandReference,
            preparation.predecessor.session.storeReference,
            preparation.predecessor.session.sessionReference,
            preparation.candidate.session.sessionReference,
            preparation.admissionReference,
            JSON.stringify(preparation),
          ],
        );
      const foreignPreparation = {
        ...scopedFixture.preparation,
        predecessor: {
          ...scopedFixture.predecessor,
          session: { ...scopedFixture.predecessor.session, storeReference: id(90) },
        },
        candidate: {
          ...scopedFixture.candidate,
          session: { ...scopedFixture.candidate.session, storeReference: id(90) },
        },
      };
      await assert.rejects(insertPreparation(admin, foreignPreparation), { code: "23503" });
      await assert.rejects(
        runner().run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, id(90)],
          );
          return insertPreparation(tx, scopedFixture.preparation);
        }),
        { code: "42501" },
      );
      await assert.rejects(
        insertPreparation(admin, { ...scopedFixture.preparation, purpose: "PickupCartBinding" }),
        { code: "23514" },
      );
      await assert.rejects(
        insertPreparation(admin, {
          ...scopedFixture.preparation,
          candidate: {
            ...scopedFixture.candidate,
            session: { ...scopedFixture.candidate.session, rawCredential: "synthetic-forbidden" },
          },
        }),
        { code: "23514" },
      );
      assert.equal(await count("bop_identity.guest_dining_binding_preparation"), 10);
      assert.equal(await count("platform_audit.audit_record"), 10);
      assert.equal(active, 0);
    } finally {
      await admin.query(`DROP OWNED BY ${role}`);
      await admin.query(`DROP ROLE ${role}`);
      await admin.end();
    }
  });
});
