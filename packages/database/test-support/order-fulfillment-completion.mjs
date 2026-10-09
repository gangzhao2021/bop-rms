import { createPersistentConsumerWorker } from "../../../apps/worker/src/persistent-consumer-worker.ts";
import { createOutboxWorkload } from "../../../apps/worker/src/outbox-workload.ts";
import { setTimeout as waitUntilDue } from "node:timers/promises";
import { createOrderCreatedProjectionComposition } from "../../../apps/api/src/order-created-projection-composition.ts";
import assert from "node:assert/strict";
import {
  createOrderStatusCreationSource,
  parseOrderCreatedEnvelope,
  createPostgresOrderInitialExecutionReader,
  createPostgresPickupOrderCompletionLookup,
  createPostgresOrderStatusProjectionStore,
  createFulfillmentCompletedEventConsumerService,
  parseOrderStatusProjection,
  createPostgresOrderExecutionReader,
  createPostgresOrderTerminationStore,
  createOrderFulfillmentCompletionRecord,
  decodeOrderFulfillmentCompletionRecord,
} from "../../rms/ordering/src/index.ts";
import {
  createOrderFulfillmentComposition,
  createOrderFulfillmentEventComposition,
} from "../../../apps/api/src/order-fulfillment-composition.ts";

/** Actual owner persistence and published Workflow; Store/system authorization is synthetic. */
export async function exerciseOrderFulfillmentCompletion({
  additionalServices = [],
  acquire,
  admin,
  run,
  role,
  scope,
  order,
  event,
  hash,
  paymentWorkflow,
  quoteVersion,
  id,
}) {
  await admin.query(
    "GRANT SELECT,INSERT ON rms_ordering.order_fulfillment_completion_record TO " + role,
  );
  await admin.query("GRANT SELECT ON rms_ordering.order_termination_record TO " + role);
  await admin.query("GRANT SELECT,INSERT ON rms_ordering.order_revision TO " + role);
  const ownerScope = { brandReference: scope.brandReference, storeReference: scope.storeReference };
  const lookup = {
    orderReference: order.order.orderReference,
    orderBatchReference: order.order.batches[0].orderBatchReference,
  };
  const reader = createPostgresOrderInitialExecutionReader({
    ...ownerScope,
    authorize: async () => true,
  });
  const before = await run((transaction) => reader.loadByBatch({ transaction, ...lookup }));
  const association = createPostgresPickupOrderCompletionLookup({
    ...ownerScope,
    authorize: async () => true,
  });
  const readAssociation = () =>
    run((transaction) =>
      association.loadByOrder({
        transaction,
        orderReference: event.payload.orderReference,
      }),
    );
  assert.deepEqual(await readAssociation(), {
    ...ownerScope,
    ...lookup,
    submissionReference: order.submissionReference,
  });
  let readable = true;
  const execution = createPostgresOrderExecutionReader({
    ...ownerScope,
    sha256: hash,
    authorize: async () => readable,
  });
  const readExecution = () =>
    run((transaction) => execution.loadByBatch({ transaction, ...lookup }));
  assert.deepEqual(await readExecution(), { ...before, completion: null });
  assert.equal(before.phase, "Accepted");
  let allowed = true,
    workflowAllowed = true,
    workflowCalls = 0;
  const compositionOptions = {
    scope,
    quoteVersion,
    systemActorReference: id(20),
    sha256: hash,
    fulfillment: {
      action: "FulfillOrder",
      purposeCode: paymentWorkflow.purposeCode,
      permissionCode: "order.fulfill",
    },
    authorize: async () => allowed,
    gates: {
      authorizeResource: async () => true,
      authorizeAction: async () => {
        workflowCalls++;
        return workflowAllowed;
      },
      evaluateRule: async () => {
        throw new Error("unexpected synthetic completion rule");
      },
      authorizeOverride: async () => false,
    },
    validateEligibility: async (_transaction, candidate, currentOrder) =>
      candidate.sourceEvent.eventId === event.eventId &&
      currentOrder.order.orderReference === order.order.orderReference,
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
  };
  const composition = createOrderFulfillmentComposition(compositionOptions);
  let generationAvailable = true;
  const eventComposition = createOrderFulfillmentEventComposition({
    ...compositionOptions,
    authorizeEvent: async () => allowed,
    workflowVersionReference: paymentWorkflow.workflowVersionReference,
    transitionReference: paymentWorkflow.fulfillmentTransitionReference,
    references: {
      derive: (kind, eventReference) => {
        assert.equal(generationAvailable, true);
        assert.equal(eventReference, event.eventId);
        return id({ Completion: 1, Operation: 2, Audit: 3 }[kind]);
      },
      now: () => {
        assert.equal(generationAvailable, true);
        return event.occurredAt;
      },
    },
  });
  const store = {
    commit: (input) => composition.commit(input),
  };
  const record = createOrderFulfillmentCompletionRecord(
    {
      completionReference: id(1),
      operationReference: id(2),
      auditReference: id(3),
      ...ownerScope,
      ...lookup,
      orderType: "Pickup",
      phaseBefore: before.phase,
      expectedOrderVersion: before.version,
      expectedSourceCheckpoint: before.checkpoint,
      fulfilledOrderVersion: before.version + 1,
      phase: "Fulfilled",
      closureStatus: "Open",
      actorType: "System",
      actorReference: null,
      purposeCode: paymentWorkflow.purposeCode,
      permissionCode: "order.fulfill",
      workflowVersionReference: paymentWorkflow.workflowVersionReference,
      transitionReference: paymentWorkflow.fulfillmentTransitionReference,
      completedAt: event.occurredAt,
      recordedAt: event.occurredAt,
      sourceEvent: event,
    },
    hash,
  );
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_ordering.order_fulfillment_completion_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3) AS records," +
          "(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1 AND store_id=$2 AND target_id=$3 AND action_code='ORDER_FULFILLED') AS audits," +
          "(SELECT count(*)::int FROM rms_ordering.order_revision WHERE brand_id=$1 AND store_id=$2 AND order_id=$3) AS revisions",
        [scope.brandReference, scope.storeReference, lookup.orderReference],
      )
    ).rows[0];
  const initial = await counts();
  assert.deepEqual(initial, { records: 0, audits: 0, revisions: before.version });
  for (const point of [
    "INSERT INTO rms_ordering.order_fulfillment_completion_record",
    "INSERT INTO platform_audit.audit_record",
    "INSERT INTO rms_ordering.order_revision",
  ]) {
    let reached = false;
    await run(async (tx) => {
      const failing = {
        query: async (sql, values) => {
          if (sql.startsWith(point)) {
            reached = true;
            if (point === "INSERT INTO rms_ordering.order_revision") await tx.query(sql, values);
            throw new Error("synthetic completion failure");
          }
          return tx.query(sql, values);
        },
      };
      await assert.rejects(store.commit({ transaction: failing, record }), {
        code: "ORDER_FULFILLMENT_COMPLETION_UNAVAILABLE",
      });
    }); // Deliberately commit after catching: savepoint must remove record AND Audit.
    assert.equal(reached, true);
    assert.deepEqual(await counts(), initial);
  }
  await admin.query(
    "GRANT SELECT,INSERT ON rms_ordering.order_status_projection_generation TO " + role,
  );
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON rms_ordering.order_status_projection TO " + role,
  );
  const createdRows = (
    await admin.query(
      "SELECT * FROM platform_eventing.outbox_event WHERE brand_id=$1 AND store_id=$2 AND aggregate_id=$3 AND event_type='OrderCreated' LIMIT 2",
      [scope.brandReference, scope.storeReference, lookup.orderReference],
    )
  ).rows;
  assert.equal(createdRows.length, 1);
  const row = createdRows[0];
  const createdEvent = parseOrderCreatedEnvelope({
    eventId: row.event_id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at.toISOString(),
    producerModule: row.producer_module,
    tenantId: row.brand_id,
    storeId: row.store_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: BigInt(row.aggregate_version),
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    actor:
      row.actor_type === "System"
        ? { type: "System" }
        : { type: row.actor_type, reference: row.actor_reference },
    payload: row.payload_json,
    redactionClassification: row.redaction_classification,
    replayMetadata: row.replay_metadata_json,
  });
  const locale = Object.keys(order.items[0].catalog.localizedNames)[0];
  const snapshot = createOrderStatusCreationSource({
    record: order,
    quoteVersion,
    envelope: createdEvent,
    locale,
    sha256: hash,
  });
  const expectedCompletedSnapshot = {
    ...snapshot,
    sourceVersion: record.fulfilledOrderVersion,
    sourceCheckpoint: record.completionReference,
    sourceDigest: record.sourceDigest,
    canonicalPhase: "Fulfilled",
    fulfillmentStatus: "Completed",
    fulfillmentReference: event.aggregateId,
    fulfillmentCompletionEventReference: event.eventId,
    fulfillmentCompletedAt: event.occurredAt,
  };
  const equalJson = (value) =>
    JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry));
  const projections = createPostgresOrderStatusProjectionStore({
    ...ownerScope,
    authorize: async () => allowed,
    validateCurrentSource: async (transaction, candidate) => {
      const state = await execution.loadByBatch({ transaction, ...lookup });
      const expected = state.completion ? expectedCompletedSnapshot : snapshot;
      const normalized = parseOrderStatusProjection({ ...candidate, snapshot: expected });
      return (
        equalJson(candidate.snapshot) === equalJson(normalized.snapshot) &&
        (state.completion !== null || candidate.freshnessStatus === "Stale")
      );
    },
  });
  const originalProjection = parseOrderStatusProjection({
    projectionName: "ordering_order_status_v1",
    projectionVersion: 1,
    generationReference: id(40),
    projectedAt: record.recordedAt,
    freshnessStatus: "Stale",
    snapshot,
  });
  const createdConsumer = createOrderCreatedProjectionComposition({
    scope: ownerScope,
    quoteVersion,
    locale,
    sha256: hash,
    authorization: { authorize: async () => allowed },
    projections,
    references: { generateGeneration: () => id(40), now: () => record.recordedAt },
  });
  const consumer = createFulfillmentCompletedEventConsumerService({
    authorization: { authorize: async () => allowed },
    completions: {
      commit: async (transaction, envelope) =>
        (await eventComposition.commitEvent({ transaction, envelope })).record,
    },
    projections,
    references: { generateGeneration: () => id(41), now: () => record.recordedAt },
    digests: { sha256: hash },
  });
  await admin.query(
    "GRANT UPDATE (published_at,attempt_count,last_error_code,lease_token,lease_owner,lease_expires_at,available_at,ordering_released_at) ON platform_eventing.outbox_event TO " +
      role,
  );
  const dispatchScope = { brandId: scope.brandReference, storeId: scope.storeReference };
  let token = 60;
  await admin.query(
    "GRANT SELECT,INSERT ON platform_eventing.delivery_attempt,platform_eventing.dead_letter_item TO " +
      role,
  );
  // A dead letter is reopened when an operator retry fails again (ON CONFLICT DO UPDATE); the
  // pilot runtime role holds the same privilege.
  await admin.query("GRANT UPDATE ON platform_eventing.dead_letter_item TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON platform_eventing.consumer_retry_schedule TO " + role,
  );
  let decisionSequence = 10000;
  const decisionIdentities = new Map();
  const identities = (key) => {
    if (!decisionIdentities.has(key))
      decisionIdentities.set(key, {
        attemptId: id(decisionSequence++),
        deadLetterId: id(decisionSequence++),
        idempotencyKey: id(decisionSequence++),
        scheduleId: id(decisionSequence++),
      });
    return decisionIdentities.get(key);
  };
  const runtime = createPersistentConsumerWorker({
    connections: { acquire },
    eventing: {
      authorizeScope: async (requested) =>
        requested.brandId === scope.brandReference && requested.storeId === scope.storeReference,
      now: () => new Date().toISOString(),
      random: () => 0.5,
      outboxIdentities: (eventId, attemptNumber) =>
        identities("outbox:" + eventId + ":" + attemptNumber),
      consumerIdentities: (input) =>
        identities(input.consumerName + ":" + input.eventId + ":" + input.attemptNumber),
    },
    services: [createdConsumer, consumer, ...additionalServices],
    scopes: [dispatchScope],
    leaseOwner: "wp2402_paid_worker",
    newLeaseToken: () => id(token++),
    config: { batchMaximum: 1, perScopeMaximum: 1, adapterConcurrency: 1 },
    pollIntervalMs: 25,
    drainDeadlineMs: 25000,
  });
  const { dispatcher, delivery: createdDelivery } = runtime;
  const completedDelivery = runtime.delivery;
  const dispatchUntilPublished = async (eventReference) => {
    for (let batch = 0; batch < 100; batch++) {
      const row = (
        await admin.query(
          "SELECT published_at FROM platform_eventing.outbox_event WHERE brand_id=$1 AND store_id=$2 AND event_id=$3",
          [scope.brandReference, scope.storeReference, eventReference],
        )
      ).rows[0];
      assert.ok(row);
      if (row.published_at) return;
      assert.equal(await dispatcher.runOnce(), 1, "due target must remain claimable");
    }
    assert.fail("bounded fixture dispatch did not publish target");
  };
  await dispatchUntilPublished(createdEvent.eventId);
  assert.deepEqual(
    await run((transaction) =>
      projections.load({ transaction, orderReference: lookup.orderReference }),
    ),
    originalProjection,
  );
  const projectionCounts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_ordering.order_status_projection_generation WHERE brand_id=$1 AND store_id=$2 AND order_id=$3) AS generations," +
          "(SELECT count(*)::int FROM platform_eventing.consumer_inbox WHERE brand_id=$1 AND store_id=$2 AND consumer_name='ordering.fulfillment-completed:v2') AS inbox",
        [scope.brandReference, scope.storeReference, lookup.orderReference],
      )
    ).rows[0];
  const projectionInitial = await projectionCounts();
  assert.deepEqual(projectionInitial, { generations: 1, inbox: 0 });
  for (const point of [
    "INSERT INTO rms_ordering.order_status_projection_generation",
    "INSERT INTO rms_ordering.order_status_projection (",
    "UPDATE platform_eventing.consumer_inbox",
  ]) {
    let reached = false;
    await run(async (tx) => {
      await assert.rejects(
        consumer.consume(
          {
            query: async (sql, values) => {
              if (sql.startsWith(point)) {
                reached = true;
                throw new Error("synthetic projection failure");
              }
              return tx.query(sql, values);
            },
          },
          event,
        ),
      );
    });
    assert.equal(reached, true);
    assert.deepEqual(await counts(), initial);
    assert.deepEqual(await projectionCounts(), projectionInitial);
    assert.deepEqual(
      await run((transaction) =>
        projections.load({ transaction, orderReference: lookup.orderReference }),
      ),
      originalProjection,
    );
  }
  const untilDue = Math.max(0, Date.parse(event.occurredAt) - Date.now() + 50);
  assert.ok(untilDue <= 120000, "synthetic event clock exceeded bounded dispatch wait");
  if (untilDue > 0) await waitUntilDue(untilDue);
  const workload = createOutboxWorkload({ dispatcher, pollIntervalMs: 25, drainDeadlineMs: 25000 });
  try {
    await workload.start();
    let published = false;
    for (let observation = 0; observation < 100; observation++) {
      const row = (
        await admin.query(
          "SELECT published_at FROM platform_eventing.outbox_event WHERE brand_id=$1 AND store_id=$2 AND event_id=$3",
          [scope.brandReference, scope.storeReference, event.eventId],
        )
      ).rows[0];
      if (row?.published_at) {
        published = true;
        break;
      }
      await waitUntilDue(100);
    }
    assert.equal(published, true, "continuous workload must publish actual completion");
  } finally {
    await workload.stop();
  }
  assert.equal(await workload.completion, "stopped");
  const results = await Promise.all(
    [0, 1].map(() => completedDelivery.deliver(consumer.registration.consumerName, event)),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [
    "duplicate_completed",
    "duplicate_completed",
  ]);
  assert.deepEqual(await projectionCounts(), { generations: 2, inbox: 1 });
  const finalProjection = await run((transaction) =>
    projections.load({ transaction, orderReference: lookup.orderReference }),
  );
  assert.deepEqual(
    finalProjection.snapshot,
    parseOrderStatusProjection({ ...finalProjection, snapshot: expectedCompletedSnapshot })
      .snapshot,
  );
  assert.equal(finalProjection.freshnessStatus, "Fresh");
  assert.equal(
    (await createdDelivery.deliver(createdConsumer.registration.consumerName, createdEvent)).status,
    "duplicate_completed",
  );
  assert.deepEqual(
    await run((transaction) =>
      projections.load({ transaction, orderReference: lookup.orderReference }),
    ),
    finalProjection,
  );

  assert.deepEqual(await counts(), {
    records: 1,
    audits: 1,
    revisions: record.fulfilledOrderVersion,
  });
  const saved = (
    await admin.query(
      "SELECT completion_record_json::text AS record FROM rms_ordering.order_fulfillment_completion_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3",
      [scope.brandReference, scope.storeReference, lookup.orderReference],
    )
  ).rows[0];
  assert.deepEqual(decodeOrderFulfillmentCompletionRecord(saved.record, hash), record);
  const revision = await admin.query(
    "SELECT revision_id,kind,version,expected_version,previous_revision_id,occurred_at FROM rms_ordering.order_revision WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND version=$4",
    [
      scope.brandReference,
      scope.storeReference,
      lookup.orderReference,
      record.fulfilledOrderVersion,
    ],
  );
  assert.equal(revision.rows.length, 1);
  assert.deepEqual(revision.rows[0], {
    revision_id: record.completionReference,
    kind: "Fulfillment",
    version: record.fulfilledOrderVersion,
    expected_version: record.expectedOrderVersion,
    previous_revision_id: record.expectedSourceCheckpoint,
    occurred_at: new Date(record.recordedAt),
  });
  const current = await readExecution();
  assert.deepEqual(current, {
    ...ownerScope,
    ...lookup,
    phase: "Fulfilled",
    version: record.fulfilledOrderVersion,
    checkpoint: record.completionReference,
    occurredAt: record.recordedAt,
    completion: record,
  });
  assert.equal(current.completion.closureStatus, "Open");
  assert.deepEqual(await readAssociation(), {
    ...ownerScope,
    ...lookup,
    submissionReference: order.submissionReference,
  });
  readable = false;
  await assert.rejects(readExecution(), { code: "ORDER_TERMINATION_UNAVAILABLE" });
  readable = true;
  await assert.rejects(
    run((transaction) => reader.loadByBatch({ transaction, ...lookup })),
    { code: "ORDER_TERMINATION_CONFLICT" },
  );
  const termination = createPostgresOrderTerminationStore({
    ...ownerScope,
    authorize: async () => true,
    validateCurrentSource: async () => {
      throw new Error("completed Order must fail before cancellation eligibility");
    },
    audit: async () => {
      throw new Error("completed Order must not emit cancellation Audit");
    },
  });
  await assert.rejects(
    run((transaction) =>
      termination.commit({
        transaction,
        record: {
          terminationReference: id(30),
          operationReference: id(31),
          ...ownerScope,
          ...lookup,
          expectedOrderVersion: before.version,
          terminatedOrderVersion: before.version + 1,
          expectedSourceCheckpoint: before.checkpoint,
          previousPhase: "Accepted",
          phase: "Cancelled",
          actorType: "System",
          actorReference: null,
          purposeCode: "OrderCancellation",
          permissionCode: "order.cancel",
          reasonCode: "SYNTHETIC_TEST",
          workflowVersionReference: record.workflowVersionReference,
          transitionReference: id(32),
          sourceDigest: hash("synthetic cancellation"),
          terminatedAt: record.recordedAt,
        },
      }),
    ),
    { code: "ORDER_TERMINATION_CONFLICT" },
  );
  const callsBeforeRetry = workflowCalls;
  workflowAllowed = false;
  generationAvailable = false;
  const eventRetry = await run((transaction) =>
    eventComposition.commitEvent({ transaction, envelope: event }),
  );
  assert.equal(eventRetry.status, "AlreadyCommitted");
  assert.deepEqual(eventRetry.record, record);
  await assert.rejects(
    run((transaction) =>
      eventComposition.commitEvent({
        transaction,
        envelope: { ...event, eventId: id(99) },
      }),
    ),
    { code: "ORDER_FULFILLMENT_COMPLETION_CONFLICT" },
  );
  const retried = await run((transaction) => store.commit({ transaction, record }));
  assert.equal(retried.status, "AlreadyCommitted");
  assert.deepEqual(retried.record, record);
  assert.equal(workflowCalls, callsBeforeRetry);
  const publications = (
    await admin.query(
      "SELECT event_type,attempt_count,published_at,last_error_code FROM platform_eventing.outbox_event WHERE brand_id=$1 AND store_id=$2 AND event_id=ANY($3::uuid[])",
      [scope.brandReference, scope.storeReference, [createdEvent.eventId, event.eventId]],
    )
  ).rows;
  assert.equal(publications.length, 2);
  for (const publication of publications) {
    assert.ok(
      publication.published_at,
      JSON.stringify({
        eventType: publication.event_type,
        attempts: publication.attempt_count,
        errorCode: publication.last_error_code,
      }),
    );
    assert.equal(publication.last_error_code, null);
  }
  assert.equal(await dispatcher.stop(), "drained");
  assert.deepEqual(await projectionCounts(), { generations: 2, inbox: 1 });
  assert.deepEqual(await counts(), {
    records: 1,
    audits: 1,
    revisions: record.fulfilledOrderVersion,
  });
  allowed = false;
  assert.deepEqual(await completedDelivery.deliver(consumer.registration.consumerName, event), {
    status: "retry_required",
    errorCode: "CONSUMER_TEMPORARY_FAILURE",
  });
  assert.deepEqual(
    await createdDelivery.deliver(createdConsumer.registration.consumerName, createdEvent),
    {
      status: "retry_required",
      errorCode: "CONSUMER_TEMPORARY_FAILURE",
    },
  );
  const retryEvidence = (
    await admin.query(
      "SELECT count(*)::int AS count FROM platform_eventing.consumer_retry_schedule WHERE brand_id=$1 AND store_id=$2 AND state='scheduled' AND consumer_name=ANY($3::text[])",
      [
        scope.brandReference,
        scope.storeReference,
        [consumer.registration.consumerName, createdConsumer.registration.consumerName],
      ],
    )
  ).rows[0];
  assert.equal(retryEvidence.count, 2);
  const attempts = (
    await admin.query(
      "SELECT count(*)::int AS count FROM platform_eventing.delivery_attempt WHERE brand_id=$1 AND store_id=$2 AND consumer_name=ANY($3::text[])",
      [
        scope.brandReference,
        scope.storeReference,
        [consumer.registration.consumerName, createdConsumer.registration.consumerName],
      ],
    )
  ).rows[0];
  assert.equal(attempts.count, 2);
  await assert.rejects(
    run((transaction) =>
      eventComposition.commitEvent({
        transaction,
        envelope: event,
      }),
    ),
    { code: "ORDER_FULFILLMENT_COMPLETION_UNAVAILABLE" },
  );
  await assert.rejects(
    run((transaction) => consumer.consume(transaction, event)),
    { code: "ORDER_STATUS_PERMISSION_DENIED" },
  );
  await assert.rejects(
    run((transaction) => store.commit({ transaction, record })),
    { code: "ORDER_FULFILLMENT_COMPLETION_UNAVAILABLE" },
  );
  allowed = true;
  const retryDue = (
    await admin.query(
      "SELECT max(available_at) AS due FROM platform_eventing.consumer_retry_schedule WHERE brand_id=$1 AND store_id=$2 AND state='scheduled'",
      [scope.brandReference, scope.storeReference],
    )
  ).rows[0].due;
  const retryWait = Math.max(0, retryDue.getTime() - Date.now() + 25);
  assert.ok(retryWait <= 2000, "first retry delay must remain bounded by existing policy");
  if (retryWait > 0) await waitUntilDue(retryWait);
  try {
    await runtime.workload.start();
  } finally {
    await runtime.workload.stop();
  }
  assert.equal(await runtime.workload.completion, "stopped");
  const recovered = (
    await admin.query(
      "SELECT count(*)::int AS count FROM platform_eventing.consumer_retry_schedule WHERE brand_id=$1 AND store_id=$2 AND state='completed' AND lease_token IS NULL",
      [scope.brandReference, scope.storeReference],
    )
  ).rows[0];
  assert.equal(recovered.count, 2);
  assert.deepEqual(await projectionCounts(), { generations: 2, inbox: 1 });
  assert.deepEqual(await counts(), {
    records: 1,
    audits: 1,
    revisions: record.fulfilledOrderVersion,
  });
}
