import assert from "node:assert/strict";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import { parseKitchenItemReadyEnvelope } from "../../rms/kitchen/src/index.ts";
import {
  createFulfillmentReadinessService,
  createPickupFulfillmentService,
  createPostgresFulfillmentItemCancellation,
  createPostgresFulfillmentReadinessStore,
  createPostgresPickupFulfillmentStore,
} from "../../rms/fulfillment/src/index.ts";
import {
  createOrderFulfillmentSourceEvidenceBinding,
  createOrderFulfillmentSourceLineBinding,
  parseConfirmedOrderFulfillmentSourceEvidence,
  parseOrderConfirmedEnvelope,
} from "../../rms/ordering/src/index.ts";

/**
 * WP-2423 Q6 step 2 on real Fulfillment owner persistence: staff cancel pickup lines before the
 * kitchen starts them. Owner creation, readiness, cancellation and the pickup queue are real;
 * Ordering source and Kitchen ready events are synthetic.
 */
export async function exerciseFulfillmentItemCancellation({ client, run, scope, id, sha }) {
  const at = "2026-08-11T18:00:00.000Z";
  const derive = (purpose, identity) => {
    const digest = sha(purpose + identity).slice(7);
    return (
      "0198b0fe-" +
      digest.slice(0, 4) +
      "-7" +
      digest.slice(4, 7) +
      "-8" +
      digest.slice(7, 10) +
      "-" +
      digest.slice(10, 22)
    );
  };
  let sequence = 0x5000;
  const next = () => id(sequence++);
  const audit = {
    append: ({ record, transaction }) => appendAuditRecordInTransaction(transaction, record),
  };
  // A two-line confirmed pickup order: base+0 order, base+1 batch, lines base+10.. .
  async function createPickup(base, lineCount) {
    const order = id(base),
      batch = id(base + 1);
    const event = parseOrderConfirmedEnvelope({
      eventId: id(base + 2),
      eventType: "OrderConfirmed",
      schemaVersion: 1,
      occurredAt: at,
      producerModule: "@rms/ordering",
      tenantId: scope.brandReference,
      storeId: scope.storeReference,
      aggregateType: "Order",
      aggregateId: order,
      aggregateVersion: 2n,
      correlationId: id(base + 3),
      causationId: id(base + 4),
      actor: { type: "System" },
      payload: {
        confirmationReference: id(base + 5),
        orderReference: order,
        orderBatchReference: batch,
        sourceSnapshotDigest: sha("order" + base),
        confirmedAt: at,
      },
      redactionClassification: "indirect_identifier",
      replayMetadata: { replaySafe: true },
    });
    const lines = Array.from({ length: lineCount }, (_, index) => {
      const line = {
        orderItemReference: id(base + 10 + index),
        ordinal: index + 1,
        quantity: index + 1,
        lineDigest: sha("placeholder"),
      };
      line.lineDigest = sha(createOrderFulfillmentSourceLineBinding(line));
      return line;
    });
    const raw = {
      evidenceReference: id(base + 6),
      ...scope,
      orderReference: order,
      orderBatchReference: batch,
      confirmationReference: id(base + 5),
      sourceEventReference: id(base + 2),
      sourceAggregateVersion: 2n,
      sourceSnapshotDigest: sha("order" + base),
      orderType: "Pickup",
      capturedAt: at,
      evidenceVersion: 1,
      items: lines,
      evidenceDigest: sha("placeholder"),
    };
    raw.evidenceDigest = sha(createOrderFulfillmentSourceEvidenceBinding(raw));
    const source = parseConfirmedOrderFulfillmentSourceEvidence(raw);
    const service = createPickupFulfillmentService({
      authorization: { authorize: async () => true },
      orderingSource: { resolve: async () => source },
      references: { derive },
      digests: { sha256: sha },
      repository: createPostgresPickupFulfillmentStore({
        ...scope,
        sha256: sha,
        authorize: async () => true,
        validateCurrentSource: async () => true,
      }),
      audit,
    });
    const created = await run((tx) => service.consume(tx, event));
    assert.equal(created.status, "Created");
    return created.effect.aggregate;
  }
  const now = "2026-08-11T18:10:00.000Z";
  const store = createPostgresFulfillmentReadinessStore({
    ...scope,
    sha256: sha,
    now: () => now,
    authorizeQueue: async () => true,
    authorize: async () => true,
    validateCurrentSource: async () => true,
  });
  const readiness = createFulfillmentReadinessService({
    authorization: { authorize: async () => true },
    repository: store,
    digests: { sha256: sha },
    references: { derive },
    audit,
  });
  const ready = (aggregate, index, readyAt) => {
    const item = aggregate.items[index];
    const result = next();
    return run((tx) =>
      readiness.consume(
        tx,
        parseKitchenItemReadyEnvelope({
          eventId: next(),
          eventType: "KitchenItemReady",
          schemaVersion: 1,
          occurredAt: readyAt,
          producerModule: "@rms/kitchen",
          tenantId: scope.brandReference,
          storeId: scope.storeReference,
          aggregateType: "KitchenOrderItemReadyResult",
          aggregateId: result,
          aggregateVersion: 1n,
          correlationId: next(),
          causationId: next(),
          actor: { type: "System" },
          payload: {
            kitchenTicketReference: id(0x4fff),
            orderReference: aggregate.orderReference,
            orderBatchReference: aggregate.orderBatchReference,
            orderItemReference: item.orderItemReference,
            readyResultReference: result,
            readyQuantity: item.orderedQuantity,
            requiredQuantity: item.orderedQuantity,
            readyAt,
          },
          redactionClassification: "indirect_identifier",
          replayMetadata: { replaySafe: true },
        }),
      ),
    );
  };
  const manager = id(0x4ffe);
  const cancellation = createPostgresFulfillmentItemCancellation({
    ...scope,
    authorize: async (_tx, input) => input.actorReference === manager,
  });
  const command = (aggregate, lines, cancelledAt) => ({
    orderReference: aggregate.orderReference,
    orderBatchReference: aggregate.orderBatchReference,
    orderItemReferences: lines.map((index) => aggregate.items[index].orderItemReference),
    orderCancellationReference: next(),
    operationReference: next(),
    auditReference: next(),
    actorReference: manager,
    cancelledAt,
    nextReference: next,
  });
  const lock = (aggregate) =>
    run((transaction) =>
      store.lockByOrder({ ...scope, orderReference: aggregate.orderReference, transaction }),
    );

  // 1. Line 1 ready, then staff cancel line 2: the cancellation moves the pickup to Ready, the
  // pickup lists only line 1, and the order is ready from the cancellation instant.
  const first = await createPickup(0x6000, 2);
  assert.equal((await ready(first, 0, "2026-08-11T18:01:00.000Z")).status, "Applied");
  const firstCommand = command(first, [1], "2026-08-11T18:05:00.000Z");
  const recorded = await run((tx) => cancellation.cancelItems(tx, firstCommand));
  assert.equal(recorded.status, "Recorded");
  assert.equal(recorded.itemCount, 1);
  assert.equal(recorded.canonicalPhase, "Ready");
  assert.deepEqual(await run((tx) => cancellation.cancelItems(tx, firstCommand)), {
    ...recorded,
    status: "AlreadyRecorded",
  });
  const firstState = await lock(first);
  assert.equal(firstState.canonicalPhase, "Ready");
  assert.equal(firstState.aggregateVersion, 3n);
  assert.deepEqual(
    firstState.items.map((item) => item.orderItemReference),
    [first.items[0].orderItemReference],
  );
  const proof = await run((transaction) =>
    store.lockPickupProofByOrder({ ...scope, orderReference: first.orderReference, transaction }),
  );
  assert.equal(proof.source.readyAt, firstCommand.cancelledAt);
  assert.equal(proof.source.items.length, 1);
  const queue = await run((transaction) =>
    store.listPickupQueue({
      transaction,
      afterFulfillmentReference: null,
      limit: 50,
      includeCompleted: false,
    }),
  );
  const listed = queue.items.find((item) => item.orderReference === first.orderReference);
  assert.ok(listed);
  assert.equal(listed.items.length, 1);
  const auditRow = await client.query(
    "SELECT action_code,actor_type,actor_reference,reason_code,target_id FROM platform_audit.audit_record WHERE audit_id=$1",
    [firstCommand.auditReference],
  );
  assert.deepEqual(auditRow.rows[0], {
    action_code: "FULFILLMENT_ITEM_CANCELLED",
    actor_type: "User",
    actor_reference: manager,
    reason_code: "ORDER_CANCELLED_BEFORE_PREPARATION",
    target_id: first.fulfillmentReference,
  });
  // A Ready pickup has nothing left to cancel.
  await assert.rejects(
    run((tx) => cancellation.cancelItems(tx, command(first, [0], "2026-08-11T18:06:00.000Z"))),
    { code: "FULFILLMENT_READINESS_DEPENDENCY_UNAVAILABLE" },
  );

  // 2. Cancel line 1 first; the pickup stays Pending until line 2 is ready. A ready event for
  // the cancelled line is refused and a second cancellation of it is refused.
  const second = await createPickup(0x7000, 2);
  const secondCommand = command(second, [0], "2026-08-11T18:02:00.000Z");
  const pending = await run((tx) => cancellation.cancelItems(tx, secondCommand));
  assert.equal(pending.canonicalPhase, "Pending");
  await assert.rejects(ready(second, 0, "2026-08-11T18:03:00.000Z"));
  await assert.rejects(
    run((tx) => cancellation.cancelItems(tx, command(second, [0], "2026-08-11T18:03:00.000Z"))),
  );
  assert.equal((await ready(second, 1, "2026-08-11T18:04:00.000Z")).status, "Applied");
  const secondState = await lock(second);
  assert.equal(secondState.canonicalPhase, "Ready");
  assert.equal(secondState.aggregateVersion, 3n);
  assert.equal(secondState.items.length, 1);

  // 3. Dine-in orders have no pickup fulfillment.
  assert.deepEqual(
    await run((tx) =>
      cancellation.cancelItems(tx, {
        ...command(second, [1], "2026-08-11T18:05:00.000Z"),
        orderReference: id(0x7fff),
      }),
    ),
    { status: "NoFulfillment" },
  );
  // Denied authority writes nothing.
  await assert.rejects(
    run((tx) =>
      cancellation.cancelItems(tx, {
        ...command(second, [1], "2026-08-11T18:05:00.000Z"),
        actorReference: id(0x7ffe),
      }),
    ),
  );

  // 4. Database guards: append-only facts; a ready fact for a cancelled line is refused.
  await assert.rejects(
    client.query(
      "UPDATE rms_fulfillment.fulfillment_item_cancellation SET phase_after='Pending' WHERE fulfillment_id=$1",
      [first.fulfillmentReference],
    ),
    /append-only/u,
  );
  await client.query(
    "DELETE FROM rms_fulfillment.fulfillment_item_cancellation WHERE fulfillment_id=$1",
    [first.fulfillmentReference],
  );
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM rms_fulfillment.fulfillment_item_cancellation WHERE fulfillment_id IN ($1,$2)",
        [first.fulfillmentReference, second.fulfillmentReference],
      )
    ).rows[0].count,
    2,
  );
  const readyRow = (
    await client.query(
      "SELECT * FROM rms_fulfillment.fulfillment_item_ready_result WHERE fulfillment_id=$1",
      [second.fulfillmentReference],
    )
  ).rows[0];
  await assert.rejects(
    client.query(
      "INSERT INTO rms_fulfillment.fulfillment_item_ready_result (fulfillment_item_ready_result_id,brand_id,store_id," +
        "fulfillment_id,fulfillment_item_id,order_id,order_batch_id,order_item_id,kitchen_ticket_id," +
        "kitchen_ready_result_id,source_event_id,ready_quantity,occurred_at,data_classification) " +
        "SELECT $1,brand_id,store_id,fulfillment_id,$2,order_id,order_batch_id,$3,kitchen_ticket_id,$4,$5,1," +
        "occurred_at,data_classification FROM rms_fulfillment.fulfillment_item_ready_result WHERE fulfillment_item_ready_result_id=$6",
      [
        next(),
        second.items[0].fulfillmentItemReference,
        second.items[0].orderItemReference,
        next(),
        next(),
        readyRow.fulfillment_item_ready_result_id,
      ],
    ),
    /cancelled pickup line cannot become ready/u,
  );
}
