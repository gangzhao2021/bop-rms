import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrderLineConsumptionStore } from "@rms/inventory";
import { parseKitchenTicketClosedEnvelope } from "@rms/kitchen";
import { createPostgresOrderItemInventoryLinkReader } from "@rms/ordering";
import { KitchenInventoryConsumptionError } from "./kitchen-inventory-consumption.js";

const fail = (): never => {
  throw new KitchenInventoryConsumptionError();
};

/**
 * WP-2423 DEC-KITCHEN-STALE-TICKETS composition (Section 30.6): Inventory consumes
 * `KitchenTicketClosed`. When the manager says the food was made and handed over (`foodMade`), each
 * open work item's Order line is consumed in full, exactly as a completed dish would be; when it was
 * not made, nothing is consumed and the reservation stays with the Order until Ordering cancels it.
 * Replay-safe: the effect is derived from current reservation state. The closing manager is the
 * audited performer. Runs inside the consumer's transaction.
 */
export function createKitchenTicketClosedConsumption(options: {
  scope: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>;
  nextReference(): string;
  authorize(transaction: ConsumerTransaction, orderItemReference: string): Promise<boolean>;
  retentionPolicy: Readonly<{ code: string; version: number }>;
}) {
  const links = createPostgresOrderItemInventoryLinkReader({
    brandReference: options.scope.brandReference,
    storeReference: options.scope.storeReference,
    authorize: options.authorize,
  });
  return async (transaction: ConsumerTransaction, value: unknown) => {
    const event = parseKitchenTicketClosedEnvelope(value);
    if (
      event.tenantId !== options.scope.brandReference ||
      event.storeId !== options.scope.storeReference
    )
      return fail();
    if (!event.payload.foodMade) return Object.freeze([]);
    const applied = [];
    for (const item of event.payload.openWorkItems) {
      const link = await links.load(transaction, item.orderItemReference);
      if (link === null) return fail();
      // One work item per Order item today (split ordinal 1); a split item fails closed.
      if (item.requiredQuantity !== link.quantity) return fail();
      applied.push(
        ...(await createPostgresOrderLineConsumptionStore(
          { run: async (work) => work(transaction) },
          options.scope,
          { nextReference: options.nextReference },
        ).apply({
          submissionReference: link.submissionReference,
          cartItemReference: link.cartItemReference,
          kitchen: {
            kind: "Progress",
            completedQuantity: item.requiredQuantity,
            requiredQuantity: item.requiredQuantity,
          },
          occurredAt: event.payload.closedAt,
          actorReference: event.actor.actorId,
          correlationReference: event.correlationId,
          audit: {
            reasonCode: "KITCHEN_STALE_TICKET_SERVED",
            sourceChannel: "MERCHANT_WEB",
            retentionPolicyCode: options.retentionPolicy.code,
            retentionPolicyVersion: options.retentionPolicy.version,
          },
        })),
      );
    }
    return Object.freeze(applied);
  };
}
