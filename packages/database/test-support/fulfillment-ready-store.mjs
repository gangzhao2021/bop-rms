import { exercisePickupProofStore } from "./pickup-proof-store.mjs";
import assert from "node:assert/strict";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import { parseKitchenItemReadyEnvelope } from "../../rms/kitchen/src/index.ts";
import {
  createFulfillmentReadinessService,
  createPostgresFulfillmentReadinessStore,
} from "../../rms/fulfillment/src/index.ts";

/** Actual two-item readiness persistence; owner creation is real, Kitchen/Ordering evidence synthetic. */
export async function exerciseFulfillmentReadyStore({ client, run, scope, creation, id, sha }) {
  let allowed = true,
    currentAllowed = true;
  const now = "2026-08-11T18:00:10.000Z";
  const store = createPostgresFulfillmentReadinessStore({
    ...scope,
    sha256: sha,
    now: () => now,
    authorize: async () => allowed,
    validateCurrentSource: async () => currentAllowed,
  });
  const service = createFulfillmentReadinessService({
    authorization: { authorize: async () => allowed },
    repository: store,
    digests: { sha256: sha },
    references: {
      derive: (purpose, identity) => {
        const digest = sha(purpose + identity).slice(7);
        return (
          "0198aefe-" +
          digest.slice(0, 4) +
          "-7" +
          digest.slice(4, 7) +
          "-8" +
          digest.slice(7, 10) +
          "-" +
          digest.slice(10, 22)
        );
      },
    },
    audit: {
      append: ({ transaction, record }) => appendAuditRecordInTransaction(transaction, record),
    },
  });
  const events = creation.aggregate.items.map((item, index) => {
    const at = new Date(
      Date.parse(creation.aggregate.createdAt) + (index + 1) * 1000,
    ).toISOString();
    return parseKitchenItemReadyEnvelope({
      eventId: id(300 + index),
      eventType: "KitchenItemReady",
      schemaVersion: 1,
      occurredAt: at,
      producerModule: "@rms/kitchen",
      tenantId: scope.brandReference,
      storeId: scope.storeReference,
      aggregateType: "KitchenOrderItemReadyResult",
      aggregateId: id(310 + index),
      aggregateVersion: 1n,
      correlationId: id(320 + index),
      causationId: id(330 + index),
      actor: { type: "System" },
      payload: {
        kitchenTicketReference: id(340),
        orderReference: creation.aggregate.orderReference,
        orderBatchReference: creation.aggregate.orderBatchReference,
        orderItemReference: item.orderItemReference,
        readyResultReference: id(310 + index),
        readyQuantity: item.orderedQuantity,
        requiredQuantity: item.orderedQuantity,
        readyAt: at,
      },
      redactionClassification: "indirect_identifier",
      replayMetadata: { replaySafe: true },
    });
  });
  assert.equal(events.length, 2);
  const first = await run((tx) => service.consume(tx, events[0]));
  assert.equal(first.status, "Applied");
  const partial = await run((transaction) =>
    store.lockByOrder({ ...scope, orderReference: creation.aggregate.orderReference, transaction }),
  );
  assert.equal(partial.aggregateVersion, 2n);
  assert.equal(partial.canonicalPhase, "Pending");
  assert.deepEqual(
    partial.items.map((item) => item.state),
    ["Ready", "Pending"],
  );
  const last = await run((tx) => service.consume(tx, events[1]));
  assert.equal(last.status, "Applied");
  const complete = await run((transaction) =>
    store.lockByOrder({ ...scope, orderReference: creation.aggregate.orderReference, transaction }),
  );
  assert.equal(complete.aggregateVersion, 3n);
  assert.equal(complete.canonicalPhase, "Ready");
  assert.equal(
    complete.items.every(
      (item) => item.state === "Ready" && item.readyQuantity === item.orderedQuantity,
    ),
    true,
  );
  const repeated = await run((tx) => service.consume(tx, events[0]));
  assert.equal(repeated.status, "AlreadyApplied");
  assert.deepEqual(repeated.effect, first.effect);
  const rows = (
    await client.query(
      "SELECT * FROM rms_fulfillment.fulfillment_ready_operation WHERE brand_id=$1 AND store_id=$2 AND fulfillment_id=$3 ORDER BY aggregate_version_after",
      [scope.brandReference, scope.storeReference, creation.aggregate.fulfillmentReference],
    )
  ).rows;
  assert.equal(rows.length, 2);
  const original = rows[0].ready_record_json;
  const changed = globalThis.structuredClone(original);
  changed.effect.operation.aggregateVersionAfter = "999";
  const wrongStore = globalThis.structuredClone(original);
  wrongStore.effect.operation.storeReference = id(399);
  for (const bad of [
    {},
    { ...original, recordVersion: 2 },
    { ...original, extra: true },
    changed,
    wrongStore,
  ]) {
    const row = { ...rows[0], ready_record_json: JSON.stringify(bad) },
      columns = Object.keys(row);
    await assert.rejects(
      client.query(
        "INSERT INTO rms_fulfillment.fulfillment_ready_operation (" +
          columns.join(",") +
          ") VALUES (" +
          columns.map((_, index) => "$" + (index + 1)).join(",") +
          ")",
        columns.map((key) => row[key]),
      ),
      { code: "23514", constraint: "fulfillment_ready_record_binding_check" },
    );
  }
  await assert.rejects(
    client.query(
      "UPDATE rms_fulfillment.fulfillment_ready_operation SET ready_record_json=NULL WHERE brand_id=$1 AND fulfillment_id=$2",
      [scope.brandReference, creation.aggregate.fulfillmentReference],
    ),
    /append-only/u,
  );
  await exercisePickupProofStore({ client, run, scope, creation, id, sha });
  currentAllowed = false;
  await assert.rejects(
    run((transaction) =>
      store.lockByOrder({
        ...scope,
        orderReference: creation.aggregate.orderReference,
        transaction,
      }),
    ),
  );
  const recovered = await run((transaction) => store.apply({ effect: first.effect, transaction }));
  assert.equal(recovered.status, "AlreadyApplied");
  assert.deepEqual(recovered.effect, first.effect);
  allowed = false;
  await assert.rejects(
    run((transaction) =>
      store.resolveByKitchenReadyResult({
        ...scope,
        kitchenReadyResultReference: first.effect.result.kitchenReadyResultReference,
        transaction,
      }),
    ),
  );
}
