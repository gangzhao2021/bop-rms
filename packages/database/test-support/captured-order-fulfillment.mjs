import { exerciseOrderFulfillmentCompletion } from "./order-fulfillment-completion.mjs";
import { exercisePickupProofStore } from "./pickup-proof-store.mjs";
import assert from "node:assert/strict";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import { createPostgresOrderFulfillmentSourceStore } from "../../rms/ordering/src/index.ts";
import {
  createPickupFulfillmentService,
  createFulfillmentReadinessService,
  createPostgresFulfillmentReadinessStore,
  createPostgresPickupFulfillmentStore,
} from "../../rms/fulfillment/src/index.ts";

/** Actual persisted Ordering confirmation and Fulfillment writes; System capabilities are synthetic. */
export async function exerciseCapturedOrderFulfillment({
  additionalServices = [],
  onPickupReady,
  paymentWorkflow,
  admin,
  runner,
  role,
  scope: ownerScope,
  quoteVersion,
  event,
  order,
  hash,
}) {
  const scope = {
    brandReference: ownerScope.brandReference,
    storeReference: ownerScope.storeReference,
  };
  let allowed = true;
  await admin.query("GRANT USAGE ON SCHEMA rms_fulfillment TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT ON rms_fulfillment.fulfillment,rms_fulfillment.fulfillment_item," +
      "rms_fulfillment.fulfillment_creation_operation TO " +
      role,
  );
  const references = {
    derive: (purpose, identity) => {
      const digest = hash(purpose + ":" + identity).slice(7);
      return (
        "0190f1af-" +
        digest.slice(0, 4) +
        "-7" +
        digest.slice(4, 7) +
        "-8" +
        digest.slice(7, 10) +
        "-" +
        digest.slice(10, 22)
      );
    },
  };
  const source = createPostgresOrderFulfillmentSourceStore({
    ...scope,
    quoteVersion,
    sha256: hash,
    authorize: async (_tx, request) =>
      allowed &&
      request.action === "ResolveConfirmedOrderFulfillmentSource" &&
      request.purpose === "CreatePickupFulfillment",
  });
  const query = {
    ...scope,
    orderReference: event.payload.orderReference,
    orderBatchReference: event.payload.orderBatchReference,
    confirmationReference: event.payload.confirmationReference,
    sourceEventReference: event.eventId,
    sourceAggregateVersion: event.aggregateVersion,
    sourceSnapshotDigest: event.payload.sourceSnapshotDigest,
    observedAt: event.occurredAt,
  };
  const repository = createPostgresPickupFulfillmentStore({
    ...scope,
    sha256: hash,
    authorize: async () => allowed,
    validateCurrentSource: async (transaction, effect) => {
      const current = await source.resolve({
        transaction,
        query: {
          ...query,
          orderReference: effect.aggregate.orderReference,
          orderBatchReference: effect.aggregate.orderBatchReference,
          confirmationReference: effect.aggregate.confirmationReference,
          sourceEventReference: effect.aggregate.sourceEventReference,
          sourceAggregateVersion: effect.aggregate.sourceAggregateVersion,
          sourceSnapshotDigest: effect.aggregate.sourceSnapshotDigest,
        },
      });
      return (
        current.orderType === "Pickup" &&
        current.evidenceDigest === effect.aggregate.sourceEvidenceDigest
      );
    },
  });
  const consumer = (transaction) =>
    createPickupFulfillmentService({
      authorization: { authorize: async () => allowed },
      orderingSource: { resolve: (input) => source.resolve({ transaction, query: input }) },
      references,
      digests: { sha256: hash },
      repository,
      audit: {
        append: ({ transaction: tx, record }) => appendAuditRecordInTransaction(tx, record),
      },
    });
  allowed = false;
  await assert.rejects(runner.run((tx) => consumer(tx).consume(tx, event)));
  allowed = true;
  const actual = await runner.run((transaction) => source.resolve({ transaction, query }));
  assert.equal(actual.orderType, order.order.orderType);
  assert.deepEqual(
    actual.items.map((item) => ({ reference: item.orderItemReference, quantity: item.quantity })),
    order.items.map((item) => ({ reference: item.orderItemReference, quantity: item.quantity })),
  );
  const first = await runner.run((tx) => consumer(tx).consume(tx, event));
  const repeat = await runner.run((tx) => consumer(tx).consume(tx, event));
  if (order.order.orderType === "DineIn") {
    assert.equal(first.status, "NotApplicable");
    assert.equal(repeat.status, "NotApplicable");
    const absent = await admin.query(
      "SELECT count(*)::int AS count FROM rms_fulfillment.fulfillment WHERE brand_id=$1 AND store_id=$2 AND order_id=$3",
      [scope.brandReference, scope.storeReference, order.order.orderReference],
    );
    assert.equal(absent.rows[0].count, 0);
    return null;
  }
  assert.equal(first.status, "Created");
  assert.equal(repeat.status, "AlreadyCreated");
  assert.deepEqual(repeat.effect, first.effect);
  const items = await admin.query(
    "SELECT order_item_id,ordered_quantity,item_state FROM rms_fulfillment.fulfillment_item " +
      "WHERE brand_id=$1 AND store_id=$2 AND fulfillment_id=$3 ORDER BY ordinal",
    [scope.brandReference, scope.storeReference, first.effect.aggregate.fulfillmentReference],
  );
  assert.deepEqual(
    items.rows,
    order.items.map((item) => ({
      order_item_id: item.orderItemReference,
      ordered_quantity: item.quantity,
      item_state: "Pending",
    })),
  );
  await admin.query(
    "GRANT SELECT,INSERT ON rms_fulfillment.fulfillment_item_ready_result,rms_fulfillment.fulfillment_ready_operation TO " +
      role,
  );
  await admin.query("GRANT UPDATE ON rms_fulfillment.fulfillment TO " + role);
  await admin.query(
    "GRANT SELECT ON rms_fulfillment.pickup_handoff_record,rms_fulfillment.pickup_proof_generation,rms_fulfillment.pickup_proof_invalidation,rms_fulfillment.pickup_proof_operation,rms_fulfillment.pickup_proof_verification TO " +
      role,
  );
  await admin.query(
    "GRANT INSERT ON rms_fulfillment.pickup_proof_generation,rms_fulfillment.pickup_proof_invalidation,rms_fulfillment.pickup_proof_operation,rms_fulfillment.pickup_proof_verification TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,INSERT ON rms_fulfillment.pickup_handoff_record,rms_fulfillment.pickup_handoff_item,rms_fulfillment.pickup_handoff_operation TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,INSERT ON rms_fulfillment.fulfillment_completion_publication TO " + role,
  );
  // WP-2423: in-person check and not-collected closure facts the handoff reads (pilot api grants).
  await admin.query(
    "GRANT SELECT,INSERT ON rms_fulfillment.pickup_in_person_verification,rms_fulfillment.pickup_not_collected_record TO " +
      role,
  );
  return {
    creationEffect: first.effect,
    async consumeReady(readyEvent) {
      const readyStore = createPostgresFulfillmentReadinessStore({
        ...scope,
        sha256: hash,
        now: () => new Date(Date.parse(readyEvent.occurredAt) + 1000).toISOString(),
        authorize: async () => allowed,
        validateCurrentSource: async (transaction, orderReference) => {
          const current = await source.resolve({
            transaction,
            query: { ...query, orderReference },
          });
          return current.orderType === "Pickup";
        },
      });
      const readyConsumer = createFulfillmentReadinessService({
        authorization: { authorize: async () => allowed },
        references,
        digests: { sha256: hash },
        repository: readyStore,
        audit: {
          append: ({ transaction, record }) => appendAuditRecordInTransaction(transaction, record),
        },
      });
      const run = (work) =>
        runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          return work(tx);
        });
      const counts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_fulfillment.fulfillment_item_ready_result WHERE brand_id=$1 AND store_id=$2) AS results," +
              "(SELECT count(*)::int FROM rms_fulfillment.fulfillment_ready_operation WHERE brand_id=$1 AND store_id=$2) AS operations," +
              "(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1 AND store_id=$2 AND action_code='FULFILLMENT_ITEM_READY_RECORDED') AS audits," +
              "(SELECT count(*)::int FROM platform_eventing.consumer_inbox WHERE brand_id=$1 AND store_id=$2 AND consumer_name='fulfillment.kitchen-item-ready:v1') AS inbox",
            [scope.brandReference, scope.storeReference],
          )
        ).rows[0];
      const initial = await counts();
      for (const point of [
        "INSERT INTO rms_fulfillment.fulfillment_item_ready_result",
        "INSERT INTO rms_fulfillment.fulfillment_ready_operation",
        "INSERT INTO platform_audit.audit_record",
        "UPDATE platform_eventing.consumer_inbox",
      ]) {
        let reached = false;
        await assert.rejects(
          run((tx) =>
            readyConsumer.consume(
              {
                query: async (sql, values) => {
                  if (sql.startsWith(point)) {
                    reached = true;
                    throw new Error("synthetic Ready failure");
                  }
                  return tx.query(sql, values);
                },
              },
              readyEvent,
            ),
          ),
        );
        assert.equal(reached, true);
        assert.deepEqual(await counts(), initial);
      }
      const applied = await run((tx) => readyConsumer.consume(tx, readyEvent));
      const repeated = await run((tx) => readyConsumer.consume(tx, readyEvent));
      assert.equal(applied.status, "Applied");
      assert.equal(repeated.status, "AlreadyApplied");
      assert.deepEqual(applied.effect, repeated.effect);
      const current = await run((transaction) =>
        readyStore.lockByOrder({
          ...scope,
          orderReference: order.order.orderReference,
          transaction,
        }),
      );
      assert.equal(
        current.items.find(
          (item) => item.orderItemReference === readyEvent.payload.orderItemReference,
        ).state,
        "Ready",
      );
      if (current.items.every((item) => item.state === "Ready")) {
        assert.equal(current.canonicalPhase, "Ready");
        if (onPickupReady) {
          await onPickupReady({
            state: current,
            creation: first.effect,
            readyEvent,
            source,
            query,
            references,
          });
          return applied;
        }
        const completed = await exercisePickupProofStore({
          client: admin,
          run,
          scope,
          creation: first.effect,
          sha: hash,
          id: (n) => references.derive("PaidPickupProof", String(n)),
          expectedReadyAt: readyEvent.occurredAt,
          parallelTransactions: true,
          validateCurrentSource: async (transaction, orderReference) => {
            const currentOrder = await source.resolve({
              transaction,
              query: { ...query, orderReference },
            });
            return currentOrder.orderType === "Pickup";
          },
        });
        await exerciseOrderFulfillmentCompletion({
          additionalServices,
          acquire: runner.acquire,
          quoteVersion,
          admin,
          run,
          role,
          scope: ownerScope,
          order,
          event: completed,
          hash,
          paymentWorkflow,
          id: (n) => references.derive("OrderCompletion", String(n)),
        });
      }
      return applied;
    },
  };
}
