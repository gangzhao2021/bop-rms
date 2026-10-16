import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  diningCheckoutPaymentWindowMinutes,
  listStoreDiningBatchPaymentDeadlines,
  listStoreUnpaidBatchCancellations,
} from "../../rms/ordering/src/index.ts";
import {
  listStoreOrderBatchPaymentOutcomes,
  listStoreOrderBatchesWithOnlinePayment,
  listStoreOrderOnlinePaidTotals,
} from "../../rms/payment/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "0190a7c2-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sha = (c) => "sha256:" + c.repeat(64);
const [brand, store, otherStore] = [2, 3, 4].map(id);
const minutes = (n) => n * 60_000;

/**
 * WP-2423: the public reads behind the unpaid dine-in round warning (Ordering's payment deadline
 * and unpaid cancellations, Payment's latest terminal outcome per batch) run as a restricted
 * NOBYPASSRLS role holding exactly the rendered pilot API grants and see only the selected Store.
 * Owner facts are seeded directly by the isolated database owner (test-only: triggers and foreign
 * keys are skipped for the seed; table CHECK constraints still apply).
 */
it("reads dine-in round payment deadlines, unpaid cancellations and batch payment outcomes in Store scope", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_batch_due" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_due_" + context.runId,
      worker = "wp2423_due_w_" + context.runId;
    assert.match(role, /^wp2423_due_[a-f0-9]+$/u);
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

      const link = (storeId, order, batch, n, owner, createdAt) =>
        admin.query(
          "INSERT INTO rms_ordering.order_capacity_link (brand_id,store_id,submission_id,order_id,order_batch_id,commitment_id,payment_operation_id,created_at,link_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            brand,
            storeId,
            id(n + 1),
            order,
            batch,
            id(n + 2),
            id(n + 3),
            createdAt,
            {
              commitmentReference: id(n + 2),
              ownerContextReference: id(n + 4),
              brandReference: brand,
              storeReference: storeId,
              orderReference: order,
              orderBatchReference: batch,
              submissionReference: id(n + 1),
              cartReference: id(n + 5),
              quoteReference: id(n + 6),
              guestSessionReference: id(n + 7),
              paymentOperationReference: id(n + 3),
              owner,
              commitmentVersion: 1,
              cartVersion: 1,
              ownerIntentDigest: sha("a"),
              ownerSnapshotDigest: sha("b"),
              preparedAt: time(-minutes(60)),
              validUntil: time(minutes(60)),
            },
          ],
        );
      const cancellation = (storeId, order, batch, n, cancelledAt) =>
        admin.query(
          "INSERT INTO rms_ordering.order_batch_checkout_cancellation (cancellation_id,operation_id,tenant_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_operation_id,expiry_record_id,expiry_evidence_digest,expected_order_version,cancelled_order_version,expected_source_checkpoint,workflow_version_id,transition_id,order_item_ids,cancelled_at,phase,reason_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,3,4,$12,$13,$14,$15,$16,'Cancelled','CHECKOUT_DEADLINE_REACHED')",
          [
            id(n + 10),
            id(n + 11),
            id(1),
            brand,
            storeId,
            order,
            batch,
            id(n + 1),
            id(n + 3),
            id(n + 12),
            sha("c"),
            id(n + 13),
            id(n + 14),
            id(n + 15),
            [id(n + 16)],
            cancelledAt,
          ],
        );
      const payment = (storeId, order, batch, n, status, occurredAt, active = true) =>
        admin
          .query(
            "INSERT INTO rms_payment.payment_intent (payment_intent_id,brand_id,store_id,payment_operation_id,order_id,order_batch_id,submission_id,guest_session_id,source_cart_id,source_cart_version,quote_id,preparation_id,capacity_allocation_id,intent_digest,preparation_source_digest,order_allocation_minor,tip_minor,total_minor,currency_code,payment_method,capture_mode,aggregate_version,creation_status,prepared_at,capacity_expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,$13,1130,0,1130,'CAD','OnlineCard','Automatic',1,'ProviderCreatePending',$14,$15,$14)",
            [
              id(n + 20),
              brand,
              storeId,
              id(n + 21),
              order,
              batch,
              id(n + 22),
              id(n + 23),
              id(n + 24),
              id(n + 25),
              id(n + 26),
              id(n + 27),
              sha("d"),
              time(-minutes(40)),
              time(-minutes(10)),
            ],
          )
          .then(() =>
            admin.query(
              "INSERT INTO rms_payment.payment_status_projection (projection_generation_id,brand_id,store_id,payment_intent_id,payment_transaction_id,payment_attempt_id,order_id,terminal_status,amount_minor,currency_code,failure_reason,retry_disposition,terminal_occurred_at,source_event_id,source_aggregate_version,projection_name,projection_version,projected_at,last_rebuilt_at,freshness_status,is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,2,'payment_status_v1',1,$13,NULL,'Fresh',$15)",
              [
                id(n + 28),
                brand,
                storeId,
                id(n + 20),
                id(n + 29),
                id(n + 30),
                order,
                status,
                status === "Succeeded" ? 1130 : null,
                status === "Succeeded" ? "CAD" : null,
                status === "Succeeded" ? null : "Declined",
                status === "Succeeded" ? null : "NewOperation",
                occurredAt,
                id(n + 31),
                active,
              ],
            ),
          );

      // Dine-in Order A: round 1 paid, round 2 failed then cancelled, round 3 failed and later
      // paid, round 4 still open. Pickup Order C has a Fulfillment-owned link. Order B is another
      // Store's dine-in Order with the same facts.
      const [orderA, orderB, orderC] = [id(100), id(200), id(300)];
      const [a1, a2, a3, a4, b1, c1] = [101, 102, 103, 104, 201, 301].map(id);
      const linkedAt = time(-minutes(35));
      await admin.query("SET session_replication_role = replica");
      try {
        await link(store, orderA, a1, 1000, "Dining", linkedAt);
        await link(store, orderA, a2, 2000, "Dining", linkedAt);
        await link(store, orderA, a3, 3000, "Dining", linkedAt);
        await link(store, orderA, a4, 4000, "Dining", time(-minutes(5)));
        await link(otherStore, orderB, b1, 5000, "Dining", linkedAt);
        await link(store, orderC, c1, 6000, "Fulfillment", linkedAt);
        await payment(store, orderA, a1, 1000, "Succeeded", time(-minutes(34)));
        await payment(store, orderA, a2, 2000, "Failed", time(-minutes(34)));
        await payment(store, orderA, a3, 3000, "Failed", time(-minutes(33)));
        await payment(store, orderA, a3, 3100, "Succeeded", time(-minutes(32)));
        // An inactive projection generation is never a current outcome.
        await payment(store, orderA, a4, 4000, "Failed", time(-minutes(3)), false);
        await payment(otherStore, orderB, b1, 5000, "Failed", time(-minutes(34)));
        await cancellation(store, orderA, a2, 2000, time(-minutes(4)));
        await cancellation(otherStore, orderB, b1, 5000, time(-minutes(4)));
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      const scoped = async (work) => {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
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
      const scope = { brandReference: brand, storeReference: store };
      const orders = [orderA, orderB, orderC];

      const deadlines = await scoped((tx) =>
        listStoreDiningBatchPaymentDeadlines(tx, scope, orders),
      );
      const due = new Date(Date.parse(linkedAt) + minutes(diningCheckoutPaymentWindowMinutes));
      assert.deepEqual(deadlines, [
        { orderReference: orderA, orderBatchReference: a1, paymentDeadline: due.toISOString() },
        { orderReference: orderA, orderBatchReference: a2, paymentDeadline: due.toISOString() },
        { orderReference: orderA, orderBatchReference: a3, paymentDeadline: due.toISOString() },
        {
          orderReference: orderA,
          orderBatchReference: a4,
          paymentDeadline: time(-minutes(5) + minutes(30)),
        },
      ]);

      const cancelled = await scoped((tx) => listStoreUnpaidBatchCancellations(tx, scope, orders));
      assert.deepEqual(cancelled, [
        {
          orderReference: orderA,
          orderBatchReference: a2,
          cancelledAt: time(-minutes(4)),
          // WP-2423 abandoned payment: why, so staff see a manager's cancellation differently.
          reasonCode: "CHECKOUT_DEADLINE_REACHED",
        },
      ]);

      const outcomes = await scoped((tx) => listStoreOrderBatchPaymentOutcomes(tx, scope, orders));
      assert.deepEqual(outcomes, [
        { orderReference: orderA, orderBatchReference: a1, status: "Succeeded" },
        { orderReference: orderA, orderBatchReference: a2, status: "Failed" },
        { orderReference: orderA, orderBatchReference: a3, status: "Succeeded" },
      ]);

      // WP-2423: what staff see as "Paid online" on the Orders page — the succeeded rounds only
      // (a1 and the retried a3), never the failed or inactive outcomes or another Store's Order.
      assert.deepEqual(await scoped((tx) => listStoreOrderOnlinePaidTotals(tx, scope, orders)), [
        { orderReference: orderA, amountMinor: "2260", currencyCode: "CAD" },
      ]);

      // WP-2423 item 5: rounds for which an online payment was ever started (whatever its outcome
      // or projection state) are never cancelled as "no payment started"; the others may be.
      assert.deepEqual(
        [
          ...(await scoped((tx) => listStoreOrderBatchesWithOnlinePayment(tx, scope, orders))),
        ].sort(),
        [a1, a2, a3, a4],
      );

      // The other Store sees only its own Order.
      const other = { brandReference: brand, storeReference: otherStore };
      assert.deepEqual(
        (await scoped((tx) => listStoreUnpaidBatchCancellations(tx, other, orders))).map(
          (entry) => entry.orderBatchReference,
        ),
        [b1],
      );
      assert.deepEqual(
        (await scoped((tx) => listStoreOrderBatchPaymentOutcomes(tx, other, orders))).map(
          (entry) => [entry.orderBatchReference, entry.status],
        ),
        [[b1, "Failed"]],
      );
      assert.deepEqual(
        [...(await scoped((tx) => listStoreOrderBatchesWithOnlinePayment(tx, other, orders)))],
        [b1],
      );
    } finally {
      await admin.end();
    }
  });
});
