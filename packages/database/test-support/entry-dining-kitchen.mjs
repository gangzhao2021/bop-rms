import assert from "node:assert/strict";
import { createOrderPaidContextSource } from "../../../apps/api/src/order-paid-context-source.ts";
import { exerciseCapturedOrderKitchen } from "./captured-order-kitchen.mjs";

/** Same actual Entry Order/Payment event; merchant and internal worker policies remain synthetic fixtures. */
export async function exerciseEntryDiningKitchen({
  admin,
  role,
  run,
  scope,
  order,
  result,
  now,
  orderType = "DineIn",
  onPickupReady,
}) {
  await admin.query(
    "GRANT SELECT ON rms_ordering.order_acceptance_record,rms_ordering.order_termination_record,rms_ordering.order_fulfillment_completion_record TO " +
      role,
  );
  await admin.query("GRANT SELECT ON rms_ordering.additional_dining_batch_record TO " + role);
  const event = result.committed.fact.event;
  const context = createOrderPaidContextSource({
    scope: result.terminalScope,
    tenantReference: scope.tenantReference,
    quoteVersion: 1,
    now,
    authorize: async (_tx, candidate) =>
      candidate.eventId === event.eventId &&
      candidate.payload.orderReference === order.record.order.orderReference,
    authorizeInventory: async (_tx, input) =>
      input.submissionReference === order.record.submissionReference &&
      input.actorReference === order.record.guestSessionReference,
    authorizeOrder: async (_tx, input) =>
      input.orderReference === order.record.order.orderReference &&
      input.orderBatchReference === order.record.order.batches[0].orderBatchReference,
  });
  const diagnostics = [];
  const runner = {
    run: (work) =>
      run((tx) =>
        work({
          query: async (sql, values) => {
            const table =
              /(?:FROM|INTO|UPDATE|TABLE)\s+([a-z_]+\.[a-z_]+)/i.exec(sql)?.[1] ?? "owner-query";
            try {
              const result = await tx.query(sql, values);
              diagnostics.push({ table, rows: result.rows.length });
              return result;
            } catch (error) {
              diagnostics.push({
                table,
                code: /^[0-9A-Z]{5}$/.test(error.code ?? "") ? error.code : "unknown",
              });
              throw error;
            }
          },
        }),
      ),
  };
  const current = await runner.run((tx) => context.resolve(tx, event));
  assert.equal(current.order.order.orderReference, order.record.order.orderReference);
  assert.equal(current.order.order.orderType, orderType);
  assert.equal(current.order.items.length, orderType === "Pickup" ? 1 : 2);
  assert.deepEqual(current.order.items, order.record.items);
  assert.equal(current.acceptance, null);
  assert.equal(current.initialExecution.phase, "Submitted");
  assert.equal(current.inventory.record.submissionReference, order.record.submissionReference);
  assert.equal(current.terminal.event.eventId, event.eventId);
  try {
    await exerciseCapturedOrderKitchen({
      kitchenNow: () => new Date().toISOString(),
      reuseInventoryRecipe: true,
      onPickupReady,
      admin,
      runner,
      role,
      scope,
      order: order.record,
      quoteVersion: 1,
      paymentWorkflow: order.workflow.payment,
      context,
      paymentScope: result.terminalScope,
      event,
    });
  } catch (error) {
    assert.fail(
      JSON.stringify({
        queries: diagnostics.slice(-25),
        code: /^[A-Z0-9_]{1,64}$/.test(error?.code) ? error.code : "UNKNOWN",
        frames: String(error?.stack ?? "")
          .split("\n")
          .slice(1, 7)
          .map((line) => /([a-z0-9-]+\.[cm]?ts:[0-9]+:[0-9]+)/i.exec(line)?.[1] ?? "source"),
      }),
    );
  }
  return { context, event };
}
