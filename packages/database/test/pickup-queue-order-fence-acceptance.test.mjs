import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import {
  createFulfillmentReadinessService,
  createPickupFulfillmentService,
  createPostgresFulfillmentReadinessStore,
  createPostgresPickupFulfillmentStore,
} from "../../rms/fulfillment/src/index.ts";
import { parseKitchenItemReadyEnvelope } from "../../rms/kitchen/src/index.ts";
import {
  acquireOrderDispositionFence,
  createOrderFulfillmentSourceEvidenceBinding,
  createOrderFulfillmentSourceLineBinding,
  parseConfirmedOrderFulfillmentSourceEvidence,
  parseOrderConfirmedEnvelope,
} from "../../rms/ordering/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "01a0f060-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sha = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const derive = (prefix) => (purpose, identity) => {
  const digest = createHash("sha256")
    .update(purpose + identity)
    .digest("hex");
  return (
    prefix +
    "-" +
    digest.slice(0, 4) +
    "-7" +
    digest.slice(4, 7) +
    "-8" +
    digest.slice(7, 10) +
    "-" +
    digest.slice(10, 22)
  );
};
const minutes = (base, n) => new Date(Date.parse(base) + n * 60_000).toISOString();

/**
 * WP-2423 (v15 2026-10-18, 40P01): the pickup queue and the Orders list each fence several Orders
 * (Ordering's disposition fence, taken by the pickup's current-source check as in the pilot). The
 * queue fenced its pickups in pickup-reference order, the Orders list newest first, so two Orders
 * whose pickup references sort the other way round deadlocked them. Every multi-Order read now
 * fences in ascending Order reference. Two connections, interleaved deterministically: the
 * Orders-list side holds the lower Order's fence, the queue starts and waits for it, then the
 * Orders-list side takes the higher Order's fence. Before the fix the queue already held that one
 * (40P01); now it never takes it out of order and both reads finish. Code runs as a restricted
 * NOBYPASSRLS role with the rendered pilot API grants. Test-only stand-ins: Ordering confirmation
 * evidence and Kitchen ready events are synthetic and applied by the owner client.
 */
