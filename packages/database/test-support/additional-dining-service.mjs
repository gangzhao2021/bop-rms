import { createMerchantOrderQueueRead } from "../../../apps/api/src/merchant-order-queue-read.ts";
import { seedAdditionalDiningMerchant } from "./additional-dining-merchant.mjs";
import { exerciseAdditionalDiningStatusHttp } from "./additional-dining-status-http.mjs";
import assert from "node:assert/strict";
import { createDiningOrderDeliveryProgress } from "../../../apps/api/src/dining-order-delivery-progress.ts";
import { createPostgresDiningItemServiceReader } from "../../rms/dining/src/index.ts";
import { createMerchantDiningItemServiceComposition } from "../../../apps/api/src/merchant-dining-item-service-composition.ts";
import { encodeAdditionalDiningBatchSnapshot } from "../../rms/ordering/src/index.ts";

// Real migration/store/Audit, table/session and Ordering/Kitchen facts; merchant capability synthetic.
export async function exerciseAdditionalDiningService({
  combinedOrder = false,
  expectedOrderVersion = 3,
  client,
  runner,
  scope,
  snapshot,
  capacity,
  initial,
  guest,
  at,
  hash,
}) {
  const id = (n) => "01909987-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  if (combinedOrder) {
    const role = await runner().run(
      async (transaction) =>
        (await transaction.query("SELECT current_user AS role", [])).rows[0].role,
    );
    assert.match(role, /^[a-z][a-z0-9_]+$/);
    await client.query("GRANT SELECT,INSERT ON rms_dining.dining_item_service_record TO " + role);
  }
  const item = snapshot.items[0];
  assert.ok(item);
  const record = {
    serviceReference: id(1),
    operationReference: id(2),
    auditReference: id(3),
    ...scope,
    diningSessionReference: snapshot.diningSessionReference,
    tableReference: capacity.tableReference,
    sessionVersion: capacity.sessionVersion,
    tableAssignmentVersion: capacity.tableAssignmentVersion,
    orderReference: snapshot.orderReference,
    orderBatchReference: snapshot.batch.orderBatchReference,
    orderItemReference: item.orderItemReference,
    actorReference: id(4),
    expectedOrderVersion,
    expectedItemServiceVersion: 0,
    itemServiceVersion: 1,
    quantity: item.quantity,
    purposeCode: "ServeDiningOrderItem",
    permissionCode: "dining.item.serve",
    servedAt: at,
    recordedAt: at,
    sourceCheckpoint: snapshot.batch.submissionReference,
    sourceDigest: hash(encodeAdditionalDiningBatchSnapshot(snapshot)).slice(7),
  };
  const delivery = () =>
    runner().run((transaction) =>
      createDiningOrderDeliveryProgress({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        diningScope: scope,
        authorize: async () => true,
        authorizeKitchen: async () => true,
        authorizeDining: async () => true,
      }).load({
        transaction,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        orderReference: snapshot.orderReference,
        diningSessionReference: snapshot.diningSessionReference,
        guestSessionReference: snapshot.guestSessionReference,
        observedAt: at,
      }),
    );
  const checkQueue = async (expected) => {
    const queue = await createMerchantOrderQueueRead({
      transactions: runner(),
      authorize: async () => ({ ...scope, sessionReference: id(80) }),
      quoteVersion: snapshot.snapshotVersion,
      now: () => at,
    })({ sessionCookie: "synthetic-queue-session", afterOrderReference: null, limit: 50 });
    const entry = queue.items.find((entry) => entry.orderReference === snapshot.orderReference);
    assert.ok(entry);
    assert.equal(entry.currentPhase, expected.phase);
    assert.equal(entry.currentVersion, expected.orderVersion);
    assert.equal(entry.batches.length, 2);
  };
  const beforeService = await delivery();
  await checkQueue(beforeService);
  if (!combinedOrder) assert.equal(beforeService.phase, "InProgress");
  const beforeItem = beforeService.items.find(
    (entry) => entry.orderItemReference === item.orderItemReference,
  );
  assert.equal(beforeItem.phase, "Ready");
  assert.equal(beforeItem.orderedQuantity, item.quantity);
  assert.equal(beforeItem.deliveredQuantity, 0);
  const read = (changes = {}, authorize = async () => true) =>
    runner().run((transaction) =>
      createPostgresDiningItemServiceReader({ scope, authorize }).load({
        transaction,
        diningSessionReference: record.diningSessionReference,
        orderReference: record.orderReference,
        orderBatchReference: record.orderBatchReference,
        orderItemReference: record.orderItemReference,
        observedAt: at,
        ...changes,
      }),
    );
  const empty = await read();
  assert.equal(empty.servedQuantity, 0);
  assert.equal(empty.itemServiceVersion, 0);
  assert.equal(empty.lastServedAt, null);
  await assert.rejects(read({}, async () => false));
  const count = async () =>
    (
      await client.query(
        "SELECT (SELECT count(*)::int FROM rms_dining.dining_item_service_record) AS services,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='DINING_ITEM_SERVED') AS audits",
      )
    ).rows[0];
  const commit = (candidate, failAudit = false) =>
    runner().run(async (transaction) => {
      const store = createMerchantDiningItemServiceComposition({
        scope,
        now: () => at,
        authorize: async (_tx, fact) => fact.actorReference === id(4),
        validateSource: async (_tx, fact) =>
          fact.sourceCheckpoint === snapshot.batch.submissionReference &&
          fact.sourceDigest === hash(encodeAdditionalDiningBatchSnapshot(snapshot)).slice(7),
        audit: async (fact) => ({
          auditId: fact.auditReference,
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "User", reference: fact.actorReference },
          actionCode: "DINING_ITEM_SERVED",
          targetType: "OrderItem",
          targetId: fact.orderItemReference,
          correlationId: fact.operationReference,
          occurredAt: fact.recordedAt,
          afterSummary: { quantity: fact.quantity, version: fact.itemServiceVersion },
          reasonCode: "SYNTHETIC_TEST",
          sourceChannel: "MERCHANT_WEB",
          dataClassification: "Restricted",
          retentionPolicyCode: "FINANCIAL_COMPLIANCE",
          retentionPolicyVersion: 1,
        }),
      });
      let auditFailureReached = false;
      const tx = {
        query: (sql, values) => {
          if (failAudit && sql.startsWith("INSERT INTO platform_audit.audit_record")) {
            auditFailureReached = true;
            throw new Error("synthetic post-service insert Audit failure");
          }
          return transaction.query(sql, values);
        },
      };
      if (failAudit) {
        await assert.rejects(
          store.commit({
            transaction: tx,
            record: candidate,
            guestSessionReference: snapshot.guestSessionReference,
          }),
        );
        assert.equal(auditFailureReached, true);
        return null; // Commit outer transaction to prove savepoint rollback.
      }
      return store.commit({
        transaction: tx,
        record: candidate,
        guestSessionReference: snapshot.guestSessionReference,
      });
    });
  const baseline = await count();
  await assert.rejects(commit({ ...record, sessionVersion: record.sessionVersion + 1 }));
  await assert.rejects(
    commit({ ...record, tableAssignmentVersion: record.tableAssignmentVersion + 1 }),
  );
  await assert.rejects(commit({ ...record, tableReference: id(99) }));
  await assert.rejects(commit({ ...record, sourceDigest: "a".repeat(64) }));
  await assert.rejects(commit({ ...record, actorReference: id(98) }));
  await commit(record, true);
  assert.deepEqual(await count(), baseline);
  const merchant = await seedAdditionalDiningMerchant({
    client,
    runner,
    scope,
    record,
    snapshot,
    at,
    hash,
  });
  await merchant.denyCsrf();
  const results = await Promise.all([merchant.commit(record), merchant.commit(record)]);
  await merchant.revokePermission();
  assert.deepEqual(results.map((result) => result.status).sort(), ["AlreadyCommitted", "Created"]);
  assert.deepEqual(await count(), { services: baseline.services + 1, audits: baseline.audits + 1 });
  const afterService = await delivery();
  await checkQueue(afterService);
  if (!combinedOrder) assert.equal(afterService.phase, "InProgress");
  else {
    const otherItems = (state) =>
      state.items.filter(
        (entry) => entry.orderBatchReference !== snapshot.batch.orderBatchReference,
      );
    assert.deepEqual(otherItems(afterService), otherItems(beforeService));
  }
  const afterItem = afterService.items.find(
    (entry) => entry.orderItemReference === item.orderItemReference,
  );
  assert.equal(afterItem.phase, "Fulfilled");
  assert.equal(afterItem.deliveredQuantity, item.quantity);
  assert.equal(afterItem.remainingQuantity, 0);
  assert.equal(afterItem.itemServiceVersion, 1);
  if (!combinedOrder) assert.ok(afterService.items.some((entry) => entry.phase === "Submitted"));
  else assert.ok(afterService.items.every((entry) => entry.phase !== "Submitted"));
  const served = await read();
  assert.equal(served.servedQuantity, item.quantity);
  assert.equal(served.itemServiceVersion, 1);
  assert.equal(served.lastServedAt, at);
  assert.deepEqual(
    Object.keys(served).sort(),
    [
      "tenantReference",
      "brandReference",
      "storeReference",
      "diningSessionReference",
      "orderReference",
      "orderBatchReference",
      "orderItemReference",
      "observedAt",
      "servedQuantity",
      "itemServiceVersion",
      "lastServedAt",
    ].sort(),
  );
  await assert.rejects(read({ diningSessionReference: id(99) }));
  await assert.rejects(read({ orderBatchReference: id(99) }));
  await assert.rejects(read({ observedAt: new Date(Date.parse(at) - 1).toISOString() }));
  let authorizations = 0;
  await assert.rejects(read({}, async () => ++authorizations === 1));
  assert.equal(authorizations, 2);
  await assert.rejects(
    commit({
      ...record,
      serviceReference: id(5),
      operationReference: id(6),
      auditReference: id(7),
      expectedItemServiceVersion: 1,
      itemServiceVersion: 2,
      quantity: 1,
    }),
  );
  assert.deepEqual(await count(), { services: baseline.services + 1, audits: baseline.audits + 1 });
  await exerciseAdditionalDiningStatusHttp({
    combinedOrder,
    client,
    runner,
    scope,
    snapshot,
    initial,
    guest,
    capacity,
    at,
    hash,
  });
}
