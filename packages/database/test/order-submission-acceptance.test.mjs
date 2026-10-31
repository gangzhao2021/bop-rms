import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout } from "node:timers";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  createOrderItemSnapshots,
  encodeOrderItemSnapshot,
  decodeOrderItemSnapshot,
  createPostgresOrderCreationQueryStore,
  createPostgresOrderCreationStore,
  createPostgresOrderCreationRepository,
  createPostgresCapacityLinkedOrderCreationRepository,
  createOrderCreationService,
  createCapacityLinkedOrderCreationService,
  createOrderCreatedEnvelope,
} from "../../rms/ordering/src/index.ts";
import { orderSnapshotInput } from "../../rms/ordering/src/tests/order-item-snapshot.fixture.ts";
import { orderQueryFixture } from "../../rms/ordering/src/tests/order-creation-query.fixture.ts";
import {
  orderWriteFixture,
  orderCapacityLinkFixture,
} from "../../rms/ordering/src/tests/order-creation-store.fixture.ts";
import { orderCreatedSourceInput } from "../../rms/ordering/src/application/order-created-source.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f6100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T18:01:00.000Z";

async function prove(context) {
  const client = new Client(context.clientConfig);
  await client.connect();
  try {
    const forced = await client.query(
      `SELECT relname,relforcerowsecurity FROM pg_class
       WHERE oid IN (
         'rms_ordering.order_header'::regclass,
         'rms_ordering.order_submission_record'::regclass,
         'rms_ordering.order_batch'::regclass,
         'rms_ordering.order_item'::regclass,
         'rms_ordering.order_capacity_link'::regclass,
         'platform_eventing.outbox_event'::regclass
       ) ORDER BY relname`,
    );
    assert.equal(forced.rows.length, 6);
    assert.equal(
      forced.rows.every((row) => row.relforcerowsecurity),
      true,
    );

    await client.query("BEGIN");
    await client.query(
      `INSERT INTO rms_ordering.order_number_counter
       (brand_id,store_id,business_date,next_sequence,updated_at)
       VALUES ($1,$2,'2026-08-02',2,$3)`,
      [id(1), id(2), at],
    );
    await client.query(
      `INSERT INTO rms_ordering.order_number_allocation
       (order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at,
        business_date_configuration_id,business_date_configuration_version,
        business_date_content_digest,time_zone,business_day_start,business_date_boundary_at,
        boundary_disambiguation)
       VALUES ($1,$2,$3,'2026-08-02',1,'1',$4,$5,1,$6,
        'America/Toronto','04:00:00','2026-08-02T08:00:00.000Z','Exact')`,
      [id(10), id(1), id(2), at, id(3), `sha256:${"a".repeat(64)}`],
    );
    await client.query(
      `INSERT INTO rms_ordering.order_header
       (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,
        created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,
        closure_status,payment_status,created_at)
       VALUES ($1,$2,$3,'2026-08-02','1','Pickup','Qr',$4,$4,1,'Submitted','Open',
        'NotReported',$5)`,
      [id(10), id(1), id(2), id(4), at],
    );
    await client.query(
      `INSERT INTO rms_ordering.order_submission_record
       (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,
        source_cart_id,source_cart_version,quote_id,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,5,$8,$9)`,
      [id(11), id(1), id(2), id(10), id(4), `sha256:${"b".repeat(64)}`, id(12), id(13), at],
    );
    await client.query(
      `INSERT INTO rms_ordering.order_batch
       (order_batch_id,brand_id,store_id,order_id,submission_id,source_cart_id,
        source_cart_version,checkout_validation_id,quote_id,submitted_by_actor_id,submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,5,$7,$8,$9,$10)`,
      [id(14), id(1), id(2), id(10), id(11), id(12), id(15), id(13), id(4), at],
    );
    await client.query(
      `INSERT INTO rms_ordering.order_item
       (order_item_id,brand_id,store_id,order_id,order_batch_id,source_cart_line_id,quantity,
        catalog_snapshot_digest,quote_input_digest,transaction_snapshot_json,snapshot_captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,2,$7,$8,$9::jsonb,$10)`,
      [
        id(16),
        id(1),
        id(2),
        id(10),
        id(14),
        id(17),
        `sha256:${"c".repeat(64)}`,
        `sha256:${"d".repeat(64)}`,
        JSON.stringify({
          catalog: { localizedNames: { "en-CA": "Synthetic item" }, options: [] },
          pricing: { total: { amountMinor: "1130", currencyCode: "CAD" } },
        }),
        at,
      ],
    );
    await client.query(
      `INSERT INTO platform_eventing.outbox_event
       (event_id,event_type,schema_version,producer_module,brand_id,store_id,aggregate_type,
        aggregate_id,aggregate_version,correlation_id,causation_id,actor_type,actor_id,payload_json,
        redaction_classification,replay_metadata_json,occurred_at,available_at)
       VALUES ($1,'OrderCreated',1,'@rms/ordering',$2,$3,'Order',$4,1,$5,$6,'System',NULL,
        $7::jsonb,'indirect_identifier','{"replaySafe":true}'::jsonb,$8,$8)`,
      [
        id(70),
        id(1),
        id(2),
        id(10),
        id(71),
        id(11),
        JSON.stringify({
          orderReference: id(10),
          orderBatchReference: id(14),
          submissionReference: id(11),
          businessDate: "2026-08-02",
          sourceSnapshotDigest: `sha256:${"f".repeat(64)}`,
          itemCount: 1,
        }),
        at,
      ],
    );
    await client.query("COMMIT");

    const snapshot = await client.query(
      `SELECT header.order_number,submission.submission_id,submission.submission_kind,item.transaction_snapshot_json
       FROM rms_ordering.order_header AS header
       JOIN rms_ordering.order_submission_record AS submission USING (order_id,brand_id,store_id)
       JOIN rms_ordering.order_item AS item USING (order_id,brand_id,store_id)
       WHERE header.order_id=$1`,
      [id(10)],
    );
    assert.equal(snapshot.rowCount, 1);
    assert.equal(snapshot.rows[0].order_number, "1");
    assert.equal(snapshot.rows[0].submission_kind, "Initial");
    assert.equal(snapshot.rows[0].transaction_snapshot_json.pricing.total.amountMinor, "1130");
    const outbox = await client.query(
      `SELECT event_type,schema_version,producer_module,brand_id::text,store_id::text,
       aggregate_id::text,aggregate_version,actor_type,redaction_classification,payload_json
       FROM platform_eventing.outbox_event WHERE event_id=$1`,
      [id(70)],
    );
    assert.equal(outbox.rowCount, 1);
    assert.deepEqual(outbox.rows[0], {
      event_type: "OrderCreated",
      schema_version: 1,
      producer_module: "@rms/ordering",
      brand_id: id(1),
      store_id: id(2),
      aggregate_id: id(10),
      aggregate_version: "1",
      actor_type: "System",
      redaction_classification: "indirect_identifier",
      payload_json: {
        orderReference: id(10),
        orderBatchReference: id(14),
        submissionReference: id(11),
        businessDate: "2026-08-02",
        sourceSnapshotDigest: `sha256:${"f".repeat(64)}`,
        itemCount: 1,
      },
    });

    await assert.rejects(
      client.query(
        `INSERT INTO rms_ordering.order_submission_record
         (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,
          source_cart_id,source_cart_version,quote_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,5,$8,$9)`,
        [id(11), id(1), id(2), id(18), id(4), `sha256:${"e".repeat(64)}`, id(12), id(13), at],
      ),
      /order_submission_record_pkey/u,
    );
    await client.query(
      `UPDATE rms_ordering.order_header SET order_number='999' WHERE order_id=$1`,
      [id(10)],
    );
    assert.equal(
      (
        await client.query(`SELECT order_number FROM rms_ordering.order_header WHERE order_id=$1`, [
          id(10),
        ])
      ).rows[0].order_number,
      "1",
    );
    await client.query(`DELETE FROM rms_ordering.order_header WHERE order_id=$1`, [id(10)]);
    assert.equal(
      (
        await client.query(
          `SELECT count(*)::integer AS count FROM rms_ordering.order_header WHERE order_id=$1`,
          [id(10)],
        )
      ).rows[0].count,
      1,
    );
    await client.query(`DELETE FROM rms_ordering.order_item WHERE order_item_id=$1`, [id(16)]);
    assert.equal(
      (await client.query(`SELECT count(*)::integer AS count FROM rms_ordering.order_item`)).rows[0]
        .count,
      1,
    );

    await client.query("BEGIN");
    await client.query(
      `INSERT INTO rms_ordering.order_number_counter
       (brand_id,store_id,business_date,next_sequence,updated_at)
       VALUES ($1,$2,'2026-08-03',2,$3)`,
      [id(1), id(2), at],
    );
    await client.query("ROLLBACK");
    assert.equal(
      (
        await client.query(
          `SELECT count(*)::integer AS count FROM rms_ordering.order_number_counter
           WHERE business_date='2026-08-03'`,
        )
      ).rows[0].count,
      0,
    );

    await client.query("BEGIN");
    await client.query(
      `INSERT INTO rms_ordering.order_number_counter
       (brand_id,store_id,business_date,next_sequence,updated_at)
       VALUES ($1,$2,'2026-08-04',2,$3)`,
      [id(1), id(2), at],
    );
    await client.query(
      `INSERT INTO rms_ordering.order_number_allocation
       (order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at,
        business_date_configuration_id,business_date_configuration_version,
        business_date_content_digest,time_zone,business_day_start,business_date_boundary_at,
        boundary_disambiguation)
       VALUES ($1,$2,$3,'2026-08-04',1,'1',$4,$5,1,$6,
        'America/Toronto','04:00:00','2026-08-04T08:00:00.000Z','Exact')`,
      [id(80), id(1), id(2), at, id(3), `sha256:${"a".repeat(64)}`],
    );
    await client.query(
      `INSERT INTO rms_ordering.order_header
       (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,
        created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,
        closure_status,payment_status,created_at)
       VALUES ($1,$2,$3,'2026-08-04','1','Pickup','Qr',$4,$4,1,'Submitted','Open',
        'NotReported',$5)`,
      [id(80), id(1), id(2), id(4), at],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO platform_eventing.outbox_event
         (event_id,event_type,schema_version,producer_module,brand_id,store_id,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,actor_type,actor_id,payload_json,
          redaction_classification,replay_metadata_json,occurred_at,available_at)
         VALUES ($1,'OrderCreated',1,'@rms/ordering',$2,$3,'Order',$4,1,$5,$6,'System',NULL,
          '{}'::jsonb,'indirect_identifier','{"replaySafe":true}'::jsonb,$7,$7)`,
        [id(70), id(1), id(2), id(80), id(71), id(81), at],
      ),
      /outbox_event_pkey/u,
    );
    await client.query("ROLLBACK");
    assert.equal(
      (
        await client.query(
          `SELECT count(*)::integer AS count FROM rms_ordering.order_header WHERE order_id=$1`,
          [id(80)],
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (
        await client.query(
          `SELECT count(*)::integer AS count FROM rms_ordering.order_number_allocation WHERE order_id=$1`,
          [id(80)],
        )
      ).rows[0].count,
      0,
    );

    // WP-2348: new complete JSONB data and explicit order coexist with unknown legacy order.
    const legacy = (
      await client.query("SELECT ordinal FROM rms_ordering.order_item WHERE order_item_id=$1", [
        id(16),
      ])
    ).rows[0];
    assert.equal(legacy.ordinal, null);
    const sample = createOrderItemSnapshots(orderSnapshotInput())[0];
    assert(sample);
    const largeFee = 9007199254740993n;
    const complete = (item, line) => ({
      ...sample,
      orderItemReference: id(item),
      orderBatchReference: id(14),
      cartItemReference: id(line),
      catalog: { ...sample.catalog, brandReference: id(1), storeReference: id(2) },
      pricing: {
        ...sample.pricing,
        quoteReference: id(13),
        lineReference: id(line),
        priceResolution: { ...sample.pricing.priceResolution, scopeReference: id(2) },
        fee: { amountMinor: largeFee, currencyCode: "CAD" },
        total: { amountMinor: largeFee + 2260n, currencyCode: "CAD" },
      },
    });
    const insertOrdered = (item, line, ordinal) =>
      client.query(
        `INSERT INTO rms_ordering.order_item
      (order_item_id,brand_id,store_id,order_id,order_batch_id,source_cart_line_id,quantity,
       catalog_snapshot_digest,quote_input_digest,transaction_snapshot_json,snapshot_captured_at,ordinal)
      VALUES ($1,$2,$3,$4,$5,$6,2,$7,$8,$9::jsonb,$10,$11)`,
        [
          id(item),
          id(1),
          id(2),
          id(10),
          id(14),
          id(line),
          sample.catalog.snapshotDigest,
          sample.pricing.quoteInputDigest,
          encodeOrderItemSnapshot(complete(item, line)),
          at,
          ordinal,
        ],
      );
    await client.query("BEGIN");
    try {
      await insertOrdered(96, 97, 2);
      await insertOrdered(98, 99, 1);
      const ordered = (
        await client.query(
          `SELECT order_item_id,ordinal,transaction_snapshot_json
        FROM rms_ordering.order_item WHERE order_batch_id=$1 AND ordinal IS NOT NULL ORDER BY ordinal`,
          [id(14)],
        )
      ).rows;
      assert.deepEqual(
        ordered.map((row) => row.order_item_id),
        [id(98), id(96)],
      );
      assert.equal(
        ordered[0].transaction_snapshot_json.pricing.fee.amountMinor,
        "9007199254740993",
      );
      assert.deepEqual(
        decodeOrderItemSnapshot(ordered[0].transaction_snapshot_json),
        complete(98, 99),
      );
      for (const ordinal of [0, 101, 1]) {
        await client.query("SAVEPOINT ordinal_rejection");
        await assert.rejects(
          insertOrdered(100, 101, ordinal),
          /order_item_ordinal_check|order_item_batch_ordinal_unique/u,
        );
        await client.query("ROLLBACK TO SAVEPOINT ordinal_rejection");
        await client.query("RELEASE SAVEPOINT ordinal_rejection");
      }
      await client.query("UPDATE rms_ordering.order_item SET ordinal=3 WHERE order_item_id=$1", [
        id(96),
      ]);
      assert.equal(
        (
          await client.query("SELECT ordinal FROM rms_ordering.order_item WHERE order_item_id=$1", [
            id(96),
          ])
        ).rows[0].ordinal,
        2,
      );
    } finally {
      await client.query("ROLLBACK");
    }

    // WP-2350: read complete original history through the actual owner adapter.
    async function seedHistory(seeded, microseconds = false) {
      const n = seeded.orderNumberAllocation,
        r = seeded.order,
        b = r.batches[0];
      await client.query("BEGIN");
      try {
        await client.query(
          `INSERT INTO rms_ordering.order_number_allocation
      (order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at,
       business_date_configuration_id,business_date_configuration_version,business_date_content_digest,
       time_zone,business_day_start,business_date_boundary_at,boundary_disambiguation)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            n.orderReference,
            n.brandReference,
            n.storeReference,
            n.businessDate,
            n.sequence.toString(),
            n.orderNumber,
            microseconds ? n.allocatedAt.replace(".000Z", ".000001Z") : n.allocatedAt,
            n.businessDateResolution.configurationReference,
            n.businessDateResolution.configurationVersion,
            n.businessDateResolution.contentDigest,
            n.businessDateResolution.timeZone,
            n.businessDateResolution.businessDayStartLocalTime,
            n.businessDateResolution.businessDateBoundaryAt,
            n.businessDateResolution.boundaryDisambiguation,
          ],
        );
        await client.query(
          `INSERT INTO rms_ordering.order_header
      (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,dining_session_id,
       created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            r.orderReference,
            r.brandReference,
            r.storeReference,
            n.businessDate,
            n.orderNumber,
            r.orderType,
            r.sourceChannel,
            r.diningSessionReference,
            r.createdByActorReference,
            r.submittedByActorReference,
            r.aggregateVersion,
            r.canonicalPhase,
            r.closureStatus,
            r.paymentStatus,
            r.createdAt,
          ],
        );
        await client.query(
          `INSERT INTO rms_ordering.order_submission_record
      (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            seeded.submissionReference,
            r.brandReference,
            r.storeReference,
            r.orderReference,
            seeded.guestSessionReference,
            seeded.submissionIntentHash,
            b.sourceCartReference,
            b.sourceCartVersion,
            b.quoteReference,
            seeded.createdAt,
          ],
        );
        await client.query(
          `INSERT INTO rms_ordering.order_batch
      (order_batch_id,brand_id,store_id,order_id,submission_id,source_cart_id,source_cart_version,
       checkout_validation_id,quote_id,submitted_by_actor_id,submitted_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            b.orderBatchReference,
            r.brandReference,
            r.storeReference,
            r.orderReference,
            b.submissionReference,
            b.sourceCartReference,
            b.sourceCartVersion,
            b.checkoutValidationReference,
            b.quoteReference,
            b.submittedByActorReference,
            b.submittedAt,
          ],
        );
        // Insert physically in reverse order; only the immutable ordinal establishes original order.
        for (const [index, item] of [...seeded.items.entries()].reverse()) {
          await client.query(
            `INSERT INTO rms_ordering.order_item
        (order_item_id,brand_id,store_id,order_id,order_batch_id,source_cart_line_id,quantity,
         catalog_snapshot_digest,quote_input_digest,transaction_snapshot_json,snapshot_captured_at,ordinal)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
            [
              item.orderItemReference,
              r.brandReference,
              r.storeReference,
              r.orderReference,
              item.orderBatchReference,
              item.cartItemReference,
              item.quantity,
              item.catalog.snapshotDigest,
              item.pricing.quoteInputDigest,
              encodeOrderItemSnapshot(item),
              item.snapshotCapturedAt,
              index + 1,
            ],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    const seeded = orderQueryFixture().record;
    await seedHistory(seeded);
    const r = seeded.order;
    const runner = {
      async run(action) {
        await client.query("BEGIN");
        try {
          const value = await action({ query: (sql, values) => client.query(sql, [...values]) });
          assert.equal(
            (await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only,
            "on",
          );
          await client.query("SAVEPOINT deny_write");
          await assert.rejects(
            client.query(
              "UPDATE rms_ordering.order_number_counter SET next_sequence=next_sequence",
            ),
            /read-only transaction/u,
          );
          await client.query("ROLLBACK TO SAVEPOINT deny_write");
          await client.query("RELEASE SAVEPOINT deny_write");
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      },
    };
    const reader = createPostgresOrderCreationQueryStore(runner, {
      brandReference: r.brandReference,
      storeReference: r.storeReference,
    });
    assert.deepEqual(await reader.resolveSubmission(seeded.submissionReference), seeded);
    assert.deepEqual(await reader.resolveSubmission(seeded.submissionReference), seeded);
    assert.equal(await reader.resolveSubmission(id(199)), null);
    assert.equal(
      await createPostgresOrderCreationQueryStore(runner, {
        brandReference: r.brandReference,
        storeReference: id(199),
      }).resolveSubmission(seeded.submissionReference),
      null,
    );
    await assert.rejects(
      createPostgresOrderCreationQueryStore(runner, {
        brandReference: id(1),
        storeReference: id(2),
      }).resolveSubmission(id(11)),
      { code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE" },
    );
    const remap = (value) => {
      if (
        typeof value === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
      )
        return "1" + value.slice(1);
      if (Array.isArray(value)) return value.map(remap);
      if (value !== null && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, remap(entry)]));
      return value;
    };
    const submillisecond = remap(seeded);
    await seedHistory(submillisecond, true);
    await assert.rejects(
      createPostgresOrderCreationQueryStore(runner, {
        brandReference: submillisecond.order.brandReference,
        storeReference: submillisecond.order.storeReference,
      }).resolveSubmission(submillisecond.submissionReference),
      { code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE" },
    );
    const cleared = (
      await client.query(
        "SELECT current_setting('bop.brand_id',true) AS brand,current_setting('bop.store_id',true) AS store",
      )
    ).rows[0];
    assert([null, ""].includes(cleared.brand));
    assert([null, ""].includes(cleared.store));

    // WP-2352 synthetic current Cart sources and actual atomic writer transactions.
    async function seedCart(f) {
      const c = f.cart,
        l = c.lifecycle;
      assert(l);
      await client.query(
        `INSERT INTO rms_ordering.cart
      (cart_id,brand_id,store_id,order_type,source_channel,dining_session_id,created_by_actor_id,
       aggregate_version,created_at,updated_at,lifecycle_status,lifecycle_policy_version_id,lifecycle_policy_digest,
       idle_timeout_seconds,absolute_timeout_seconds,idle_expires_at,absolute_expires_at,terminal_at,terminal_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          c.cartReference,
          c.brandReference,
          c.storeReference,
          c.orderType,
          c.sourceChannel,
          c.diningSessionReference,
          c.createdByActorReference,
          c.aggregateVersion,
          c.createdAt,
          c.updatedAt,
          l.status,
          l.policyVersionReference,
          l.policyDigest,
          l.idleTimeoutSeconds,
          l.absoluteTimeoutSeconds,
          l.idleExpiresAt,
          l.absoluteExpiresAt,
          l.terminalAt,
          l.terminalReason,
        ],
      );
      for (const item of c.items)
        await client.query(
          `INSERT INTO rms_ordering.cart_line
      (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,option_selections_json,customer_note,
       catalog_selection_evidence_json,added_by_actor_id,added_by_participant_id,added_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12)`,
          [
            item.cartItemReference,
            c.cartReference,
            c.brandReference,
            c.storeReference,
            item.sellableReference,
            item.quantity,
            JSON.stringify(item.optionSelections),
            item.customerNote,
            JSON.stringify(item.catalogSelectionEvidence),
            item.addedByActorReference,
            item.addedByParticipantReference,
            item.addedAt,
          ],
        );
    }
    function writerRunner(options = {}) {
      return {
        async run(action) {
          const connection = new Client({
            ...context.clientConfig,
            application_name: options.name ?? "bop_wp2352_writer",
          });
          await connection.connect();
          let committed = false;
          try {
            await connection.query("BEGIN");
            const value = await action({
              async query(sql, values) {
                if (options.fail && sql.includes(options.fail))
                  throw new Error("synthetic write failure");
                const result = await connection.query(sql, [...values]);
                if (options.afterLock && sql.startsWith("SELECT pg_advisory_xact_lock"))
                  await options.afterLock();
                if (options.afterAudit && sql.startsWith("INSERT INTO platform_audit.audit_record"))
                  await options.afterAudit();
                return result;
              },
            });
            await connection.query("COMMIT");
            committed = true;
            if (options.loseAck) throw new Error("synthetic lost acknowledgement");
            return value;
          } catch (error) {
            if (!committed) await connection.query("ROLLBACK");
            throw error;
          } finally {
            await connection.end();
          }
        },
      };
    }
    async function counts(f) {
      const result = await client.query(
        `SELECT
      (SELECT count(*)::int FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2) AS orders,
      (SELECT count(*)::int FROM rms_ordering.order_number_counter WHERE brand_id=$1 AND store_id=$2) AS counters,
      (SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1 AND store_id=$2) AS audits,
      (SELECT count(*)::int FROM platform_eventing.outbox_event WHERE brand_id=$1 AND store_id=$2) AS events`,
        [f.scope.brandReference, f.scope.storeReference],
      );
      return result.rows[0];
    }
    for (const [index, fail] of [
      "INSERT INTO platform_audit.audit_record",
      "INSERT INTO platform_eventing.outbox_event",
    ].entries()) {
      const f = orderWriteFixture({ namespace: "018f780" + index });
      await seedCart(f);
      await assert.rejects(
        createPostgresOrderCreationStore(writerRunner({ fail }), f.scope).append(f.request),
        { code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE" },
      );
      assert.deepEqual(await counts(f), { orders: 0, counters: 0, audits: 0, events: 0 });
      const result = await createPostgresOrderCreationStore(writerRunner(), f.scope).append(
        f.request,
      );
      assert.equal(result.status, "Created");
      assert.equal(result.record.orderNumberAllocation.sequence, 1n);
      assert.deepEqual(await counts(f), { orders: 1, counters: 1, audits: 1, events: 1 });
    }
    const lost = orderWriteFixture({ namespace: "018f7802" });
    await seedCart(lost);
    await assert.rejects(
      createPostgresOrderCreationStore(writerRunner({ loseAck: true }), lost.scope).append(
        lost.request,
      ),
      { code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE" },
    );
    const recovered = await createPostgresOrderCreationStore(writerRunner(), lost.scope).append(
      lost.request,
    );
    assert.equal(recovered.status, "Existing");
    assert.deepEqual(await counts(lost), { orders: 1, counters: 1, audits: 1, events: 1 });
    assert.deepEqual(recovered.record.items, lost.request.record.items);
    const concurrent = orderWriteFixture({ namespace: "018f7803" });
    await seedCart(concurrent);
    let releaseLock, signalLocked;
    const held = new Promise((resolve) => {
      signalLocked = resolve;
    });
    const release = new Promise((resolve) => {
      releaseLock = resolve;
    });
    const first = createPostgresOrderCreationStore(
      writerRunner({
        afterLock: async () => {
          signalLocked();
          await release;
        },
      }),
      concurrent.scope,
    ).append(concurrent.request);
    await held;
    const second = createPostgresOrderCreationStore(
      writerRunner({ name: "bop_wp2352_waiter" }),
      concurrent.scope,
    ).append(concurrent.request);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        waiting = (
          await client.query(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='bop_wp2352_waiter' AND wait_event='advisory') AS waiting",
          )
        ).rows[0].waiting;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert(waiting, "second writer must actually wait on the first submission lock");
    } finally {
      releaseLock();
    }
    const outcomes = await Promise.all([first, second]);
    assert.deepEqual(
      outcomes.map((x) => x.status),
      ["Created", "Existing"],
    );
    assert.deepEqual(outcomes[0].record, outcomes[1].record);
    assert.deepEqual(await counts(concurrent), { orders: 1, counters: 1, audits: 1, events: 1 });
    const stale = orderWriteFixture({ namespace: "018f7804" });
    await seedCart(stale);
    await client.query(
      "UPDATE rms_ordering.cart SET aggregate_version=aggregate_version+1 WHERE cart_id=$1",
      [stale.cart.cartReference],
    );
    await assert.rejects(
      createPostgresOrderCreationStore(writerRunner(), stale.scope).append(stale.request),
      { code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE" },
    );
    assert.deepEqual(await counts(stale), { orders: 0, counters: 0, audits: 0, events: 0 });
    const expired = orderWriteFixture({
      namespace: "018f7805",
      at: new Date(Date.now() - 600000).toISOString(),
    });
    await seedCart(expired);
    await assert.rejects(
      createPostgresOrderCreationStore(writerRunner(), expired.scope).append(expired.request),
      { code: "ORDER_CREATE_VALIDATION_EXPIRED" },
    );
    assert.deepEqual(await counts(expired), { orders: 0, counters: 0, audits: 0, events: 0 });
    const late = orderWriteFixture({ namespace: "018f7806" });
    await seedCart(late);
    const expires = new Date(Date.now() + 1000).toISOString();
    const lateRequest = {
      ...late.request,
      checkoutValidationEvidence: {
        ...late.request.checkoutValidationEvidence,
        validUntil: expires,
      },
    };
    await assert.rejects(
      createPostgresOrderCreationStore(
        writerRunner({
          afterAudit: async () => {
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(0, Date.parse(expires) - Date.now() + 25)),
            );
          },
        }),
        late.scope,
      ).append(lateRequest),
      { code: "ORDER_CREATE_VALIDATION_EXPIRED" },
    );
    assert.deepEqual(await counts(late), { orders: 0, counters: 0, audits: 0, events: 0 });

    const replacementIds = new Map([
      [lost.request.record.order.orderReference, "018f7802-0000-7000-8000-000000000700"],
      [
        lost.request.record.order.batches[0].orderBatchReference,
        "018f7802-0000-7000-8000-000000000701",
      ],
      [lost.request.record.items[0].orderItemReference, "018f7802-0000-7000-8000-000000000702"],
    ]);
    const replaceIds = (value) => {
      if (typeof value === "string") return replacementIds.get(value) ?? value;
      if (Array.isArray(value)) return value.map(replaceIds);
      if (value !== null && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, replaceIds(v)]));
      return value;
    };
    const alternate = replaceIds(lost.request);
    alternate.event = createOrderCreatedEnvelope({
      eventReference: alternate.event.eventId,
      correlationReference: alternate.audit.correlationId,
      sourceSnapshotDigest:
        "sha256:" +
        createHash("sha256")
          .update(orderCreatedSourceInput(alternate.record, alternate.businessDateResolution))
          .digest("hex"),
      businessDate: alternate.businessDateResolution.businessDate,
      record: alternate.record,
    });
    const alternateResult = await createPostgresOrderCreationStore(
      writerRunner(),
      lost.scope,
    ).append(alternate);
    assert.deepEqual(alternateResult, recovered);
    await assert.rejects(
      createPostgresOrderCreationStore(writerRunner(), {
        ...lost.scope,
        storeReference: id(399),
      }).append(lost.request),
      { code: "ORDER_CREATE_INPUT_INVALID" },
    );
    const exhausted = orderWriteFixture({ namespace: "018f7807" });
    await seedCart(exhausted);
    await client.query(
      `INSERT INTO rms_ordering.order_number_counter
      (brand_id,store_id,business_date,next_sequence,updated_at) VALUES ($1,$2,$3,9223372036854775807,$4)`,
      [
        exhausted.scope.brandReference,
        exhausted.scope.storeReference,
        exhausted.request.businessDateResolution.businessDate,
        exhausted.request.record.createdAt,
      ],
    );
    await assert.rejects(
      createPostgresOrderCreationStore(writerRunner(), exhausted.scope).append(exhausted.request),
      { code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE" },
    );
    assert.deepEqual(await counts(exhausted), { orders: 0, counters: 1, audits: 0, events: 0 });
    assert.equal(
      (
        await client.query(
          "SELECT next_sequence::text AS sequence FROM rms_ordering.order_number_counter WHERE brand_id=$1 AND store_id=$2",
          [exhausted.scope.brandReference, exhausted.scope.storeReference],
        )
      ).rows[0].sequence,
      "9223372036854775807",
    );

    // WP-2353: the actual application consumes explicit Created/Existing repository outcomes.
    function application(f, variant = 0) {
      const reference = (purpose) => {
        if (purpose === "CheckoutValidation")
          return f.request.checkoutValidationEvidence.validationReference;
        if (variant === 0)
          return {
            Order: f.request.record.order.orderReference,
            OrderBatch: f.request.record.order.batches[0].orderBatchReference,
            OrderItem: f.request.record.items[0].orderItemReference,
            Event: f.request.event.eventId,
          }[purpose];
        return { Order: id(930), OrderBatch: id(931), OrderItem: id(932), Event: id(933) }[purpose];
      };
      const repository = createPostgresOrderCreationRepository(
        { query: writerRunner(), write: writerRunner() },
        f.scope,
      );
      const guest = {
        sessionReference: f.request.record.guestSessionReference,
        status: "Active",
        version: 1,
        brandReference: f.scope.brandReference,
        storeReference: f.scope.storeReference,
        publicStoreReference: id(900),
        publicTableReference: f.cart.orderType === "DineIn" ? id(903) : null,
        channel: f.cart.orderType,
        locale: "en-CA",
        qrReference: id(901),
        qrRevocationVersion: 1,
        diningState: f.cart.orderType === "DineIn" ? "DiningBound" : "ContextOnly",
        diningSessionReference: f.cart.diningSessionReference,
        diningParticipantReference:
          f.cart.orderType === "DineIn" ? f.cart.items[0].addedByParticipantReference : null,
        createdAt: f.cart.createdAt,
        lastSeenAt: f.request.record.createdAt,
        idleExpiresAt: new Date(
          Date.parse(f.request.record.createdAt) + 4 * 60 * 60 * 1000,
        ).toISOString(),
        absoluteExpiresAt: new Date(
          Date.parse(f.cart.createdAt) + 24 * 60 * 60 * 1000,
        ).toISOString(),
        orderClosedAt: null,
        closureExpiresAt: null,
        rotatedFromGuestSessionReference: f.cart.orderType === "DineIn" ? id(904) : null,
        revocationReason: null,
        revokedAt: null,
      };
      const ports = {
        clock: { now: () => new Date().toISOString() },
        authorization: {
          async authorize() {
            return { guestSession: guest };
          },
        },
        checkout: {
          async validate() {
            return f.request.checkoutValidationEvidence;
          },
        },
        source: {
          async load() {
            return {
              cart: f.cart,
              lines: f.request.record.items.map((item) => ({
                cartItemReference: item.cartItemReference,
                catalog: item.catalog,
                pricing: item.pricing,
              })),
            };
          },
        },
        businessDate: {
          async resolve() {
            return f.request.businessDateResolution;
          },
        },
        audit: {
          async create(input) {
            return {
              ...f.request.audit,
              targetId: input.order.orderReference,
              auditId: variant === 0 ? f.request.audit.auditId : id(934),
              correlationId: variant === 0 ? f.request.audit.correlationId : id(935),
            };
          },
        },
        references: {
          generate: reference,
          hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
          equals: (a, b) => a === b,
        },
        repository,
      };
      return { ports, service: createOrderCreationService(ports) };
    }
    // WP-2402: required owner-capacity link is part of the same original Order transaction.
    const linkCount = async (f) =>
      Number(
        (
          await client.query(
            "SELECT count(*)::text AS count FROM rms_ordering.order_capacity_link WHERE brand_id=$1 AND store_id=$2",
            [f.scope.brandReference, f.scope.storeReference],
          )
        ).rows[0].count,
      );
    const linked = (f, options = {}, link = orderCapacityLinkFixture(f)) =>
      createPostgresCapacityLinkedOrderCreationRepository(
        { query: writerRunner(), write: writerRunner(options) },
        f.scope,
        link,
      );
    for (const [index, fail] of [
      "INSERT INTO rms_ordering.order_capacity_link",
      "INSERT INTO platform_audit.audit_record",
      "INSERT INTO platform_eventing.outbox_event",
    ].entries()) {
      const f = orderWriteFixture({ namespace: "018f791" + index, dineIn: true });
      await seedCart(f);
      await assert.rejects(linked(f, { fail }).commit(f.request), {
        code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
      });
      assert.deepEqual(await counts(f), { orders: 0, counters: 0, audits: 0, events: 0 });
      assert.equal(await linkCount(f), 0);
      const saved = await linked(f).commit(f.request);
      assert.equal(saved.status, "Created");
      assert.deepEqual(
        await linked(f).resolveCapacityLink(f.request.record.submissionReference),
        orderCapacityLinkFixture(f),
      );
      assert.deepEqual(await counts(f), { orders: 1, counters: 1, audits: 1, events: 1 });
      assert.equal(await linkCount(f), 1);
    }
    // Pickup uses the same atomic Ordering write and original owner-link recovery.
    const pickupLinked = orderWriteFixture({ namespace: "018f7920" });
    await seedCart(pickupLinked);
    await assert.rejects(linked(pickupLinked, { loseAck: true }).commit(pickupLinked.request), {
      code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
    });
    assert.equal((await linked(pickupLinked).commit(pickupLinked.request)).status, "Existing");
    assert.deepEqual(
      await linked(pickupLinked).resolveCapacityLink(
        pickupLinked.request.record.submissionReference,
      ),
      orderCapacityLinkFixture(pickupLinked),
    );
    assert.equal(await linkCount(pickupLinked), 1);
    assert.deepEqual(await counts(pickupLinked), { orders: 1, counters: 1, audits: 1, events: 1 });
    await client.query("BEGIN");
    try {
      await assert.rejects(
        client.query(
          "INSERT INTO rms_ordering.order_capacity_link (brand_id,store_id,submission_id,order_id,order_batch_id,commitment_id,payment_operation_id,created_at,link_json) " +
            "SELECT brand_id,store_id,submission_id,order_id,order_batch_id,commitment_id,payment_operation_id,created_at," +
            "jsonb_set(link_json,'{owner}',to_jsonb('Dining'::text)) FROM rms_ordering.order_capacity_link WHERE brand_id=$1 AND store_id=$2",
          [pickupLinked.scope.brandReference, pickupLinked.scope.storeReference],
        ),
        { code: "23514" },
      );
    } finally {
      await client.query("ROLLBACK");
    }
    const capacityRace = orderWriteFixture({ namespace: "018f7913", dineIn: true });
    await seedCart(capacityRace);
    const capacityResults = await Promise.all([
      linked(capacityRace).commit(capacityRace.request),
      linked(capacityRace).commit(capacityRace.request),
    ]);
    assert.deepEqual(capacityResults.map((r) => r.status).sort(), ["Created", "Existing"]);
    assert.equal(await linkCount(capacityRace), 1);
    const capacityLost = orderWriteFixture({ namespace: "018f7914", dineIn: true });
    await seedCart(capacityLost);
    await assert.rejects(linked(capacityLost, { loseAck: true }).commit(capacityLost.request), {
      code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
    });
    const originalLink = orderCapacityLinkFixture(capacityLost);
    assert.deepEqual(
      await linked(capacityLost).resolveCapacityLink(
        capacityLost.request.record.submissionReference,
      ),
      originalLink,
    );
    assert.equal((await linked(capacityLost).commit(capacityLost.request)).status, "Existing");
    const different = { ...originalLink, paymentOperationReference: id(9001) };
    await assert.rejects(linked(capacityLost, {}, different).commit(capacityLost.request), {
      code: "ORDER_CREATE_IDEMPOTENCY_CONFLICT",
    });
    await assert.rejects(
      linked(capacityLost, {}, different).resolveSubmission(
        capacityLost.request.record.submissionReference,
      ),
      { code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE" },
    );
    const legacyDining = orderWriteFixture({ namespace: "018f7915", dineIn: true });
    await seedCart(legacyDining);
    await createPostgresOrderCreationStore(writerRunner(), legacyDining.scope).append(
      legacyDining.request,
    );
    await assert.rejects(
      linked(legacyDining).resolveSubmission(legacyDining.request.record.submissionReference),
      { code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE" },
    );
    await assert.rejects(linked(legacyDining).commit(legacyDining.request), {
      code: "ORDER_CREATE_IDEMPOTENCY_CONFLICT",
    });
    assert.equal(await linkCount(legacyDining), 0);
    assert.deepEqual(await counts(legacyDining), { orders: 1, counters: 1, audits: 1, events: 1 });
    assert.equal(
      (
        await client.query(
          "UPDATE rms_ordering.order_capacity_link SET created_at=created_at WHERE brand_id=$1",
          [capacityLost.scope.brandReference],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await client.query("DELETE FROM rms_ordering.order_capacity_link WHERE brand_id=$1", [
          capacityLost.scope.brandReference,
        ])
      ).rowCount,
      0,
    );
    const capacityRole = "wp2402_link_" + context.runId;
    assert.match(capacityRole, /^wp2402_link_[a-f0-9]+$/u);
    await client.query("CREATE ROLE " + capacityRole + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
    const scopedClient = new Client(context.clientConfig);
    await scopedClient.connect();
    try {
      await client.query("GRANT USAGE ON SCHEMA rms_ordering,platform_helpers TO " + capacityRole);
      await client.query("GRANT SELECT ON rms_ordering.order_capacity_link TO " + capacityRole);
      await client.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          capacityRole,
      );
      await scopedClient.query("BEGIN");
      await scopedClient.query("SET LOCAL ROLE " + capacityRole);
      await scopedClient.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [capacityLost.scope.brandReference, capacityLost.scope.storeReference],
      );
      assert.equal(
        (await scopedClient.query("SELECT submission_id FROM rms_ordering.order_capacity_link"))
          .rows.length,
        1,
      );
      await scopedClient.query("SELECT set_config('bop.store_id',$1,true)", [id(9002)]);
      assert.equal(
        (await scopedClient.query("SELECT submission_id FROM rms_ordering.order_capacity_link"))
          .rows.length,
        0,
      );
      await scopedClient.query("ROLLBACK");
    } finally {
      await scopedClient.end();
      await client.query("DROP OWNED BY " + capacityRole);
      await client.query("DROP ROLE " + capacityRole);
    }

    // Real required-link service binds owner IDs even when the ordinary generator differs.
    const permanent = orderWriteFixture({ namespace: "018f7916", dineIn: true });
    await seedCart(permanent);
    const permanentLink = orderCapacityLinkFixture(permanent);
    const permanentPorts = application(permanent).ports;
    const ordinaryGenerate = permanentPorts.references.generate;
    permanentPorts.references.generate = (purpose) => {
      assert(!["Order", "OrderBatch"].includes(purpose), "permanent IDs must not be regenerated");
      return ordinaryGenerate(purpose);
    };
    permanentPorts.repository = createPostgresCapacityLinkedOrderCreationRepository(
      { query: writerRunner(), write: writerRunner() },
      permanent.scope,
      permanentLink,
    );
    const permanentService = createCapacityLinkedOrderCreationService(
      permanentPorts,
      permanentLink,
    );
    const permanentCommand = {
      submissionReference: permanent.request.record.submissionReference,
      cartReference: permanent.cart.cartReference,
      expectedCartVersion: permanent.cart.aggregateVersion,
      quoteReference: permanent.request.checkoutValidationEvidence.quoteReference,
      requestedAt: permanent.request.record.createdAt,
    };
    const permanentOutcomes = await Promise.all([
      permanentService.create(permanentCommand),
      permanentService.create(permanentCommand),
    ]);
    assert.deepEqual(permanentOutcomes.map((r) => r.status).sort(), ["AlreadyCreated", "Created"]);
    assert(
      permanentOutcomes.every(
        (r) => r.record.order.orderReference === permanentLink.orderReference,
      ),
    );
    assert(
      permanentOutcomes.every(
        (r) => r.record.order.batches[0].orderBatchReference === permanentLink.orderBatchReference,
      ),
    );
    assert.deepEqual(await counts(permanent), { orders: 1, counters: 1, audits: 1, events: 1 });

    const permanentLost = orderWriteFixture({ namespace: "018f7917", dineIn: true });
    await seedCart(permanentLost);
    const permanentLostLink = orderCapacityLinkFixture(permanentLost);
    const permanentLostPorts = application(permanentLost).ports;
    permanentLostPorts.repository = createPostgresCapacityLinkedOrderCreationRepository(
      { query: writerRunner(), write: writerRunner({ loseAck: true }) },
      permanentLost.scope,
      permanentLostLink,
    );
    const lostService = createCapacityLinkedOrderCreationService(
      permanentLostPorts,
      permanentLostLink,
    );
    const lostCommand = {
      submissionReference: permanentLost.request.record.submissionReference,
      cartReference: permanentLost.cart.cartReference,
      expectedCartVersion: permanentLost.cart.aggregateVersion,
      quoteReference: permanentLost.request.checkoutValidationEvidence.quoteReference,
      requestedAt: permanentLost.request.record.createdAt,
    };
    await assert.rejects(lostService.create(lostCommand), {
      code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
    });
    const originalLost = await lostService.create(lostCommand);
    assert.equal(originalLost.status, "AlreadyCreated");
    assert.equal(originalLost.record.order.orderReference, permanentLostLink.orderReference);
    assert.deepEqual(await counts(permanentLost), { orders: 1, counters: 1, audits: 1, events: 1 });

    const composed = orderWriteFixture({ namespace: "018f7808" });
    await seedCart(composed);
    const commandFor = (f) => ({
      submissionReference: f.request.record.submissionReference,
      cartReference: f.cart.cartReference,
      expectedCartVersion: f.cart.aggregateVersion,
      quoteReference: f.request.checkoutValidationEvidence.quoteReference,
      requestedAt: f.request.record.createdAt,
    });
    const composedApp = application(composed);
    const created = await composedApp.service.create(commandFor(composed));
    const replayed = await composedApp.service.create(commandFor(composed));
    assert.equal(created.status, "Created");
    assert.equal(replayed.status, "AlreadyCreated");
    assert.deepEqual(replayed.record, created.record);
    assert.deepEqual(await counts(composed), { orders: 1, counters: 1, audits: 1, events: 1 });
    const racing = orderWriteFixture({ namespace: "018f7809" });
    await seedCart(racing);
    let lookups = 0,
      releaseLookups;
    const bothRead = new Promise((resolve) => {
      releaseLookups = resolve;
    });
    const appA = application(racing),
      appB = application(racing, 1);
    for (const app of [appA, appB]) {
      const resolve = app.ports.repository.resolveSubmission;
      app.ports.repository = {
        ...app.ports.repository,
        async resolveSubmission(reference) {
          const result = await resolve(reference);
          if (result === null) {
            if (++lookups === 2) releaseLookups();
            await bothRead;
          }
          return result;
        },
      };
    }
    const raced = await Promise.all([
      appA.service.create(commandFor(racing)),
      appB.service.create(commandFor(racing)),
    ]);
    assert.deepEqual(
      new Set(raced.map((value) => value.status)),
      new Set(["Created", "AlreadyCreated"]),
    );
    assert.deepEqual(raced[0].record, raced[1].record);
    assert.deepEqual(await counts(racing), { orders: 1, counters: 1, audits: 1, events: 1 });
  } finally {
    await client.end();
  }
}

it("persists one immutable, idempotent Order submission atomically", async () => {
  await withIsolatedDatabase({ caseId: "order_submission", root }, prove);
}, 180_000);
