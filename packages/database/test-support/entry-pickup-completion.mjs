import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createOrderFulfillmentEventComposition } from "../../../apps/api/src/order-fulfillment-composition.ts";
import { createPersistentConsumerWorker } from "../../../apps/worker/src/persistent-consumer-worker.ts";
import {
  createPostgresOrderExecutionReader,
  createPostgresOrderStatusProjectionStore,
  createFulfillmentCompletedEventConsumerService,
  parseOrderStatusProjection,
} from "../../rms/ordering/src/index.ts";

/** Original live completion and projection; System/Workflow permission remains an explicit fixture. */
export async function exerciseEntryPickupCompletion({
  admin,
  role,
  run,
  acquire,
  scope,
  order,
  event,
  reference,
}) {
  await admin.query(
    "GRANT SELECT,INSERT ON rms_ordering.order_fulfillment_completion_record,rms_ordering.order_revision TO " +
      role,
  );
  const ownerScope = { brandReference: scope.brandReference, storeReference: scope.storeReference };
  const now = () => new Date().toISOString();
  const sha256 = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const lookup = {
    orderReference: order.record.order.orderReference,
    orderBatchReference: order.record.order.batches[0].orderBatchReference,
  };
  const execution = createPostgresOrderExecutionReader({
    ...ownerScope,
    sha256,
    authorize: async () => true,
  });
  const loadExecution = () =>
    run((transaction) => execution.loadByBatch({ transaction, ...lookup }));
  const before = await loadExecution();
  assert.equal(before.phase, "Accepted");
  assert.equal(before.completion, null);
  const ids = new Map();
  const derive = (kind) => {
    if (!ids.has(kind)) ids.set(kind, reference());
    return ids.get(kind);
  };
  const workflow = order.workflow.payment;
  const composition = createOrderFulfillmentEventComposition({
    scope,
    quoteVersion: 1,
    systemActorReference: reference(),
    sha256,
    fulfillment: {
      action: "FulfillOrder",
      purposeCode: workflow.purposeCode,
      permissionCode: "order.fulfill",
    },
    authorize: async (_tx, candidate) => candidate.orderReference === lookup.orderReference,
    authorizeEvent: async (_tx, candidate) => candidate.eventId === event.eventId,
    gates: {
      authorizeResource: async () => true,
      authorizeAction: async () => true,
      authorizeOverride: async () => false,
      evaluateRule: async () => {
        throw new Error("Unexpected completion rule");
      },
    },
    validateEligibility: async (_tx, candidate, current) =>
      candidate.sourceEvent.eventId === event.eventId &&
      current.order.orderReference === lookup.orderReference,
    audit: async (r) => ({
      auditId: r.auditReference,
      brandId: r.brandReference,
      storeId: r.storeReference,
      actor: { type: "System" },
      actionCode: "ORDER_FULFILLED",
      targetType: "Order",
      targetId: r.orderReference,
      correlationId: r.operationReference,
      occurredAt: r.recordedAt,
      afterSummary: { phase: "Fulfilled", closureStatus: "Open" },
      reasonCode: "FULFILLMENT_COMPLETED",
      sourceChannel: "SYSTEM",
      dataClassification: "Restricted",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    }),
    workflowVersionReference: workflow.workflowVersionReference,
    transitionReference: workflow.fulfillmentTransitionReference,
    references: {
      derive: (kind, eventReference) => {
        assert.equal(eventReference, event.eventId);
        return derive(kind);
      },
      now,
    },
  });
  let baseline;
  const equal = (a, b) =>
    JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) ===
    JSON.stringify(b, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  const projections = createPostgresOrderStatusProjectionStore({
    ...ownerScope,
    authorize: async () => true,
    validateCurrentSource: async (transaction, candidate) => {
      const state = await execution.loadByBatch({ transaction, ...lookup });
      if (!baseline || !state.completion) return false;
      const record = state.completion;
      const expected = {
        ...baseline.snapshot,
        sourceVersion: record.fulfilledOrderVersion,
        sourceCheckpoint: record.completionReference,
        sourceDigest: record.sourceDigest,
        canonicalPhase: "Fulfilled",
        fulfillmentStatus: "Completed",
        fulfillmentReference: event.aggregateId,
        fulfillmentCompletionEventReference: event.eventId,
        fulfillmentCompletedAt: event.occurredAt,
      };
      return equal(
        candidate.snapshot,
        parseOrderStatusProjection({ ...candidate, snapshot: expected }).snapshot,
      );
    },
  });
  const loadProjection = () =>
    run((transaction) => projections.load({ transaction, orderReference: lookup.orderReference }));
  baseline = await loadProjection();
  assert(baseline);
  const consumer = createFulfillmentCompletedEventConsumerService({
    authorization: { authorize: async (_tx, candidate) => candidate.eventId === event.eventId },
    completions: {
      commit: async (transaction, envelope) =>
        (await composition.commitEvent({ transaction, envelope })).record,
    },
    projections,
    references: { generateGeneration: () => derive("Generation"), now },
    digests: { sha256 },
  });
  const decisionIds = new Map();
  const identity = (key) => {
    if (!decisionIds.has(key))
      decisionIds.set(key, {
        attemptId: reference(),
        deadLetterId: reference(),
        idempotencyKey: reference(),
        scheduleId: reference(),
      });
    return decisionIds.get(key);
  };
  const runtime = createPersistentConsumerWorker({
    connections: { acquire },
    eventing: {
      authorizeScope: async (requested) =>
        requested.brandId === scope.brandReference && requested.storeId === scope.storeReference,
      now,
      random: () => 0.5,
      outboxIdentities: (eventId, attempt) => identity(eventId + ":" + attempt),
      consumerIdentities: (input) =>
        identity(input.consumerName + ":" + input.eventId + ":" + input.attemptNumber),
    },
    services: [
      {
        registration: consumer.registration,
        consume: (tx, envelope) => consumer.consume(tx, envelope),
      },
    ],
    scopes: [{ brandId: scope.brandReference, storeId: scope.storeReference }],
    leaseOwner: "wp2402_entry_pickup_completion",
    newLeaseToken: reference,
    config: { batchMaximum: 1, perScopeMaximum: 1, adapterConcurrency: 1 },
    pollIntervalMs: 25,
    drainDeadlineMs: 25000,
  });
  try {
    await runtime.workload.start();
    let published = false;
    for (let i = 0; i < 200; i++) {
      const rows = (
        await admin.query(
          "SELECT published_at FROM platform_eventing.outbox_event WHERE event_id=$1",
          [event.eventId],
        )
      ).rows;
      assert.equal(rows.length, 1);
      if (rows[0].published_at) {
        published = true;
        break;
      }
      await delay(25);
    }
    assert(published, "Original completion must be dispatched");
  } finally {
    await runtime.workload.stop();
    assert.equal(await runtime.workload.completion, "stopped");
  }
  const after = await loadExecution();
  assert.equal(after.phase, "Fulfilled");
  assert.equal(after.completion.closureStatus, "Open");
  assert.equal(after.completion.sourceEvent.eventId, event.eventId);
  const projected = await loadProjection();
  assert.equal(projected.snapshot.canonicalPhase, "Fulfilled");
  assert.equal(projected.snapshot.fulfillmentStatus, "Completed");
  assert.notEqual(projected.generationReference, baseline.generationReference);
  const duplicate = await runtime.delivery.deliver(consumer.registration.consumerName, event);
  assert.equal(duplicate.status, "duplicate_completed");
  assert.deepEqual(await loadProjection(), projected);
  const counts = (
    await admin.query(
      "SELECT (SELECT count(*)::int FROM rms_ordering.order_fulfillment_completion_record) completions,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='ORDER_FULFILLED') audits,(SELECT count(*)::int FROM platform_eventing.consumer_inbox WHERE event_id=$1 AND consumer_name='ordering.fulfillment-completed:v2') inbox",
      [event.eventId],
    )
  ).rows[0];
  assert.deepEqual(counts, { completions: 1, audits: 1, inbox: 1 });
  return { execution: after, projection: projected };
}
