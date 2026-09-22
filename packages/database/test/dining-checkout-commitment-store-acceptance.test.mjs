import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createDiningCheckoutService,
  createPostgresDiningGuestBindingStore,
  parseDiningIdentityAdmission,
  createDiningTable,
  parseDiningSession,
  parseDiningParticipant,
  prepareDiningCheckoutCommitment,
  sealDiningCheckoutCommitment,
  expireDiningCheckoutCommitment,
  createPostgresDiningCheckoutCommitmentStore,
} from "../../rms/dining/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => "01902402-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const at = "2026-09-10T12:00:00.000Z",
  requested = "2026-09-10T12:00:02.000Z";
it("persists Dining commitments with atomic audit, original clocks, scope and current row-lock fences", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_dining" }, async (env) => {
    const admin = new Client(env.clientConfig);
    await admin.connect();
    const role = "wp2402_" + env.runId;
    assert.match(role, /^wp2402_[a-f0-9]+$/u);
    let active = 0,
      sequence = 10000,
      instant = requested;
    const context = {
      session: parseDiningSession({
        diningSessionReference: id(4),
        brandReference: id(2),
        storeReference: id(3),
        tableReference: id(6),
        tableAssignmentVersion: 7,
        phase: "Active",
        version: 5,
        startedByActorReference: id(20),
        startedAt: "2026-09-10T11:00:00.000Z",
        hostParticipantReference: id(8),
      }),
      participant: parseDiningParticipant({
        participantReference: id(8),
        diningSessionReference: id(4),
        status: "Active",
        version: 1,
        joinedAt: "2026-09-10T11:01:00.000Z",
        leftAt: null,
      }),
    };
    const table = createDiningTable({
      ...scope,
      tableReference: id(6),
      stableLabel: "SYNTHETIC-1",
      areaReference: id(21),
      areaCode: "ROOM",
      capacity: 4,
      accessibilityAttributes: [],
      lifecycle: "Published",
      qrStatus: "Active",
      qrVersion: 1,
      operationalState: "Available",
      blockReasonCode: null,
      activeDiningSessionReference: id(4),
      aggregateVersion: 7,
      createdAt: "2026-09-10T10:00:00.000Z",
      observedAt: "2026-09-10T11:00:00.000Z",
    });
    const prepared = (n) =>
      prepareDiningCheckoutCommitment(
        {
          commitmentReference: id(n),
          brandReference: id(2),
          storeReference: id(3),
          diningSessionReference: id(4),
          sessionVersion: context.session.version,
          tableReference: context.session.tableReference,
          tableAssignmentVersion: context.session.tableAssignmentVersion,
          participantReference: id(8),
          participantVersion: 1,
          guestSessionReference: id(9),
          cartReference: id(n + 1),
          cartVersion: 3,
          quoteReference: id(n + 2),
          submissionReference: id(n + 3),
          orderReference: id(n + 4),
          orderBatchReference: id(n + 5),
          paymentOperationReference: id(n + 6),
          intentHash: "a".repeat(64),
          preparedAt: at,
          preparationValidUntil: "2026-09-10T12:05:00.000Z",
        },
        context,
      );
    function seal(record) {
      const link = Object.fromEntries(
        [
          "commitmentReference",
          "brandReference",
          "storeReference",
          "submissionReference",
          "orderReference",
          "orderBatchReference",
          "cartReference",
          "cartVersion",
          "quoteReference",
          "paymentOperationReference",
          "guestSessionReference",
          "intentHash",
        ].map((k) => [k, record[k]]),
      );
      return sealDiningCheckoutCommitment(
        record,
        context,
        { ...link, acknowledgedAt: "2026-09-10T12:00:01.000Z" },
        requested,
        instant,
      );
    }
    const audit = (record) => ({
      auditId: id(++sequence),
      brandId: id(2),
      storeId: id(3),
      actor: { type: "System" },
      actionCode:
        "DINING_CHECKOUT_" +
        { Prepared: "PREPARE", PaymentPending: "SEAL", Expired: "EXPIRE" }[record.state],
      targetType: "DiningCheckoutCommitment",
      targetId: record.commitmentReference,
      reasonCode: "AUTHORIZED_DINING_CHECKOUT",
      correlationId: id(31),
      occurredAt: instant,
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    });
    function runner({ failAudit = false, loseAck = false, onQuery = () => undefined } = {}) {
      return {
        async run(action) {
          const client = new Client({
            ...env.clientConfig,
            connectionTimeoutMillis: 2000,
            query_timeout: 5000,
          });
          await client.connect();
          active++;
          let committed = false;
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + role);
            await client.query("SET LOCAL lock_timeout='5s'");
            const result = await action({
              query: async (sql, values) => {
                onQuery(sql);
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
            assert(!cleared.rows[0].brand && !cleared.rows[0].store);
            if (loseAck) throw new Error("synthetic lost acknowledgement");
            return result;
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
    const store = (options) =>
      createPostgresDiningCheckoutCommitmentStore(runner(options), scope, { now: () => instant });
    const append = (owner, record, expectedVersion) =>
      owner.append({ record, expectedVersion, audit: audit(record) });
    const count = async (reference) =>
      Number(
        (
          await admin.query(
            "SELECT count(*)::text AS count FROM rms_dining.dining_checkout_commitment WHERE commitment_id=$1",
            [reference],
          )
        ).rows[0].count,
      );
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_dining,platform_audit,platform_helpers TO " + role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,UPDATE ON rms_dining.dining_table,rms_dining.dining_session,rms_dining.dining_participant TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_dining.dining_checkout_commitment,platform_audit.audit_record TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query(
        "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",
        [id(6), id(1), id(2), id(3), 7, JSON.stringify(table), table.createdAt, table.observedAt],
      );
      await admin.query(
        "INSERT INTO rms_dining.dining_session (session_id,tenant_id,brand_id,store_id,table_id,version,phase,session_snapshot,started_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)",
        [
          id(4),
          id(1),
          id(2),
          id(3),
          id(6),
          5,
          "Active",
          JSON.stringify(context.session),
          context.session.startedAt,
        ],
      );
      await admin.query(
        "INSERT INTO rms_dining.dining_participant (participant_id,tenant_id,brand_id,store_id,session_id,version,status,participant_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
        [id(8), id(1), id(2), id(3), id(4), 1, "Active", JSON.stringify(context.participant)],
      );
      await admin.query("GRANT SELECT ON rms_dining.dining_identity_admission TO " + role);
      const admission = parseDiningIdentityAdmission({
        admissionReference: id(50),
        diningSessionReference: id(4),
        participantReference: id(8),
        storeReference: id(3),
        tableReference: id(6),
        tableAssignmentVersion: 7,
        operationReference: id(51),
        operationIntentHash: "a".repeat(64),
        status: "Consumed",
        version: 2,
        issuedAt: context.participant.joinedAt,
        consumedAt: "2026-09-10T11:01:01.000Z",
      });
      await admin.query(
        "INSERT INTO rms_dining.dining_identity_admission (admission_id,tenant_id,brand_id,store_id,session_id,participant_id,version,status,admission_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
        [id(50), id(1), id(2), id(3), id(4), id(8), 2, "Consumed", JSON.stringify(admission)],
      );
      let guestCurrent = true;
      const application = createDiningCheckoutService({
        scope: { brandReference: id(2), storeReference: id(3) },
        now: () => instant,
        hashIntent: (value) => createHash("sha256").update(value).digest("hex"),
        authorization: {
          authorize: async (request) =>
            guestCurrent
              ? {
                  guestSessionReference: id(9),
                  brandReference: id(2),
                  storeReference: id(3),
                  diningSessionReference: id(4),
                  participantReference: id(8),
                  tableReference: id(6),
                  identityVersion: 2,
                  expiresAt: "2026-09-10T13:00:00.000Z",
                  observedAt: request.observedAt,
                }
              : null,
        },
        current: createPostgresDiningGuestBindingStore(runner(), scope),
        repository: store(),
        audit: { create: async ({ record }) => audit(record) },
      });
      const command = {
        commitmentReference: id(1000),
        guestSessionReference: id(9),
        diningSessionReference: id(4),
        participantReference: id(8),
        cartReference: id(1001),
        cartVersion: 3,
        quoteReference: id(1002),
        submissionReference: id(1003),
        orderReference: id(1004),
        orderBatchReference: id(1005),
        paymentOperationReference: id(1006),
        sourceValidUntil: "2026-09-10T12:05:00.000Z",
      };
      const preparedByApplication = await application.prepare(command);
      assert.equal(preparedByApplication.status, "Created");
      assert.equal((await application.prepare(command)).status, "Existing");
      const orderingPreparation = await application.prepareForOrdering(command);
      assert.equal(orderingPreparation.status, "Existing");
      assert.deepEqual(orderingPreparation.record, preparedByApplication.record);
      assert.deepEqual(
        await store().loadSubmission(command.submissionReference),
        preparedByApplication.record,
      );
      guestCurrent = false;
      await assert.rejects(application.prepare(command), {
        code: "DINING_CHECKOUT_PERMISSION_DENIED",
      });
      assert.equal(await count(command.commitmentReference), 1);
      guestCurrent = true;
      const owner = store(),
        initial = prepared(100),
        pending = seal(initial);
      const both = await Promise.all([append(owner, initial, 0), append(owner, initial, 0)]);
      assert.deepEqual(both.map((r) => r.status).sort(), ["Created", "Existing"]);
      assert.equal(await count(initial.commitmentReference), 1);
      await assert.rejects(append(owner, { ...initial, intentHash: "b".repeat(64) }, 0), {
        code: "DINING_CHECKOUT_STORE_CONFLICT",
      });
      await assert.rejects(append(store({ loseAck: true }), pending, 1), {
        code: "DINING_CHECKOUT_STORE_UNAVAILABLE",
      });
      assert.deepEqual(await owner.load(initial.commitmentReference), pending);
      assert.deepEqual(await owner.loadSubmission(initial.submissionReference), pending);
      assert.equal((await append(owner, pending, 1)).status, "Existing");
      assert.equal(await count(initial.commitmentReference), 2);
      const foreign = createPostgresDiningCheckoutCommitmentStore(
        runner(),
        { ...scope, storeReference: id(99) },
        { now: () => instant },
      );
      assert.equal(await foreign.load(initial.commitmentReference), null);
      assert.equal(await foreign.loadSubmission(initial.submissionReference), null);
      await assert.rejects(append(foreign, initial, 0), { code: "DINING_CHECKOUT_STORE_CONFLICT" });
      const candidate = prepared(180);
      const alternateCandidate = {
        ...candidate,
        commitmentReference: id(181),
        orderReference: id(182),
        orderBatchReference: id(183),
        paymentOperationReference: id(184),
      };
      const contenders = await Promise.allSettled([
        append(owner, candidate, 0),
        append(owner, alternateCandidate, 0),
      ]);
      assert.equal(contenders.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(contenders.filter((r) => r.status === "rejected").length, 1);
      const winning = contenders.find((r) => r.status === "fulfilled").value.record;
      assert.deepEqual(await owner.loadSubmission(candidate.submissionReference), winning);
      assert.equal(
        (await count(candidate.commitmentReference)) +
          (await count(alternateCandidate.commitmentReference)),
        1,
      );
      const failed = prepared(200);
      await assert.rejects(append(store({ failAudit: true }), failed, 0), {
        code: "DINING_CHECKOUT_STORE_UNAVAILABLE",
      });
      assert.equal(await count(failed.commitmentReference), 0);
      const waited = prepared(300);
      await assert.rejects(
        append(
          store({
            onQuery: (sql) => {
              if (sql.startsWith("UPDATE platform_audit.audit_chain_head"))
                instant = waited.preparationValidUntil;
            },
          }),
          waited,
          0,
        ),
        { code: "DINING_CHECKOUT_EXPIRED" },
      );
      assert.equal(await count(waited.commitmentReference), 0);
      instant = pending.capacityExpiresAt;
      const expired = expireDiningCheckoutCommitment(pending, instant);
      assert.equal((await append(owner, expired, 2)).status, "Created");
      assert.equal((await append(owner, expired, 2)).status, "Existing");
      assert.equal(await count(initial.commitmentReference), 3);
      assert.deepEqual(
        (
          await admin.query(
            "SELECT session_snapshot AS session FROM rms_dining.dining_session WHERE session_id=$1",
            [id(4)],
          )
        ).rows[0].session,
        context.session,
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT table_snapshot AS table FROM rms_dining.dining_table WHERE table_id=$1",
            [id(6)],
          )
        ).rows[0].table,
        table,
      );
      // Even elevated writes cannot rewrite or delete immutable history.
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_dining.dining_checkout_commitment SET state='Expired' WHERE commitment_id=$1",
            [id(100)],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await admin.query(
            "DELETE FROM rms_dining.dining_checkout_commitment WHERE commitment_id=$1",
            [id(100)],
          )
        ).rowCount,
        0,
      );
      instant = requested;
      // A Move transaction holds the original Table row, then changes both assignment and Session.
      const moveRaced = prepared(350);
      const movedTable = createDiningTable({
        ...table,
        tableReference: id(7),
        stableLabel: "SYNTHETIC-2",
        activeDiningSessionReference: null,
        aggregateVersion: 1,
      });
      await admin.query(
        "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",
        [
          id(7),
          id(1),
          id(2),
          id(3),
          1,
          JSON.stringify(movedTable),
          movedTable.createdAt,
          movedTable.observedAt,
        ],
      );
      let moveAttempted;
      const moveWaiting = new Promise((resolve) => {
        moveAttempted = resolve;
      });
      await admin.query("BEGIN");
      await admin.query(
        "UPDATE rms_dining.dining_table SET version=8,table_snapshot=$2::jsonb WHERE table_id=$1",
        [
          id(6),
          JSON.stringify({ ...table, aggregateVersion: 8, activeDiningSessionReference: null }),
        ],
      );
      await admin.query(
        "UPDATE rms_dining.dining_table SET version=2,table_snapshot=$2::jsonb WHERE table_id=$1",
        [
          id(7),
          JSON.stringify({
            ...movedTable,
            aggregateVersion: 2,
            activeDiningSessionReference: id(4),
          }),
        ],
      );
      const movedSession = parseDiningSession({
        ...context.session,
        tableReference: id(7),
        tableAssignmentVersion: 2,
        version: 6,
      });
      await admin.query(
        "UPDATE rms_dining.dining_session SET table_id=$2,version=6,session_snapshot=$3::jsonb WHERE session_id=$1",
        [id(4), id(7), JSON.stringify(movedSession)],
      );
      const moveAttempt = append(
        store({
          onQuery: (sql) => {
            if (sql.startsWith("SELECT table_snapshot")) moveAttempted();
          },
        }),
        moveRaced,
        0,
      );
      const moveOutcome = moveAttempt.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await Promise.race([moveWaiting, moveOutcome]);
      await admin.query("COMMIT");
      assert.equal((await moveOutcome).error?.code, "DINING_CHECKOUT_STORE_CONFLICT");
      assert.equal(await count(moveRaced.commitmentReference), 0);
      context.session = movedSession;
      // A Closing transaction holds the Session row; preparation waits and sees its committed new phase.
      const raced = prepared(400);
      assert.equal(raced.tableReference, id(7));
      const movedStored = (
        await admin.query(
          "SELECT table_snapshot AS table FROM rms_dining.dining_table WHERE table_id=$1",
          [id(7)],
        )
      ).rows[0].table;
      assert.equal(movedStored.activeDiningSessionReference, id(4));
      assert.equal(movedStored.operationalState, "Available");
      assert.equal(movedStored.lifecycle, "Published");
      assert(movedStored.observedAt <= instant);

      let attempted;
      const waiting = new Promise((resolve) => {
        attempted = resolve;
      });
      await admin.query("BEGIN");
      const closing = { ...context.session, phase: "Closing", version: 7 };
      await admin.query(
        "UPDATE rms_dining.dining_session SET phase='Closing',version=7,session_snapshot=$2::jsonb WHERE session_id=$1",
        [id(4), JSON.stringify(closing)],
      );
      const attempt = append(
        store({
          onQuery: (sql) => {
            if (sql.startsWith("SELECT session_snapshot")) attempted();
          },
        }),
        raced,
        0,
      );
      const outcome = attempt.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await Promise.race([waiting, outcome]);
      await admin.query("COMMIT");
      assert.equal((await outcome).error?.code, "DINING_CHECKOUT_CONTEXT_CHANGED");
      assert.equal(await count(raced.commitmentReference), 0);
      assert.deepEqual(await owner.load(initial.commitmentReference), expired);
      assert.equal(active, 0);
      const audits = await admin.query(
        "SELECT count(*)::text AS count FROM platform_audit.audit_record WHERE action_code LIKE 'DINING_CHECKOUT_%'",
      );
      assert.equal(Number(audits.rows[0].count), 5);
    } finally {
      await admin.query("ROLLBACK");
      assert.equal(active, 0);
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
      await admin.end();
    }
  });
});
