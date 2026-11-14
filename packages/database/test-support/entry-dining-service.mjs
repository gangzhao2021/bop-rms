import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDiningOrderDeliveryProgress } from "../../../apps/api/src/dining-order-delivery-progress.ts";
import { createMerchantDiningItemServiceComposition } from "../../../apps/api/src/merchant-dining-item-service-composition.ts";

/** Actual original Order/Kitchen/Dining/Audit; merchant capability remains an explicit synthetic fixture. */
export async function exerciseEntryDiningService({
  run,
  scope,
  order,
  commitment,
  reference,
  status,
}) {
  const now = () => new Date().toISOString();
  const guestSessionReference = order.record.guestSessionReference;
  const orderReference = order.record.order.orderReference;
  const capacity = commitment.record;
  const delivery = () =>
    run((transaction) =>
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
        orderReference,
        diningSessionReference: capacity.diningSessionReference,
        guestSessionReference,
        observedAt: now(),
      }),
    );
  const initial = await delivery();
  assert(initial);
  assert.equal(initial.phase, "Ready");
  assert(initial.items.every((item) => item.deliveredQuantity === 0));
  assert(status.status.sources.dining.items.every((item) => item.servedQuantity === 0));
  const actorReference = reference();
  const sourceDigest = createHash("sha256")
    .update(
      JSON.stringify({
        submission: order.record.submissionReference,
        items: order.record.items.map((item) => ({
          reference: item.orderItemReference,
          quantity: item.quantity,
        })),
      }),
    )
    .digest("hex");
  const writer = createMerchantDiningItemServiceComposition({
    scope,
    now,
    authorize: async (_tx, record) => record.actorReference === actorReference,
    validateSource: async (_tx, record, current) =>
      record.sourceCheckpoint === order.record.submissionReference &&
      record.sourceDigest === sourceDigest &&
      current.orderReference === orderReference,
    audit: async (record) => ({
      auditId: record.auditReference,
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "User", reference: actorReference },
      actionCode: "DINING_ITEM_SERVED",
      targetType: "OrderItem",
      targetId: record.orderItemReference,
      correlationId: record.operationReference,
      occurredAt: record.recordedAt,
      afterSummary: { quantity: record.quantity, version: record.itemServiceVersion },
      reasonCode: "SYNTHETIC_TEST",
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Restricted",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    }),
  });
  const served = new Map();
  for (const item of order.record.items) {
    const current = await delivery();
    const at = now();
    const record = {
      serviceReference: reference(),
      operationReference: reference(),
      auditReference: reference(),
      ...scope,
      diningSessionReference: capacity.diningSessionReference,
      tableReference: capacity.tableReference,
      sessionVersion: capacity.sessionVersion,
      tableAssignmentVersion: capacity.tableAssignmentVersion,
      orderReference,
      orderBatchReference: item.orderBatchReference,
      orderItemReference: item.orderItemReference,
      actorReference,
      expectedOrderVersion: current.orderVersion,
      expectedItemServiceVersion: 0,
      itemServiceVersion: 1,
      quantity: item.quantity,
      purposeCode: "ServeDiningOrderItem",
      permissionCode: "dining.item.serve",
      servedAt: at,
      recordedAt: at,
      sourceCheckpoint: order.record.submissionReference,
      sourceDigest,
    };
    const commit = (candidate) =>
      run((transaction) =>
        writer.commit({
          transaction,
          record: candidate,
          guestSessionReference,
        }),
      );
    assert.equal((await commit(record)).status, "Created");
    assert.equal((await commit(record)).status, "AlreadyCommitted");
    served.set(item.orderItemReference, item.quantity);
    const view = await status.read();
    for (const visible of view.sources.dining.items)
      assert.equal(visible.servedQuantity, served.get(visible.orderItemReference) ?? 0);
    await assert.rejects(
      commit({
        ...record,
        serviceReference: reference(),
        operationReference: reference(),
        auditReference: reference(),
        expectedItemServiceVersion: 1,
        itemServiceVersion: 2,
        quantity: 1,
      }),
    );
  }
  const complete = await delivery();
  assert.equal(complete.phase, "Fulfilled");
  assert(complete.items.every((item) => item.remainingQuantity === 0));
}

// Bound diagnostic for actual owner preparation/delivery; never emits SQL, values or raw errors.
export async function inspectEntryDiningDelivery({ run, scope, order, commitment }) {
  const failures = [];
  try {
    return await run((tx) =>
      createDiningOrderDeliveryProgress({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        diningScope: scope,
        authorize: async () => true,
        authorizeKitchen: async () => true,
        authorizeDining: async () => true,
      }).load({
        transaction: {
          query: async (sql, values) => {
            try {
              return await tx.query(sql, values);
            } catch (error) {
              failures.push({
                table: /(?:FROM|INTO|UPDATE|TABLE)\s+([a-z_]+\.[a-z_]+)/i.exec(sql)?.[1] ?? "owner",
                code: /^[0-9A-Z]{5}$/.test(error.code ?? "") ? error.code : "unknown",
              });
              throw error;
            }
          },
        },
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        orderReference: order.record.order.orderReference,
        diningSessionReference: commitment.record.diningSessionReference,
        guestSessionReference: order.record.guestSessionReference,
        observedAt: new Date().toISOString(),
      }),
    );
  } catch (error) {
    assert.fail(
      JSON.stringify({
        failures,
        frames: String(error.stack ?? "")
          .split("\n")
          .slice(1, 6)
          .map((line) => /([a-z0-9-]+\.[cm]?ts:[0-9]+:[0-9]+)/i.exec(line)?.[1] ?? "source"),
      }),
    );
  }
}
