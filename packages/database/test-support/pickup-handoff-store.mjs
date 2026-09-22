import assert from "node:assert/strict";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import {
  createPostgresPickupHandoffStore,
  parseFulfillmentCompletedEnvelope,
  fulfillmentCompletedSemanticBinding,
} from "../../rms/fulfillment/src/index.ts";

/** Actual handoff persistence; staff/location/device eligibility remains synthetic. */
export async function exercisePickupHandoffStore({
  client,
  run,
  scope,
  creation,
  id,
  options,
  verification,
  proofAt,
  proofStore,
  parallelTransactions = false,
}) {
  let allowed = true,
    eligible = true,
    admitted = true,
    failAt = null,
    reached;
  const actorReference = id(800),
    orderReference = creation.aggregate.orderReference;
  const store = createPostgresPickupHandoffStore({
    ...options,
    actorReference,
    deriveCompletionReference: (kind, identity) => {
      const digest = options.sha256(kind + ":" + identity).slice(7);
      return (
        "0198cafe-" +
        digest.slice(0, 4) +
        "-7" +
        digest.slice(4, 7) +
        "-8" +
        digest.slice(7, 10) +
        "-" +
        digest.slice(10, 22)
      );
    },
    authorize: async () => allowed,
    validateCurrentSource: (tx, order) =>
      eligible ? options.validateCurrentSource(tx, order) : Promise.resolve(false),
    admit: async (_tx, command) =>
      admitted &&
      command.deviceReference === id(801) &&
      command.pickupLocationReference === id(802),
    appendAudit: async (tx, audit) => {
      await appendAuditRecordInTransaction(tx, {
        auditId: audit.auditReference,
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "User", reference: audit.actorReference },
        actionCode: audit.actionCode,
        targetType: "Fulfillment",
        targetId: audit.fulfillmentReference,
        afterSummary: { action: "CompletePickupHandoff" },
        reasonCode: "PICKUP_HANDOFF",
        correlationId: audit.correlationReference,
        occurredAt: audit.occurredAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Confidential",
        retentionPolicyCode: "FULFILLMENT_BUSINESS_RECORD",
        retentionPolicyVersion: 1,
      });
      if (failAt === "audit") {
        reached = true;
        throw new Error("synthetic handoff audit failure");
      }
    },
  });
  const load = () => run((transaction) => store.lockByOrder({ transaction, orderReference }));
  const initial = await load();
  const command = (state, n, quantities) => ({
    fulfillmentReference: creation.aggregate.fulfillmentReference,
    ...scope,
    expectedAggregateVersion: state.source.aggregateVersion,
    purpose: "CompletePickupHandoff",
    actorReference,
    actorPermissions: ["fulfillment.pickup.complete"],
    verification,
    recipientType: "Customer",
    recipientDisplayMask: "S***",
    pickupLocationReference: id(802),
    deviceReference: id(801),
    quantities,
    handoffReference: id(810 + n * 10),
    operationReference: id(811 + n * 10),
    auditReference: id(812 + n * 10),
    idempotencyReference: id(813 + n * 10),
    correlationReference: id(814 + n * 10),
    handedOverAt: proofAt(0.8 + n * 0.1),
  });
  const total = initial.source.items.reduce((sum, item) => sum + item.orderedQuantity, 0);
  const first = command(initial, 0, [
    { fulfillmentItemReference: initial.source.items[0].fulfillmentItemReference, quantity: 1 },
  ]);
  const complete = (request, transaction) =>
    store.complete({ transaction, orderReference, command: request });
  const counts = async () =>
    (
      await client.query(
        "SELECT (SELECT count(*)::int FROM rms_fulfillment.pickup_handoff_record WHERE brand_id=$1) AS records," +
          "(SELECT count(*)::int FROM rms_fulfillment.pickup_handoff_item WHERE brand_id=$1) AS items," +
          "(SELECT count(*)::int FROM rms_fulfillment.pickup_handoff_operation WHERE brand_id=$1) AS operations," +
          "(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1) AS audits," +
          "(SELECT count(*)::int FROM rms_fulfillment.fulfillment_completion_publication WHERE brand_id=$1) AS publications," +
          "(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE brand_id=$1 AND event_type='FulfillmentCompleted') AS completions",
        [scope.brandReference],
      )
    ).rows[0];
  const baseline = await counts();
  admitted = false;
  await assert.rejects(run((tx) => complete(first, tx)));
  admitted = true;
  await assert.rejects(run((tx) => complete({ ...first, actorPermissions: [] }, tx)));
  await assert.rejects(run((tx) => complete({ ...first, deviceReference: id(899) }, tx)));
  await assert.rejects(
    run((tx) =>
      complete({ ...first, verification: { ...verification, verificationReference: id(898) } }, tx),
    ),
  );
  assert.deepEqual(await counts(), baseline);
  for (const point of [
    "INSERT INTO rms_fulfillment.pickup_handoff_record",
    "INSERT INTO rms_fulfillment.pickup_handoff_item",
    "INSERT INTO rms_fulfillment.pickup_handoff_operation",
    "audit",
  ]) {
    failAt = point;
    reached = false;
    await run(async (tx) => {
      await assert.rejects(
        complete(first, {
          query: (sql, args) => {
            if (sql.startsWith(point)) {
              reached = true;
              throw new Error("synthetic handoff write failure");
            }
            return tx.query(sql, args);
          },
        }),
      );
    });
    assert.equal(reached, true);
    assert.deepEqual(await counts(), baseline);
  }
  failAt = null;
  async function failCompletion(request) {
    const before = await counts();
    for (const point of [
      "INSERT INTO rms_fulfillment.fulfillment_completion_publication",
      "INSERT INTO platform_eventing.outbox_event",
    ]) {
      reached = false;
      await run(async (tx) => {
        await assert.rejects(
          complete(request, {
            query: (sql, args) => {
              if (sql.startsWith(point)) {
                reached = true;
                throw new Error("synthetic completion failure");
              }
              return tx.query(sql, args);
            },
          }),
        );
      });
      assert.equal(reached, true);
      assert.deepEqual(await counts(), before);
    }
  }
  if (total === 1) await failCompletion(first);
  const attempts = parallelTransactions
    ? await Promise.all([run((tx) => complete(first, tx)), run((tx) => complete(first, tx))])
    : [await run((tx) => complete(first, tx))];
  assert.equal(attempts.filter((result) => result.status === "Applied").length, 1);
  if (parallelTransactions) {
    assert.equal(attempts.filter((result) => result.status === "AlreadyApplied").length, 1);
    assert.deepEqual(attempts[0].effect, attempts[1].effect);
  }
  const applied = attempts.find((result) => result.status === "Applied");
  let current = await load();
  assert.equal(current.source.aggregateVersion, initial.source.aggregateVersion + 1n);
  let expectedOperations = 1;
  if (total > 1) {
    assert.equal(current.source.canonicalPhase, "InProgress");
    assert.equal((await counts()).completions, 0);
    assert.equal((await counts()).publications, 0);
    const remaining = current.source.items
      .filter((i) => i.handedOverQuantity < i.readyQuantity)
      .map((i) => ({
        fulfillmentItemReference: i.fulfillmentItemReference,
        quantity: i.readyQuantity - i.handedOverQuantity,
      }));
    const second = command(current, 1, remaining);
    await failCompletion(second);
    const later = await run((tx) => complete(second, tx));
    assert.equal(later.status, "Applied");
    assert.equal(
      later.effect.record.verificationReference,
      applied.effect.record.verificationReference,
    );
    expectedOperations++;
    current = await load();
  }
  assert.equal(current.source.canonicalPhase, "Completed");
  assert.equal(
    current.source.aggregateVersion,
    initial.source.aggregateVersion + BigInt(expectedOperations),
  );
  assert.equal(
    current.source.items.every(
      (i) => i.handedOverQuantity === i.orderedQuantity && i.state === "HandedOver",
    ),
    true,
  );
  await assert.rejects(run((tx) => complete(command(current, 3, first.quantities), tx)));
  await assert.rejects(
    run((tx) => complete({ ...first, quantities: [{ ...first.quantities[0], quantity: 2 }] }, tx)),
  );
  await assert.rejects(
    run((transaction) => proofStore.lockByOrder({ transaction, orderReference })),
  );
  const persisted = (
    await client.query(
      "SELECT * FROM rms_fulfillment.pickup_handoff_operation WHERE brand_id=$1 AND store_id=$2 AND idempotency_id=$3",
      [scope.brandReference, scope.storeReference, first.idempotencyReference],
    )
  ).rows[0];
  const original = persisted.handoff_record_json;
  const wrongStore = globalThis.structuredClone(original);
  wrongStore.effect.record.storeReference = id(899);
  for (const record of [
    { effect: original.effect },
    { ...original, recordVersion: 2 },
    { ...original, extra: true },
    wrongStore,
  ]) {
    const row = { ...persisted, handoff_record_json: JSON.stringify(record) },
      columns = Object.keys(row);
    await assert.rejects(
      client.query(
        "INSERT INTO rms_fulfillment.pickup_handoff_operation (" +
          columns.join(",") +
          ") VALUES (" +
          columns.map((_, i) => "$" + (i + 1)).join(",") +
          ")",
        columns.map((key) => row[key]),
      ),
      { code: "23514", constraint: "pickup_handoff_record_binding_check" },
    );
  }
  await assert.rejects(
    client.query(
      "UPDATE rms_fulfillment.pickup_handoff_operation SET handoff_record_json=NULL WHERE brand_id=$1 AND idempotency_id=$2",
      [scope.brandReference, first.idempotencyReference],
    ),
    /append-only/u,
  );
  const beforeReplay = await counts();
  eligible = false;
  admitted = false;
  const recovered = await run((tx) => complete(first, tx));
  assert.equal(recovered.status, "AlreadyApplied");
  assert.deepEqual(recovered.effect, applied.effect);
  allowed = false;
  await assert.rejects(
    run((transaction) =>
      store.resolveByIdempotency({
        transaction,
        orderReference,
        idempotencyReference: first.idempotencyReference,
      }),
    ),
  );
  assert.deepEqual(await counts(), beforeReplay);
  assert.equal(beforeReplay.operations, expectedOperations);
  assert.equal(beforeReplay.publications, 1);
  assert.equal(beforeReplay.completions, 1);
  const publication = (
    await client.query(
      "SELECT * FROM rms_fulfillment.fulfillment_completion_publication WHERE brand_id=$1 AND store_id=$2 AND fulfillment_id=$3",
      [scope.brandReference, scope.storeReference, creation.aggregate.fulfillmentReference],
    )
  ).rows[0];
  const event = (
    await client.query(
      "SELECT * FROM platform_eventing.outbox_event WHERE brand_id=$1 AND store_id=$2 AND event_id=$3",
      [scope.brandReference, scope.storeReference, publication.outbox_event_id],
    )
  ).rows[0];
  const completed = parseFulfillmentCompletedEnvelope({
    eventId: event.event_id,
    eventType: event.event_type,
    schemaVersion: event.schema_version,
    occurredAt: event.occurred_at.toISOString(),
    producerModule: event.producer_module,
    tenantId: event.brand_id,
    storeId: event.store_id,
    aggregateType: event.aggregate_type,
    aggregateId: event.aggregate_id,
    aggregateVersion: BigInt(event.aggregate_version),
    correlationId: event.correlation_id,
    causationId: event.causation_id,
    actor: { type: event.actor_type },
    payload: event.payload_json,
    redactionClassification: event.redaction_classification,
    replayMetadata: event.replay_metadata_json,
  });
  assert.equal(completed.aggregateVersion, current.source.aggregateVersion);
  assert.equal(completed.payload.orderReference, orderReference);
  assert.equal(completed.payload.handoffRecordReference, publication.pickup_handoff_id);
  assert.equal(completed.causationId, publication.causation_operation_id);
  assert.equal(
    options.sha256(fulfillmentCompletedSemanticBinding(completed)),
    publication.event_semantic_digest,
  );
  assert.deepEqual(Object.keys(completed.payload).sort(), [
    "completedAt",
    "fulfillmentReference",
    "handoffRecordReference",
    "orderReference",
    "storeReference",
    "verificationMethod",
  ]);
  return completed;
}
