import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresDiningBatchCancellationCandidates,
  createPostgresOrderBatchCheckoutCancellationStore,
  createPostgresStaffDiningRoundEntryStore,
  diningCheckoutPaymentWindowMinutes,
  loadOrderBatchCheckoutCancellation,
  orderBatchCheckoutCancellationDigest,
  orderCancelledEventMatchesRecord,
} from "../../rms/ordering/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "0190a7c3-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sha = (c) => "sha256:" + c.repeat(64);
const [tenant, brand, store, otherStore, staff, table, session] = [1, 2, 3, 4, 5, 6, 7].map(id);
const minutes = (n) => n * 60_000;

/**
 * WP-2423 item 5 (DEC-STAFF-DINE-IN-ROUND 实现决定): an unpaid dine-in round with no payment ever
 * started (a round staff entered and nobody recorded as paid on the card machine) is closed when its
 * payment window ends through the same append-only round cancellation as a failed payment, with the
 * reason PAYMENT_NOT_STARTED, and the Order's OrderCancelled event is published in the same
 * transaction. Ordering runs as a restricted NOBYPASSRLS role holding exactly the rendered pilot
 * grants; owner facts are seeded by the isolated database owner (test-only: triggers and foreign keys
 * are skipped for the seed only; the role's writes run every trigger, including migration 2000_056).
 */
