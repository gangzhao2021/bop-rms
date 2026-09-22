import { exerciseOrderTermination } from "../test-support/order-termination.mjs";
import { createConsumerDeliveryDatabase } from "../../../apps/worker/src/consumer-transaction.ts";
import { ConsumerRegistry } from "../../bop/eventing/src/index.ts";
import { ConsumerDeliveryWorker } from "../../../apps/worker/src/consumer-delivery.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPostgresOrderAcceptanceReader,
  createPostgresOrderAcceptanceStore,
  createPostgresOrderPaymentFailureStore,
  createPostgresOrderPaymentDispositionStore,
  createPostgresOrderPaymentOutcomeStore,
  createOrderConfirmedEnvelope,
  parsePaymentSucceededEnvelope,
  parseOrderPaymentOutcomeDisposition,
  createOrderPaymentDispositionBinding,
  createOrderPaymentOutcomeConsumerService,
  parsePaymentFailedEnvelope,
  parseOrderPaymentFailureRecord,
  createPaymentOutcomeEventBinding,
} from "../../rms/ordering/src/index.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => "0198a107-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (s) => "sha256:" + createHash("sha256").update(s).digest("hex");
it("persists scoped failure and Audit atomically with parallel original replay", async () => {
  await withIsolatedDatabase({ caseId: "order_failure", root }, async (env) => {
    const admin = new pg.Client(env.clientConfig);
    await admin.connect();
    const role = "order_failure_" + env.runId;
    const at = new Date().toISOString();
    let auditSequence = 100,
      failAudit = false,
      failOutbox = false;
    const store = createPostgresOrderPaymentFailureStore({
      brandReference: id(2),
      storeReference: id(3),
      sha256: hash,
      audit: async ({ orderReference, correlationReference }) => ({
        auditId: id(++auditSequence),
        brandId: id(2),
        storeId: id(3),
        actor: { type: "System" },
        actionCode: "ORDER_PAYMENT_FAILURE_RECORDED",
        targetType: "Order",
        targetId: orderReference,
        correlationId: correlationReference,
        afterSummary: { outcome: "PaymentFailed" },
        reasonCode: "PAYMENT_FAILED",
        occurredAt: at,
        sourceChannel: "EVENT_CONSUMER",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      }),
    });
    let failAcceptanceRevision = false;
    const run = async (work) => {
      const client = new pg.Client(env.clientConfig);
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE " + role);
        const result = await work({
          query: async (sql, values) => {
            if (failOutbox && sql.startsWith("INSERT INTO platform_eventing.outbox_event"))
              throw Error("synthetic outbox failure");
            if (failAudit && sql.startsWith("INSERT INTO platform_audit.audit_record"))
              throw Error("synthetic audit failure");
            const result = await client.query(sql, [...values]);
            if (failAcceptanceRevision && sql.startsWith("INSERT INTO rms_ordering.order_revision"))
              throw Error("synthetic failure after acceptance revision");
            return result;
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        await client.end();
      }
    };
    const event = (n) =>
      parsePaymentFailedEnvelope({
        eventId: id(n),
        eventType: "PaymentFailed",
        schemaVersion: 1,
        occurredAt: at,
        producerModule: "@rms/payment",
        tenantId: id(2),
        storeId: id(3),
        aggregateType: "PaymentIntent",
        aggregateId: id(n + 1),
        aggregateVersion: 2n,
        correlationId: id(n + 4),
        causationId: id(n + 5),
        actor: { type: "System" },
        payload: {
          paymentTransactionReference: id(n + 2),
          paymentIntentReference: id(n + 1),
          paymentAttemptReference: id(n + 3),
          orderReference: id(1),
          reason: "Declined",
          retryDisposition: "Never",
          terminalOccurredAt: at,
        },
        redactionClassification: "payment",
        replayMetadata: { replaySafe: true },
      });
    const failure = (e, n) =>
      parseOrderPaymentFailureRecord({
        failureRecordReference: id(n),
        brandReference: id(2),
        storeReference: id(3),
        orderReference: id(1),
        paymentTransactionReference: e.payload.paymentTransactionReference,
        paymentIntentReference: e.payload.paymentIntentReference,
        paymentAttemptReference: e.payload.paymentAttemptReference,
        paymentEventReference: e.eventId,
        reason: e.payload.reason,
        retryDisposition: e.payload.retryDisposition,
        terminalOccurredAt: at,
        eventDigest: hash(createPaymentOutcomeEventBinding(e)),
      });
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_ordering,platform_audit,platform_helpers TO " + role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_ordering.order_payment_failure_record,platform_audit.audit_record TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query(
        "INSERT INTO rms_ordering.order_number_allocation " +
          "(order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at," +
          "business_date_configuration_id,business_date_configuration_version,business_date_content_digest," +
          "time_zone,business_day_start,business_date_boundary_at,boundary_disambiguation) " +
          "VALUES ($1,$2,$3,'2026-09-11',1,'1',$4,$5,1,$6,'America/Toronto','00:00',$4,'Exact')",
        [id(1), id(2), id(3), at, id(4), hash("synthetic")],
      );
      await admin.query(
        "INSERT INTO rms_ordering.order_header " +
          "(order_id,brand_id,store_id,business_date,order_number,order_type,source_channel," +
          "created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) " +
          "VALUES ($1,$2,$3,'2026-09-11','1','Pickup','Web',$4,$4,1,'Submitted','Open','NotReported',$5)",
        [id(1), id(2), id(3), id(5), at],
      );
      const e = event(200),
        f = failure(e, 210);
      const results = await Promise.all(
        [f, failure(e, 211)].map((value) =>
          run((transaction) => store.commitFailed({ sourceEvent: e, failure: value, transaction })),
        ),
      );
      assert.deepEqual(results.map((r) => r.status).sort(), ["AlreadyCommitted", "Created"]);
      assert.deepEqual(results[0].effect, results[1].effect);
      const other = createPostgresOrderPaymentFailureStore({
        brandReference: id(2),
        storeReference: id(99),
        sha256: hash,
        audit: async () => {
          throw Error("unused");
        },
      });
      assert.equal(
        await run((transaction) =>
          other.loadByPaymentEvent({
            transaction,
            paymentEventReference: e.eventId,
          }),
        ),
        null,
      );
      await assert.rejects(
        run((transaction) =>
          store.commitFailed({
            sourceEvent: e,
            failure: { ...f, reason: "Cancelled" },
            transaction,
          }),
        ),
        { code: "ORDER_PAYMENT_OUTCOME_CONFLICT" },
      );
      const e2 = event(300),
        f2 = failure(e2, 310);
      failAudit = true;
      await assert.rejects(
        run((transaction) =>
          store.commitFailed({
            sourceEvent: e2,
            failure: f2,
            transaction,
          }),
        ),
        /synthetic audit failure/,
      );
      assert.equal(
        await run((transaction) =>
          store.loadByPaymentEvent({
            transaction,
            paymentEventReference: e2.eventId,
          }),
        ),
        null,
      );
      failAudit = false;
      await run((transaction) => store.commitFailed({ sourceEvent: e2, failure: f2, transaction }));
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_ordering.order_payment_failure_record",
          )
        ).rows[0].n,
        2,
      );
      assert.equal(
        (await admin.query("SELECT count(*)::int AS n FROM platform_audit.audit_record")).rows[0].n,
        2,
      );
      await admin.query("GRANT USAGE ON SCHEMA platform_eventing TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON platform_eventing.consumer_inbox TO " + role,
      );
      const consumer = createOrderPaymentOutcomeConsumerService({
        authorization: { authorize: async () => true },
        source: {
          loadExact: async () => {
            throw Error("failure must not query confirmation");
          },
        },
        outcomes: {
          ...store,
          commitSucceeded: async () => {
            throw Error("failure must not confirm");
          },
        },
        references: { generate: () => id(++auditSequence) },
        digests: { sha256: hash },
      });
      const e3 = event(400);
      failAudit = true;
      await assert.rejects(run((transaction) => consumer.consume(transaction, e3)));
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_eventing.consumer_inbox WHERE event_id=$1",
            [e3.eventId],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        await run((transaction) =>
          store.loadByPaymentEvent({
            transaction,
            paymentEventReference: e3.eventId,
          }),
        ),
        null,
      );
      failAudit = false;
      const consumed = await run((transaction) => consumer.consume(transaction, e3));
      assert.equal(consumed.consumerOutcome.status, "processed");
      assert.equal(consumed.result.status, "PaymentFailedRecorded");
      const duplicate = await run((transaction) => consumer.consume(transaction, e3));
      assert.equal(duplicate.consumerOutcome.status, "duplicate_completed");
      assert.deepEqual(duplicate.result, consumed.result);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_eventing.consumer_inbox WHERE event_id=$1",
            [e3.eventId],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_ordering.order_payment_failure_record",
          )
        ).rows[0].n,
        3,
      );
      assert.equal(
        (await admin.query("SELECT count(*)::int AS n FROM platform_audit.audit_record")).rows[0].n,
        3,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_ordering.order_payment_disposition_record,platform_eventing.outbox_event TO " +
          role,
      );
      await admin.query("GRANT SELECT,UPDATE ON rms_ordering.order_batch TO " + role);
      await admin.query(
        "INSERT INTO rms_ordering.order_submission_record " +
          "(submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at) " +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9)",
        [id(500), id(2), id(3), id(1), id(502), hash("submission"), id(503), id(504), at],
      );
      await admin.query(
        "INSERT INTO rms_ordering.order_batch " +
          "(order_batch_id,brand_id,store_id,order_id,submission_id,source_cart_id,source_cart_version,checkout_validation_id,quote_id,submitted_by_actor_id,submitted_at) " +
          "VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10)",
        [id(501), id(2), id(3), id(1), id(500), id(503), id(505), id(504), id(5), at],
      );
      await admin.query(
        "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'Initial',1,0,NULL,$1,$5)",
        [id(500), id(2), id(3), id(1), at],
      );
      await admin.query("GRANT SELECT,INSERT ON rms_ordering.order_revision TO " + role);
      // Schema evidence only: these synthetic inserts do not invoke an authorized accept command.
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_ordering.order_acceptance_record TO " + role,
      );
      await admin.query(
        "GRANT SELECT ON rms_ordering.order_termination_record,rms_ordering.order_fulfillment_completion_record TO " +
          role,
      );
      let acceptanceAuthorized = true,
        acceptanceSourceCurrent = true;
      let acceptanceSourceCalls = 0;
      let acceptanceReadAllowed = true;
      const acceptanceReader = createPostgresOrderAcceptanceReader({
        brandReference: id(2),
        storeReference: id(3),
        authorize: async (tx, scope) => {
          assert.ok(tx.query);
          assert.equal(scope.orderReference, id(1));
          assert.equal(scope.orderBatchReference, id(501));
          return acceptanceReadAllowed;
        },
      });
      const readAcceptance = () =>
        run((transaction) =>
          acceptanceReader.loadByBatch({
            transaction,
            orderReference: id(1),
            orderBatchReference: id(501),
          }),
        );
      assert.equal(await readAcceptance(), null);
      const acceptanceRecord = {
        acceptanceReference: id(1700),
        operationReference: id(1701),
        brandReference: id(2),
        storeReference: id(3),
        orderReference: id(1),
        orderBatchReference: id(501),
        expectedOrderVersion: 1,
        acceptedOrderVersion: 2,
        actorType: "User",
        actorReference: id(5),
        purposeCode: "OrderAcceptance",
        permissionCode: "order.accept",
        reasonCode: "SYNTHETIC_TEST",
        workflowVersionReference: id(1600),
        transitionReference: id(1601),
        sourceDigest: hash("current-order-and-policy"),
        acceptedAt: at,
      };
      const acceptanceWriter = createPostgresOrderAcceptanceStore({
        brandReference: id(2),
        storeReference: id(3),
        authorize: async (transaction, record) => {
          assert.ok(transaction.query);
          assert.equal(record.orderReference, id(1));
          return acceptanceAuthorized;
        },
        validateCurrentSource: async (transaction, record) => {
          assert.ok(transaction.query);
          assert.equal(record.expectedOrderVersion, 1);
          acceptanceSourceCalls++;
          return acceptanceSourceCurrent;
        },
        audit: async (record) => ({
          auditId: id(++auditSequence),
          brandId: record.brandReference,
          storeId: record.storeReference,
          actor: { type: record.actorType, reference: record.actorReference },
          actionCode: "ORDER_ACCEPTED",
          targetType: "Order",
          targetId: record.orderReference,
          correlationId: record.operationReference,
          reasonCode: record.reasonCode,
          occurredAt: record.acceptedAt,
          sourceChannel: "MERCHANT_WEB",
          afterSummary: { phase: "Accepted" },
          dataClassification: "Restricted",
          retentionPolicyCode: "FINANCIAL_COMPLIANCE",
          retentionPolicyVersion: 1,
        }),
      });
      const accept = (patch = {}) =>
        run((transaction) =>
          acceptanceWriter.commit({ transaction, record: { ...acceptanceRecord, ...patch } }),
        );
      acceptanceAuthorized = false;
      await assert.rejects(accept(), { code: "ORDER_ACCEPTANCE_RECORD_UNAVAILABLE" });
      assert.equal(acceptanceSourceCalls, 0);
      acceptanceAuthorized = true;
      acceptanceSourceCurrent = false;
      await assert.rejects(accept(), { code: "ORDER_ACCEPTANCE_RECORD_UNAVAILABLE" });
      acceptanceSourceCurrent = true;
      failAudit = true;
      await assert.rejects(accept());
      failAudit = false;
      assert.equal(
        (await admin.query("SELECT count(*)::int AS n FROM rms_ordering.order_acceptance_record"))
          .rows[0].n,
        0,
      );
      failAcceptanceRevision = true;
      await run(async (transaction) => {
        await assert.rejects(acceptanceWriter.commit({ transaction, record: acceptanceRecord }));
      });
      failAcceptanceRevision = false;
      assert.equal(
        (await admin.query("SELECT count(*)::int AS n FROM rms_ordering.order_acceptance_record"))
          .rows[0].n,
        0,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_ordering.order_revision WHERE order_id=$1",
            [id(1)],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE action_code='ORDER_ACCEPTED'",
          )
        ).rows[0].n,
        0,
      );
      const acceptanceResults = await Promise.all([
        accept(),
        accept({ acceptanceReference: id(1702) }),
      ]);
      assert.deepEqual(acceptanceResults.map((r) => r.status).sort(), [
        "AlreadyCommitted",
        "Created",
      ]);
      assert.deepEqual(acceptanceResults[0].record, acceptanceResults[1].record);
      assert.deepEqual(
        (
          await admin.query(
            "SELECT version,expected_version,previous_revision_id,kind FROM rms_ordering.order_revision WHERE order_id=$1 ORDER BY version",
            [id(1)],
          )
        ).rows,
        [
          { version: 1, expected_version: 0, previous_revision_id: null, kind: "Initial" },
          { version: 2, expected_version: 1, previous_revision_id: id(500), kind: "Acceptance" },
        ],
      );

      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE action_code='ORDER_ACCEPTED'",
          )
        ).rows[0].n,
        1,
      );
      assert.deepEqual(await readAcceptance(), acceptanceResults[0].record);
      acceptanceReadAllowed = false;
      await assert.rejects(readAcceptance(), { code: "ORDER_ACCEPTANCE_RECORD_UNAVAILABLE" });
      acceptanceReadAllowed = true;
      const foreignAcceptanceReader = createPostgresOrderAcceptanceReader({
        brandReference: id(2),
        storeReference: id(99),
        authorize: async () => true,
      });
      assert.equal(
        await run((transaction) =>
          foreignAcceptanceReader.loadByBatch({
            transaction,
            orderReference: id(1),
            orderBatchReference: id(501),
          }),
        ),
        null,
      );
      await run(async (transaction) => {
        await acceptanceReader.loadByBatch({
          transaction,
          orderReference: id(1),
          orderBatchReference: id(501),
        });
        await admin.query("BEGIN");
        try {
          const lock = await admin.query(
            "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
            ["OrderingOrderDisposition:" + id(2) + ":" + id(3) + ":" + id(1)],
          );
          assert.equal(lock.rows[0].acquired, false);
        } finally {
          await admin.query("ROLLBACK");
        }
      });
      const callsBeforeReplay = acceptanceSourceCalls;
      assert.equal(
        (await accept({ acceptedAt: new Date(Date.parse(at) + 1000).toISOString() })).status,
        "AlreadyCommitted",
      );
      assert.equal(acceptanceSourceCalls, callsBeforeReplay);
      await assert.rejects(accept({ permissionCode: "order.other" }), {
        code: "ORDER_ACCEPTANCE_RECORD_CONFLICT",
      });
      await assert.rejects(accept({ operationReference: id(1703) }), {
        code: "ORDER_ACCEPTANCE_RECORD_CONFLICT",
      });
      acceptanceAuthorized = false;
      await assert.rejects(accept(), { code: "ORDER_ACCEPTANCE_RECORD_UNAVAILABLE" });
      acceptanceAuthorized = true;
      const acceptanceScope = async (tx, storeId = id(3)) =>
        tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
          id(2),
          storeId,
        ]);
      const insertAcceptance = (
        tx,
        n,
        expected = 1,
        accepted = 2,
        actorType = "User",
        actorId = id(5),
      ) =>
        tx.query(
          "INSERT INTO rms_ordering.order_acceptance_record " +
            "(acceptance_id,operation_id,brand_id,store_id,order_id,order_batch_id," +
            "expected_order_version,accepted_order_version,actor_type,actor_id,purpose_code," +
            "permission_code,reason_code,workflow_version_id,transition_id,source_digest,accepted_at) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'OrderAcceptance','order.accept'," +
            "'SYNTHETIC_TEST',$11,$12,$13,$14)",
          [
            id(n),
            id(n + 1),
            id(2),
            id(3),
            id(1),
            id(501),
            expected,
            accepted,
            actorType,
            actorId,
            id(1600),
            id(1601),
            hash("current-order-and-policy"),
            at,
          ],
        );
      const competingAcceptances = await Promise.allSettled(
        [1610, 1620].map((n) =>
          run(async (tx) => {
            await acceptanceScope(tx);
            return insertAcceptance(tx, n, 2, 3);
          }),
        ),
      );
      assert.equal(competingAcceptances.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(competingAcceptances.find((r) => r.status === "rejected").reason.code, "23505");
      for (const args of [
        [2, 4, "User", id(5)],
        [2, 3, "User", null],
        [2, 3, "System", id(5)],
      ]) {
        await assert.rejects(
          run(async (tx) => {
            await acceptanceScope(tx);
            return insertAcceptance(tx, 1630, ...args);
          }),
          { code: "23514" },
        );
      }
      await run(async (tx) => {
        await acceptanceScope(tx, id(99));
        assert.equal(
          (await tx.query("SELECT * FROM rms_ordering.order_acceptance_record", [])).rows.length,
          0,
        );
      });
      await assert.rejects(
        run(async (tx) => {
          await acceptanceScope(tx, id(99));
          return insertAcceptance(tx, 1630, 2, 3);
        }),
        { code: "42501" },
      );
      await run(async (tx) => {
        await acceptanceScope(tx);
        assert.equal(
          (
            await tx.query(
              "UPDATE rms_ordering.order_acceptance_record SET reason_code='Changed'",
              [],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (await tx.query("DELETE FROM rms_ordering.order_acceptance_record", [])).rowCount,
          0,
        );
        const rows = (
          await tx.query(
            "SELECT reason_code FROM rms_ordering.order_acceptance_record WHERE accepted_order_version=3",
            [],
          )
        ).rows;
        assert.deepEqual(rows, [{ reason_code: "SYNTHETIC_TEST" }]);
      });
      // The later physical-schema fixture deliberately contains two versions for the same Batch.
      await assert.rejects(readAcceptance(), { code: "ORDER_ACCEPTANCE_RECORD_CONFLICT" });
      const dispositions = createPostgresOrderPaymentOutcomeStore({
        brandReference: id(2),
        storeReference: id(3),
        sha256: hash,
        audit: async ({ orderReference, correlationReference, outcome }) => ({
          auditId: id(++auditSequence),
          brandId: id(2),
          storeId: id(3),
          actor: { type: "System" },
          actionCode:
            outcome === "PaymentFailed"
              ? "ORDER_PAYMENT_FAILURE_RECORDED"
              : "ORDER_PAYMENT_DISPOSITION_RECORDED",
          targetType: "Order",
          targetId: orderReference,
          correlationId: correlationReference,
          afterSummary: { outcome },
          reasonCode: "PAYMENT_CAPTURED",
          occurredAt: at,
          sourceChannel: "EVENT_CONSUMER",
          dataClassification: "Restricted",
          retentionPolicyCode: "FINANCIAL_COMPLIANCE",
          retentionPolicyVersion: 1,
        }),
      });
      const successInput = (n, kind = "Confirmed") => {
        const base = event(n);
        const e = parsePaymentSucceededEnvelope({
          ...base,
          eventType: "PaymentSucceeded",
          payload: {
            paymentTransactionReference: base.payload.paymentTransactionReference,
            paymentIntentReference: base.payload.paymentIntentReference,
            paymentAttemptReference: base.payload.paymentAttemptReference,
            orderReference: id(1),
            amountMinor: "1250",
            currencyCode: "CAD",
            evidenceKind: "Captured",
            terminalOccurredAt: at,
          },
        });
        const raw = {
          dispositionReference: id(n + 10),
          brandReference: id(2),
          storeReference: id(3),
          orderReference: id(1),
          orderBatchReference: id(501),
          submissionReference: id(500),
          paymentTransactionReference: e.payload.paymentTransactionReference,
          paymentIntentReference: e.payload.paymentIntentReference,
          paymentAttemptReference: e.payload.paymentAttemptReference,
          paymentEventReference: e.eventId,
          sourceVersion: 3,
          sourceCheckpoint: id(n + 11),
          sourceDigest: hash("placeholder"),
          evaluatedAt: at,
          disposition: kind,
          ...(kind === "Confirmed"
            ? {
                confirmationReference: id(n + 12),
                sourceSnapshotDigest: hash("snapshot"),
                confirmedAt: at,
              }
            : { reason: "CapacityExpired", kitchenReleaseDisposition: "Blocked" }),
        };
        const disposition = parseOrderPaymentOutcomeDisposition({
          ...raw,
          sourceDigest: hash(createOrderPaymentDispositionBinding({ event: e, disposition: raw })),
        });
        return {
          sourceEvent: e,
          disposition,
          orderConfirmedEvent:
            kind === "Confirmed"
              ? createOrderConfirmedEnvelope({
                  eventReference: id(n + 13),
                  sourceEvent: e,
                  disposition,
                })
              : null,
        };
      };
      const good = successInput(600);
      const dispositionLocks = [];
      const stored = await run(async (transaction) => {
        const effect = await dispositions.commitSucceeded({
          ...good,
          transaction: {
            query: async (sql, values) => {
              if (sql.startsWith("SELECT pg_advisory_xact_lock"))
                dispositionLocks.push(values[0].split(":")[0]);
              return transaction.query(sql, values);
            },
          },
        });
        await admin.query("BEGIN");
        try {
          const lock = await admin.query(
            "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
            ["OrderingOrderDisposition:" + id(2) + ":" + id(3) + ":" + id(1)],
          );
          assert.equal(lock.rows[0].acquired, false);
        } finally {
          await admin.query("ROLLBACK");
        }
        return effect;
      });
      assert.deepEqual(dispositionLocks.slice(0, 4), [
        "OrderingOrderDisposition",
        "OrderingPaymentOutcome",
        "OrderingOrderDisposition",
        "OrderingPaymentDisposition",
      ]);
      assert.equal(stored.status, "Created");
      const replay = await run((transaction) =>
        dispositions.commitSucceeded({
          ...good,
          orderConfirmedEvent: { ...good.orderConfirmedEvent, eventId: id(699) },
          transaction,
        }),
      );
      assert.equal(replay.status, "AlreadyCommitted");
      assert.deepEqual(replay.effect, stored.effect);
      const blocked = successInput(700, "PaidWithoutFulfillableOrder");
      assert.equal(
        (await run((transaction) => dispositions.commitSucceeded({ ...blocked, transaction })))
          .effect.orderConfirmedEvent,
        null,
      );
      for (const [n, target] of [
        [800, "audit"],
        [900, "outbox"],
      ]) {
        const value = successInput(n);
        failAudit = target === "audit";
        failOutbox = target === "outbox";
        await assert.rejects(
          run((transaction) => dispositions.commitSucceeded({ ...value, transaction })),
        );
        assert.equal(
          await run((transaction) =>
            dispositions.loadByPaymentEvent({
              transaction,
              paymentEventReference: value.sourceEvent.eventId,
            }),
          ),
          null,
        );
        failAudit = false;
        failOutbox = false;
        assert.equal(
          (await run((transaction) => dispositions.commitSucceeded({ ...value, transaction })))
            .status,
          "Created",
        );
      }
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_ordering.order_payment_disposition_record",
          )
        ).rows[0].n,
        4,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_eventing.outbox_event WHERE event_type='OrderConfirmed'",
          )
        ).rows[0].n,
        3,
      );
      const raceConfirmed = successInput(1000);
      const raceBlocked = successInput(1000, "PaidWithoutFulfillableOrder");
      const raced = await Promise.allSettled(
        [raceConfirmed, raceBlocked].map((value) =>
          run((transaction) => dispositions.commitSucceeded({ ...value, transaction })),
        ),
      );
      assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(raced.filter((r) => r.status === "rejected").length, 1);
      const winner = raced.find((r) => r.status === "fulfilled").value.effect;
      const winnerEvents = (
        await admin.query(
          "SELECT count(*)::int AS n FROM platform_eventing.outbox_event WHERE causation_id=$1",
          [raceConfirmed.sourceEvent.eventId],
        )
      ).rows[0].n;
      assert.equal(winnerEvents, winner.record.disposition === "Confirmed" ? 1 : 0);
      const badPair = successInput(1100, "PaidWithoutFulfillableOrder");
      const badRecord = { ...badPair.disposition, submissionReference: id(9999) };
      badRecord.sourceDigest = hash(
        createOrderPaymentDispositionBinding({
          event: badPair.sourceEvent,
          disposition: badRecord,
        }),
      );
      await assert.rejects(
        run((transaction) =>
          dispositions.commitSucceeded({
            ...badPair,
            disposition: badRecord,
            transaction,
          }),
        ),
        { code: "ORDER_PAYMENT_OUTCOME_CONFLICT" },
      );
      const otherDispositions = createPostgresOrderPaymentDispositionStore({
        brandReference: id(2),
        storeReference: id(99),
        sha256: hash,
        audit: async () => {
          throw Error("unused");
        },
      });
      assert.equal(
        await run((transaction) =>
          otherDispositions.loadByPaymentEvent({
            transaction,
            paymentEventReference: good.sourceEvent.eventId,
          }),
        ),
        null,
      );
      const pending = successInput(1200);
      const successConsumer = createOrderPaymentOutcomeConsumerService({
        authorization: { authorize: async () => true },
        source: {
          loadExact: async (input) => {
            assert.equal(typeof input.transaction.query, "function");
            assert.equal(input.paymentEventReference, pending.sourceEvent.eventId);
            return pending.disposition;
          },
        },
        outcomes: dispositions,
        references: { generate: () => id(++auditSequence) },
        digests: { sha256: hash },
      });
      failOutbox = true;
      await assert.rejects(
        run((transaction) => successConsumer.consume(transaction, pending.sourceEvent)),
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_eventing.consumer_inbox WHERE event_id=$1",
            [pending.sourceEvent.eventId],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        await run((transaction) =>
          dispositions.loadByPaymentEvent({
            transaction,
            paymentEventReference: pending.sourceEvent.eventId,
          }),
        ),
        null,
      );
      failOutbox = false;
      const confirmed = await run((transaction) =>
        successConsumer.consume(transaction, pending.sourceEvent),
      );
      assert.equal(confirmed.result.status, "OrderConfirmed");
      const repeated = await run((transaction) =>
        successConsumer.consume(transaction, pending.sourceEvent),
      );
      assert.equal(repeated.consumerOutcome.status, "duplicate_completed");
      assert.deepEqual(repeated.result, confirmed.result);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_eventing.outbox_event WHERE causation_id=$1",
            [pending.sourceEvent.eventId],
          )
        ).rows[0].n,
        1,
      );
      const collisionSuccess = successInput(1400);
      const collisionFailure = event(1400);
      const collisions = await Promise.allSettled([
        run((transaction) => dispositions.commitSucceeded({ ...collisionSuccess, transaction })),
        run((transaction) =>
          dispositions.commitFailed({
            sourceEvent: collisionFailure,
            failure: failure(collisionFailure, 1415),
            transaction,
          }),
        ),
      ]);
      assert.equal(collisions.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(collisions.filter((r) => r.status === "rejected").length, 1);
      let loseWorkerCommit = true;
      const discarded = [];
      const worker = new ConsumerDeliveryWorker({
        registry: new ConsumerRegistry(consumer.registrations),
        database: createConsumerDeliveryDatabase({
          acquire: async () => {
            const client = new pg.Client(env.clientConfig);
            await client.connect();
            await client.query("SET ROLE " + role);
            return {
              query: async (sql, values) => {
                const result = await client.query(sql, [...values]);
                if (sql === "COMMIT" && loseWorkerCommit) {
                  loseWorkerCommit = false;
                  throw Error("synthetic committed acknowledgement loss");
                }
                return result;
              },
              release: async (discard) => {
                discarded.push(discard);
                await client.end();
              },
            };
          },
        }),
      });
      const deliveredEvent = event(1500);
      assert.equal(
        (await worker.deliver("ordering.payment-outcome:v1", deliveredEvent)).status,
        "duplicate_completed",
      );
      assert.equal(
        (await worker.deliver("ordering.payment-outcome:v1", deliveredEvent)).status,
        "duplicate_completed",
      );
      assert.equal(discarded[0], true);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_ordering.order_payment_failure_record WHERE payment_event_id=$1",
            [deliveredEvent.eventId],
          )
        ).rows[0].n,
        1,
      );
      await exerciseOrderTermination({
        admin,
        role,
        run,
        id,
        hash,
        setFailAudit: (value) => {
          failAudit = value;
        },
      });
    } finally {
      await admin.end();
    }
  });
});