it("fences the pickup queue's Orders in ascending Order reference, so it never deadlocks with an Orders list fencing the same Orders", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_pqfence" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_pq_" + context.runId,
      worker = "wp2423_pq_w_" + context.runId;
    try {
      for (const name of [api, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api, worker }));

      const brand = id(1),
        store = id(2),
        scope = { brandReference: brand, storeReference: store };
      const t0 = new Date(Math.floor((Date.now() - 4 * 3_600_000) / 1000) * 1000).toISOString();
      const now = () => minutes(t0, 60);

      /** One connection and transaction; `role` null is the owner client. */
      const open = async (role) => {
        const client = new Client(context.clientConfig);
        await client.connect();
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = '20s'");
        if (role) await client.query("SET LOCAL ROLE " + role);
        await client.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, store],
        );
        const tx = {
          query: (sql, values) => client.query(sql, values === undefined ? [] : [...values]),
        };
        const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        return {
          tx,
          pid,
          commit: async () => {
            try {
              await client.query("COMMIT");
            } finally {
              await client.end();
            }
          },
          rollback: async () => {
            await client.query("ROLLBACK").catch(() => undefined);
            await client.end().catch(() => undefined);
          },
        };
      };
      const asOwner = async (work) => {
        const run = await open(null);
        try {
          const result = await work(run.tx);
          await run.commit();
          return result;
        } catch (error) {
          await run.rollback();
          throw error;
        }
      };

      /** Synthetic confirmed pickup Order made Ready by the owner services. */
      async function readyPickup(n) {
        const order = id(0x1000 * n + 1),
          batch = id(0x1000 * n + 2),
          confirmation = id(0x1000 * n + 3),
          eventId = id(0x1000 * n + 4),
          item = id(0x1000 * n + 5);
        const readyAt = minutes(t0, n),
          confirmedAt = minutes(readyAt, -10);
        const event = parseOrderConfirmedEnvelope({
          eventId,
          eventType: "OrderConfirmed",
          schemaVersion: 1,
          occurredAt: confirmedAt,
          producerModule: "@rms/ordering",
          tenantId: brand,
          storeId: store,
          aggregateType: "Order",
          aggregateId: order,
          aggregateVersion: 2n,
          correlationId: id(0x1000 * n + 6),
          causationId: id(0x1000 * n + 7),
          actor: { type: "System" },
          payload: {
            confirmationReference: confirmation,
            orderReference: order,
            orderBatchReference: batch,
            sourceSnapshotDigest: sha("order" + n),
            confirmedAt,
          },
          redactionClassification: "indirect_identifier",
          replayMetadata: { replaySafe: true },
        });
        const line = { orderItemReference: item, ordinal: 1, quantity: 1, lineDigest: sha("x") };
        line.lineDigest = sha(createOrderFulfillmentSourceLineBinding(line));
        const raw = {
          evidenceReference: id(0x1000 * n + 8),
          ...scope,
          orderReference: order,
          orderBatchReference: batch,
          confirmationReference: confirmation,
          sourceEventReference: eventId,
          sourceAggregateVersion: 2n,
          sourceSnapshotDigest: sha("order" + n),
          orderType: "Pickup",
          capturedAt: confirmedAt,
          evidenceVersion: 1,
          items: [line],
          evidenceDigest: sha("x"),
        };
        raw.evidenceDigest = sha(createOrderFulfillmentSourceEvidenceBinding(raw));
        const source = parseConfirmedOrderFulfillmentSourceEvidence(raw);
        const audit = {
          append: ({ record, transaction: tx }) => appendAuditRecordInTransaction(tx, record),
        };
        const created = await asOwner((tx) =>
          createPickupFulfillmentService({
            authorization: { authorize: async () => true },
            orderingSource: { resolve: async () => source },
            references: { derive: derive("01a0f061") },
            digests: { sha256: sha },
            repository: createPostgresPickupFulfillmentStore({
              ...scope,
              sha256: sha,
              authorize: async () => true,
              validateCurrentSource: async () => true,
            }),
            audit,
          }).consume(tx, event),
        );
        assert.equal(created.status, "Created");
        const aggregate = created.effect.aggregate;
        const applied = await asOwner((tx) =>
          createFulfillmentReadinessService({
            authorization: { authorize: async () => true },
            repository: createPostgresFulfillmentReadinessStore({
              ...scope,
              sha256: sha,
              now,
              authorize: async () => true,
              validateCurrentSource: async () => true,
            }),
            digests: { sha256: sha },
            references: { derive: derive("01a0f062") },
            audit,
          }).consume(
            tx,
            parseKitchenItemReadyEnvelope({
              eventId: id(0x1000 * n + 9),
              eventType: "KitchenItemReady",
              schemaVersion: 1,
              occurredAt: readyAt,
              producerModule: "@rms/kitchen",
              tenantId: brand,
              storeId: store,
              aggregateType: "KitchenOrderItemReadyResult",
              aggregateId: id(0x1000 * n + 10),
              aggregateVersion: 1n,
              correlationId: id(0x1000 * n + 11),
              causationId: id(0x1000 * n + 12),
              actor: { type: "System" },
              payload: {
                kitchenTicketReference: id(0x1000 * n + 13),
                orderReference: order,
                orderBatchReference: batch,
                orderItemReference: aggregate.items[0].orderItemReference,
                readyResultReference: id(0x1000 * n + 10),
                readyQuantity: 1,
                requiredQuantity: 1,
                readyAt,
              },
              redactionClassification: "indirect_identifier",
              replayMetadata: { replaySafe: true },
            }),
          ),
        );
        assert.equal(applied.status, "Applied");
        return { order, fulfillment: aggregate.fulfillmentReference };
      }

      const pickups = [];
      for (let n = 1; n <= 4; n++) pickups.push(await readyPickup(n));
      // The v15 shape: a lower Order whose pickup sorts after a higher Order's pickup (pickup
      // references are derived, so their order is unrelated to the Orders').
      const byOrder = [...pickups].sort((a, b) => (a.order < b.order ? -1 : 1));
      let pair = null;
      for (const low of byOrder)
        for (const high of byOrder)
          if (pair === null && low.order < high.order && low.fulfillment > high.fulfillment)
            pair = { low, high };
      assert.ok(pair, "the fixture holds two Orders whose pickups sort the other way round");
      const lowest = byOrder[0];

      // The pickup queue as the merchant API runs it: the current-source check takes Ordering's
      // disposition fence of each Order before the pickup is read (pilot composition).
      const queueStore = createPostgresFulfillmentReadinessStore({
        ...scope,
        sha256: sha,
        now,
        authorizeQueue: async () => true,
        authorize: async () => true,
        validateCurrentSource: async (tx, orderReference) => {
          await acquireOrderDispositionFence(tx, { ...scope, orderReference });
          return true;
        },
      });

      // 1. The Orders-list side (canonical order) holds the lower Order's fence.
      const orders = await open(api);
      await acquireOrderDispositionFence(orders.tx, {
        ...scope,
        orderReference: pair.low.order,
      });
      // 2. The pickup queue starts and waits for that fence.
      const queue = await open(api);
      const queueRun = queueStore
        .listPickupQueue({
          transaction: queue.tx,
          afterFulfillmentReference: null,
          limit: 10,
          includeCompleted: false,
        })
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      const waiting = async (pid) =>
        (
          await admin.query(
            "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",
            [pid],
          )
        ).rows.length === 1;
      for (let i = 0; i < 200 && !(await waiting(queue.pid)); i++) await delay(25);
      assert.equal(await waiting(queue.pid), true, "the pickup queue waits for the held fence");
      const queueHeld = async (order) =>
        (
          await admin.query(
            "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted AND " +
              "((classid::bigint<<32)|objid::bigint)=hashtextextended($2,0)",
            [queue.pid, "OrderingOrderDisposition:" + brand + ":" + store + ":" + order],
          )
        ).rows.length === 1;
      // Recorded now, asserted after both reads ended (so a failure never leaves them running).
      const heldHigher = await queueHeld(pair.high.order),
        heldLowest = pair.low === lowest || (await queueHeld(lowest.order));

      // 3. The Orders-list side takes the higher Order's fence and finishes; then the queue does.
      let ordersError = null;
      try {
        await acquireOrderDispositionFence(orders.tx, {
          ...scope,
          orderReference: pair.high.order,
        });
        await orders.commit();
      } catch (error) {
        ordersError = error;
        await orders.rollback();
      }
      const queued = await queueRun;
      if (queued.error) await queue.rollback();
      else await queue.commit();
      assert.equal(
        ordersError?.code ?? null,
        null,
        "the Orders-list side is never a deadlock victim",
      );
      assert.equal(queued.error?.code ?? null, null, "the pickup queue is never a deadlock victim");
      assert.equal(queued.error, undefined);
      // While it waited for the lower Order, the queue held the Orders below it and none above.
      assert.equal(heldHigher, false);
      assert.equal(heldLowest, true);
      // The page keeps pickup-reference order and lists every Ready pickup.
      assert.deepEqual(
        queued.value.items.map((item) => String(item.fulfillmentReference)),
        pickups.map((pickup) => pickup.fulfillment).sort(),
      );
      assert.deepEqual(
        queued.value.items.map((item) => String(item.orderReference)).sort(),
        byOrder.map((pickup) => pickup.order),
      );
      const deadlocks = (
        await admin.query(
          "SELECT deadlocks::int AS count FROM pg_stat_database WHERE datname=current_database()",
        )
      ).rows[0].count;
      assert.equal(deadlocks, 0);
    } finally {
      await admin.end();
    }
  });
});