it("closes a never-paid staff round with an OrderCancelled event and refuses rounds Ordering saw paid", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_unpaid_round" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_unpaid_" + context.runId,
      worker = "wp2423_unpaid_w_" + context.runId;
    assert.match(role, /^wp2423_unpaid_[a-f0-9]+$/u);
    try {
      for (const name of [role, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api: role, worker }));
      const base = Date.parse(
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString(),
      );
      const time = (offset) => new Date(base + offset).toISOString();
      const createdAt = time(-minutes(41)),
        requestedAt = time(-minutes(40)),
        expiresAt = time(-minutes(10)),
        observedAt = time(-minutes(9));

      /** One dine-in Order with one submitted round, its Dining capacity link and expiry evidence. */
      async function round(
        n,
        storeId,
        { status = "AwaitingPaymentResolution", staffRound = true } = {},
      ) {
        const k = n * 100;
        const refs = {
          order: id(k + 1),
          batch: id(k + 2),
          submission: id(k + 3),
          item: id(k + 4),
          guest: id(k + 5),
          operation: id(k + 6),
          commitment: id(k + 7),
          expiry: id(k + 8),
        };
        await admin.query(
          "INSERT INTO rms_ordering.order_header (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,dining_session_id,created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) VALUES ($1,$2,$3,'2026-10-15',$4,'DineIn','Qr',$5,$6,$6,1,'Submitted','Open','NotReported',$7)",
          [refs.order, brand, storeId, String(n), session, refs.guest, createdAt],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_submission_record (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9)",
          [
            refs.submission,
            brand,
            storeId,
            refs.order,
            refs.guest,
            sha("1"),
            id(k + 9),
            id(k + 10),
            createdAt,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_batch (order_batch_id,brand_id,store_id,order_id,submission_id,source_cart_id,source_cart_version,checkout_validation_id,quote_id,submitted_by_actor_id,submitted_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10)",
          [
            refs.batch,
            brand,
            storeId,
            refs.order,
            refs.submission,
            id(k + 9),
            id(k + 11),
            id(k + 10),
            refs.guest,
            createdAt,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_item (order_item_id,brand_id,store_id,order_id,order_batch_id,source_cart_line_id,quantity,catalog_snapshot_digest,quote_input_digest,transaction_snapshot_json,snapshot_captured_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$7,$8,$9)",
          [
            refs.item,
            brand,
            storeId,
            refs.order,
            refs.batch,
            id(k + 12),
            sha("2"),
            { catalog: {}, pricing: {} },
            createdAt,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'Initial',1,0,NULL,$1,$5)",
          [refs.submission, brand, storeId, refs.order, createdAt],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_capacity_link (brand_id,store_id,submission_id,order_id,order_batch_id,commitment_id,payment_operation_id,created_at,link_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            brand,
            storeId,
            refs.submission,
            refs.order,
            refs.batch,
            refs.commitment,
            refs.operation,
            requestedAt,
            {
              owner: "Dining",
              commitmentReference: refs.commitment,
              commitmentVersion: 1,
              ownerContextReference: session,
              ownerIntentDigest: sha("a"),
              ownerSnapshotDigest: sha("b"),
              brandReference: brand,
              storeReference: storeId,
              orderReference: refs.order,
              orderBatchReference: refs.batch,
              submissionReference: refs.submission,
              cartReference: id(k + 9),
              cartVersion: 1,
              quoteReference: id(k + 10),
              guestSessionReference: refs.guest,
              paymentOperationReference: refs.operation,
              preparedAt: createdAt,
              validUntil: time(minutes(60)),
            },
          ],
        );
        if (staffRound)
          await admin.query(
            "INSERT INTO rms_ordering.staff_dining_round_entry (brand_id,store_id,operation_id,intent_hash,actor_id,table_id,dining_session_id,guest_session_id,tip_selection_id,recorded_after_outage,created_at,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11)",
            [
              brand,
              storeId,
              id(k + 13),
              sha("3"),
              staff,
              table,
              session,
              refs.guest,
              id(k + 14),
              createdAt,
              id(k + 15),
            ],
          );
        const failed = status === "PaymentFailed";
        const expiry = {
          tenantReference: tenant,
          brandReference: brand,
          storeReference: storeId,
          orderReference: refs.order,
          orderBatchReference: refs.batch,
          submissionReference: refs.submission,
          commitmentReference: refs.commitment,
          paymentOperationReference: refs.operation,
          recordReference: refs.expiry,
          previousRecordReference: null,
          version: 1,
          paymentRequestedAt: requestedAt,
          capacityExpiresAt: expiresAt,
          observedAt,
          evidenceDigest: sha(String(n % 10)),
          status,
          paymentEvidence: failed
            ? {
                paymentIntentReference: id(k + 16),
                paymentAttemptReference: id(k + 17),
                paymentEventReference: id(k + 18),
                outcome: "Failed",
                occurredAt: time(-minutes(30)),
              }
            : null,
        };
        await admin.query(
          "INSERT INTO rms_ordering.order_batch_checkout_expiry (record_id,tenant_id,brand_id,store_id,order_id,order_batch_id,submission_id,commitment_id,payment_operation_id,evidence_version,previous_record_id,payment_requested_at,capacity_expires_at,observed_at,evidence_digest,status,payment_intent_id,payment_attempt_id,payment_event_id,payment_outcome,terminal_occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,NULL,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)",
          [
            refs.expiry,
            tenant,
            brand,
            storeId,
            refs.order,
            refs.batch,
            refs.submission,
            refs.commitment,
            refs.operation,
            requestedAt,
            expiresAt,
            observedAt,
            expiry.evidenceDigest,
            status,
            expiry.paymentEvidence?.paymentIntentReference ?? null,
            expiry.paymentEvidence?.paymentAttemptReference ?? null,
            expiry.paymentEvidence?.paymentEventReference ?? null,
            expiry.paymentEvidence?.outcome ?? null,
            expiry.paymentEvidence?.occurredAt ?? null,
          ],
        );
        return { refs, expiry };
      }

      await admin.query("SET session_replication_role = replica");
      let neverPaid, recordedPaid, failedRound, otherStoreRound;
      try {
        neverPaid = await round(1, store);
        // Ordering already recorded a payment for this round (waiting for acceptance).
        recordedPaid = await round(2, store);
        await admin.query(
          "INSERT INTO rms_ordering.order_payment_acceptance_wait (wait_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_event_id,source_digest,evaluated_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            id(290),
            brand,
            store,
            recordedPaid.refs.order,
            recordedPaid.refs.batch,
            recordedPaid.refs.submission,
            id(291),
            sha("4"),
            time(-minutes(20)),
            { synthetic: true },
          ],
        );
        failedRound = await round(3, store, { status: "PaymentFailed", staffRound: false });
        otherStoreRound = await round(4, otherStore);
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      const scoped = async (work, storeId = store) => {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query("SET LOCAL lock_timeout='5s'");
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenant, brand, storeId],
          );
          const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      };
      const scope = { tenantReference: tenant, brandReference: brand, storeReference: store };
      const counts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_ordering.order_batch_checkout_cancellation) AS cancellations," +
              "(SELECT count(*)::int FROM rms_ordering.order_revision WHERE kind='BatchCancellation') AS revisions," +
              "(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE event_type='OrderCancelled') AS events," +
              "(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='ORDERING_BATCH_CHECKOUT_CANCELLED') AS audits",
          )
        ).rows[0];

      // Discovery: the never-paid and the failed rounds of this Store (the service decides from
      // Payment whether an unresolved one may be cancelled). Another Store's round is not seen.
      const discovered = await scoped((tx) =>
        createPostgresDiningBatchCancellationCandidates({
          ...scope,
          authorize: async () => true,
        }).discover(tx, { observedAt: time(0), after: null, limit: 10 }),
      );
      assert.deepEqual(
        discovered.map((entry) => [entry.orderBatchReference, entry.status]),
        [
          [neverPaid.refs.batch, "AwaitingPaymentResolution"],
          [recordedPaid.refs.batch, "AwaitingPaymentResolution"],
          [failedRound.refs.batch, "PaymentFailed"],
        ],
      );

      // Tables page: the staff round at the table awaits its card-machine payment until the deadline.
      const awaiting = (storeId = store) =>
        scoped(
          (tx) =>
            createPostgresStaffDiningRoundEntryStore({
              brandReference: brand,
              storeReference: storeId,
              authorize: async () => true,
            }).listAwaitingPaymentByTables(tx, [table]),
          storeId,
        );
      const payBy = new Date(
        Date.parse(requestedAt) + minutes(diningCheckoutPaymentWindowMinutes),
      ).toISOString();
      assert.deepEqual(await awaiting(), [
        {
          tableReference: table,
          diningSessionReference: session,
          orderReference: neverPaid.refs.order,
          orderBatchReference: neverPaid.refs.batch,
          payBy,
        },
      ]);

      const cancellation = (subject, overrides = {}) => ({
        cancellationReference: id(170),
        operationReference: subject.refs.expiry,
        tenantReference: tenant,
        brandReference: brand,
        storeReference: store,
        orderReference: subject.refs.order,
        orderBatchReference: subject.refs.batch,
        submissionReference: subject.refs.submission,
        paymentOperationReference: subject.refs.operation,
        expiryRecordReference: subject.refs.expiry,
        expiryEvidenceDigest: subject.expiry.evidenceDigest,
        expectedOrderVersion: 1,
        cancelledOrderVersion: 2,
        expectedSourceCheckpoint: subject.refs.submission,
        workflowVersionReference: id(900),
        transitionReference: id(901),
        orderItemReferences: [subject.refs.item],
        cancelledAt: time(-minutes(5)),
        phase: "Cancelled",
        reasonCode: "PAYMENT_NOT_STARTED",
        ...overrides,
      });
      const writer = (subject, eventReference) =>
        createPostgresOrderBatchCheckoutCancellationStore({
          ...scope,
          now: () => new Date().toISOString(),
          authorize: async () => true,
          fence: async () => true,
          source: async () => ({
            expiry: subject.expiry,
            items: [
              {
                orderBatchReference: subject.refs.batch,
                orderItemReference: subject.refs.item,
                phase: "Submitted",
                everAccepted: false,
                everStarted: false,
              },
            ],
            orderVersion: 1,
            checkpoint: subject.refs.submission,
          }),
          workflow: async () => true,
          eventReference: () => eventReference,
          audit: async (record) => ({
            auditId: id(Number.parseInt(record.cancellationReference.slice(-4), 16) + 0x1000),
            brandId: brand,
            storeId: store,
            actor: { type: "System" },
            actionCode: "ORDERING_BATCH_CHECKOUT_CANCELLED",
            targetType: "OrderBatch",
            targetId: record.orderBatchReference,
            correlationId: record.operationReference,
            reasonCode: record.reasonCode,
            occurredAt: record.cancelledAt,
            sourceChannel: "SYSTEM",
            dataClassification: "Restricted",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          }),
        });

      // A round Ordering already recorded as paid is refused by the database itself.
      const before = await counts();
      await assert.rejects(
        scoped((tx) =>
          writer(recordedPaid, id(950)).append(
            tx,
            cancellation(recordedPaid, { cancellationReference: id(260) }),
          ),
        ),
      );
      // A failed payment cannot be cancelled as "no payment started" (the reason follows the evidence).
      await assert.rejects(
        scoped((tx) =>
          writer(failedRound, id(951)).append(
            tx,
            cancellation(failedRound, { cancellationReference: id(360) }),
          ),
        ),
      );
      await assert.rejects(
        scoped((tx) =>
          tx.query(
            "INSERT INTO rms_ordering.order_batch_checkout_cancellation (cancellation_id,operation_id,tenant_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_operation_id,expiry_record_id,expiry_evidence_digest,expected_order_version,cancelled_order_version,expected_source_checkpoint,workflow_version_id,transition_id,order_item_ids,cancelled_at,phase,reason_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,2,$12,$13,$14,$15,$16,'Cancelled','PAYMENT_NOT_STARTED')",
            [
              id(361),
              failedRound.refs.expiry,
              tenant,
              brand,
              store,
              failedRound.refs.order,
              failedRound.refs.batch,
              failedRound.refs.submission,
              failedRound.refs.operation,
              failedRound.refs.expiry,
              failedRound.expiry.evidenceDigest,
              failedRound.refs.submission,
              id(900),
              id(901),
              [failedRound.refs.item],
              time(-minutes(5)),
            ],
          ),
        ),
        /invalid cancellation expiry evidence/u,
      );
      assert.deepEqual(await counts(), before);

      // The never-paid staff round is cancelled: record, revision, Audit and OrderCancelled together.
      const record = cancellation(neverPaid, { cancellationReference: id(160) });
      const created = await scoped((tx) => writer(neverPaid, id(960)).append(tx, record));
      assert.equal(created.status, "Created");
      assert.deepEqual(await counts(), {
        cancellations: before.cancellations + 1,
        revisions: before.revisions + 1,
        events: before.events + 1,
        audits: before.audits + 1,
      });
      const event = (
        await admin.query(
          "SELECT event_id::text AS id,aggregate_type,aggregate_id::text AS aggregate,aggregate_version::int AS version,actor_type,redaction_classification,payload_json AS payload,store_id::text AS store FROM platform_eventing.outbox_event WHERE event_type='OrderCancelled'",
          [],
        )
      ).rows;
      assert.deepEqual(event, [
        {
          id: id(960),
          aggregate_type: "Order",
          aggregate: neverPaid.refs.order,
          version: 2,
          actor_type: "System",
          redaction_classification: "indirect_identifier",
          store,
          payload: {
            orderReference: neverPaid.refs.order,
            orderBatchReference: neverPaid.refs.batch,
            cancellationReference: id(160),
            cancellationScope: "Batch",
            reasonCode: "PAYMENT_NOT_STARTED",
            itemCount: 1,
            cancelledAt: record.cancelledAt,
            sourceDigest: orderBatchCheckoutCancellationDigest(created.record),
          },
        },
      ]);
      // The event states exactly the stored record (what the status projection consumer checks).
      assert.equal(
        await scoped((tx) =>
          orderCancelledEventMatchesRecord(tx, scope, {
            aggregateId: neverPaid.refs.order,
            aggregateVersion: 2n,
            payload: event[0].payload,
          }),
        ),
        true,
      );
      assert.equal(
        await scoped((tx) =>
          orderCancelledEventMatchesRecord(tx, scope, {
            aggregateId: neverPaid.refs.order,
            aggregateVersion: 2n,
            payload: { ...event[0].payload, reasonCode: "CHECKOUT_DEADLINE_REACHED" },
          }),
        ),
        false,
      );
      assert.equal(
        (await scoped((tx) => loadOrderBatchCheckoutCancellation(tx, scope, id(160))))?.reasonCode,
        "PAYMENT_NOT_STARTED",
      );

      // Replay writes nothing and publishes nothing again.
      const replay = await scoped((tx) => writer(neverPaid, id(961)).append(tx, record));
      assert.equal(replay.status, "Existing");
      assert.equal((await counts()).events, before.events + 1);

      // The round no longer waits for payment, nor is it discovered again.
      assert.deepEqual(await awaiting(), []);
      const again = await scoped((tx) =>
        createPostgresDiningBatchCancellationCandidates({
          ...scope,
          authorize: async () => true,
        }).discover(tx, { observedAt: time(0), after: null, limit: 10 }),
      );
      assert.equal(
        again.some((entry) => entry.orderBatchReference === neverPaid.refs.batch),
        false,
      );

      // Another Store sees only its own round, never this Store's cancellation or event.
      assert.deepEqual(
        (await awaiting(otherStore)).map((entry) => entry.orderBatchReference),
        [otherStoreRound.refs.batch],
      );
      assert.equal(
        await scoped(
          (tx) =>
            loadOrderBatchCheckoutCancellation(
              tx,
              { brandReference: brand, storeReference: otherStore },
              id(160),
            ),
          otherStore,
        ),
        null,
      );

      // Append-only history.
      await scoped(async (tx) => {
        await assert.rejects(
          tx.query(
            "UPDATE rms_ordering.order_batch_checkout_cancellation SET reason_code='CHECKOUT_DEADLINE_REACHED'",
            [],
          ),
        );
      }).catch(() => undefined);
      assert.equal(
        (
          await admin.query(
            "SELECT reason_code FROM rms_ordering.order_batch_checkout_cancellation WHERE cancellation_id=$1",
            [id(160)],
          )
        ).rows[0].reason_code,
        "PAYMENT_NOT_STARTED",
      );
    } finally {
      for (const name of [role, worker]) {
        await admin.query("DROP OWNED BY " + name);
        await admin.query("DROP ROLE " + name);
      }
      await admin.end();
    }
  });
});
