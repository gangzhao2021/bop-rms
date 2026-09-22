import { exerciseFulfillmentReadyStore } from "./fulfillment-ready-store.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import {
  createPickupFulfillmentService,
  createPostgresPickupFulfillmentStore,
} from "../../rms/fulfillment/src/index.ts";
import {
  createOrderFulfillmentSourceLineBinding,
  createOrderFulfillmentSourceEvidenceBinding,
  parseConfirmedOrderFulfillmentSourceEvidence,
  parseOrderConfirmedEnvelope,
} from "../../rms/ordering/src/index.ts";

/** Actual owner service/store/Audit/Inbox; Ordering source and current authority are synthetic. */
export async function exercisePickupFulfillmentStore(client) {
  const id = (n) => "0198acfa-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const sha = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const at = "2026-08-11T18:00:00.000Z";
  let allowed = true,
    eligible = true,
    failAt = null,
    reached;
  const scope = { brandReference: id(1), storeReference: id(2) };
  const event = parseOrderConfirmedEnvelope({
    eventId: id(6),
    eventType: "OrderConfirmed",
    schemaVersion: 1,
    occurredAt: at,
    producerModule: "@rms/ordering",
    tenantId: id(1),
    storeId: id(2),
    aggregateType: "Order",
    aggregateId: id(3),
    aggregateVersion: 2n,
    correlationId: id(7),
    causationId: id(8),
    actor: { type: "System" },
    payload: {
      confirmationReference: id(5),
      orderReference: id(3),
      orderBatchReference: id(4),
      sourceSnapshotDigest: sha("order"),
      confirmedAt: at,
    },
    redactionClassification: "indirect_identifier",
    replayMetadata: { replaySafe: true },
  });
  const line = {
    orderItemReference: id(10),
    ordinal: 1,
    quantity: 2,
    lineDigest: sha("placeholder"),
  };
  line.lineDigest = sha(createOrderFulfillmentSourceLineBinding(line));
  const secondLine = {
    orderItemReference: id(11),
    ordinal: 2,
    quantity: 1,
    lineDigest: sha("placeholder"),
  };
  secondLine.lineDigest = sha(createOrderFulfillmentSourceLineBinding(secondLine));
  const raw = {
    evidenceReference: id(20),
    ...scope,
    orderReference: id(3),
    orderBatchReference: id(4),
    confirmationReference: id(5),
    sourceEventReference: id(6),
    sourceAggregateVersion: 2n,
    sourceSnapshotDigest: sha("order"),
    orderType: "Pickup",
    capturedAt: at,
    evidenceVersion: 1,
    items: [line, secondLine],
    evidenceDigest: sha("placeholder"),
  };
  raw.evidenceDigest = sha(createOrderFulfillmentSourceEvidenceBinding(raw));
  const source = parseConfirmedOrderFulfillmentSourceEvidence(raw);
  const repository = createPostgresPickupFulfillmentStore({
    ...scope,
    sha256: sha,
    authorize: async () => allowed,
    validateCurrentSource: async () => eligible,
  });
  const service = createPickupFulfillmentService({
    authorization: { authorize: async () => allowed },
    orderingSource: { resolve: async () => source },
    references: {
      derive: (purpose, identity) => {
        const digest = createHash("sha256")
          .update(purpose + identity)
          .digest("hex");
        return (
          "0198afac-" +
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
    digests: { sha256: sha },
    repository,
    audit: {
      append: ({ record, transaction }) => appendAuditRecordInTransaction(transaction, record),
    },
  });
  async function run(work) {
    await client.query("BEGIN");
    try {
      await client.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [id(1), id(2)],
      );
      const result = await work({
        query: async (sql, values) => {
          if (failAt && sql.startsWith(failAt)) {
            reached = true;
            throw new Error("synthetic fulfillment failure");
          }
          return client.query(sql, values);
        },
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  const counts = async () =>
    (
      await client.query(
        "SELECT (SELECT count(*)::int FROM rms_fulfillment.fulfillment WHERE brand_id=$1) AS roots," +
          "(SELECT count(*)::int FROM rms_fulfillment.fulfillment_creation_operation WHERE brand_id=$1) AS operations," +
          "(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1) AS audits," +
          "(SELECT count(*)::int FROM platform_eventing.consumer_inbox WHERE brand_id=$1) AS inbox",
        [id(1)],
      )
    ).rows[0];
  const initial = await counts();
  for (const point of [
    "INSERT INTO rms_fulfillment.fulfillment_item",
    "INSERT INTO rms_fulfillment.fulfillment_creation_operation",
    "INSERT INTO platform_audit.audit_record",
    "UPDATE platform_eventing.consumer_inbox",
  ]) {
    failAt = point;
    reached = false;
    await assert.rejects(run((tx) => service.consume(tx, event)));
    assert.equal(reached, true);
    assert.deepEqual(await counts(), initial);
  }
  failAt = null;
  const result = await run((tx) => service.consume(tx, event));
  assert.equal(result.status, "Created");
  const replay = await run((tx) => service.consume(tx, event));
  assert.equal(replay.status, "AlreadyCreated");
  assert.deepEqual(replay.effect, result.effect);
  await exerciseFulfillmentReadyStore({ client, run, scope, creation: result.effect, id, sha });
  eligible = false;
  const restored = await run((transaction) =>
    repository.resolveByOrder({ ...scope, orderReference: id(3), transaction }),
  );
  assert.deepEqual(restored.effect, result.effect);
  const stored = (
    await client.query(
      "SELECT creation_record_json FROM rms_fulfillment.fulfillment_creation_operation WHERE brand_id=$1 AND order_id=$2",
      [id(1), id(3)],
    )
  ).rows[0].creation_record_json;
  assert.equal(stored.effect.aggregate.sourceAggregateVersion, "2");
  const persisted = (
    await client.query(
      "SELECT * FROM rms_fulfillment.fulfillment_creation_operation WHERE brand_id=$1 AND order_id=$2",
      [id(1), id(3)],
    )
  ).rows[0];
  const changedIdentity = globalThis.structuredClone(stored);
  changedIdentity.effect.operation.operationReference = id(999);
  const changedSource = globalThis.structuredClone(stored);
  changedSource.effect.aggregate.sourceEvidenceDigest = sha("changed");
  for (const bad of [
    { ...stored, recordVersion: 2 },
    { ...stored, extra: true },
    changedIdentity,
    changedSource,
  ]) {
    const row = { ...persisted, creation_record_json: JSON.stringify(bad) };
    const columns = Object.keys(row);
    await assert.rejects(
      client.query(
        "INSERT INTO rms_fulfillment.fulfillment_creation_operation (" +
          columns.join(",") +
          ") VALUES (" +
          columns.map((_, index) => "$" + (index + 1)).join(",") +
          ")",
        columns.map((key) => row[key]),
      ),
      { code: "23514", constraint: "fulfillment_creation_record_binding_check" },
    );
  }

  await assert.rejects(
    client.query(
      "UPDATE rms_fulfillment.fulfillment_creation_operation SET creation_record_json=NULL WHERE brand_id=$1",
      [id(1)],
    ),
    /append-only/u,
  );
  allowed = false;
  await assert.rejects(
    run((transaction) =>
      repository.resolveByOrder({ ...scope, orderReference: id(3), transaction }),
    ),
  );
}
