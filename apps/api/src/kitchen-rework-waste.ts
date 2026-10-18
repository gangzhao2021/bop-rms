import type { ConsumerTransaction } from "@bop/eventing";
import { recordKitchenReworkWaste } from "@rms/inventory";
import { parseKitchenReworkCreatedEnvelope } from "@rms/kitchen";
import { createPostgresOrderItemInventoryLinkReader } from "@rms/ordering";

export class KitchenReworkWasteConsumptionError extends Error {
  readonly code = "KITCHEN_REWORK_WASTE_UNAVAILABLE" as const;
  constructor() {
    super("Kitchen rework waste is unavailable");
    this.name = "KitchenReworkWasteConsumptionError";
  }
}
const fail = (): never => {
  throw new KitchenReworkWasteConsumptionError();
};

interface OrderLineLink {
  readonly submissionReference: string;
  readonly cartItemReference: string;
  readonly quantity: number;
}

/**
 * WP-2423 Q26 composition (Handoff Section 26.6): Inventory consumes `KitchenReworkCreated`. When
 * the first dish was made and thrown away, the Order line's own recipe demand (its per-line
 * reservations) for the remade portions is recorded as Store waste, performed by the Kitchen
 * Actor named on the Event. A dish only marked done too early records nothing. Ordering resolves
 * the line through its public Query; Inventory owns every write. Runs in the consumer's
 * transaction; the consumer inbox and the event-keyed waste operation make a replay a no-op.
 */
export function createKitchenReworkWasteConsumption(options: {
  scope: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>;
  nextReference(): string;
  authorize(transaction: ConsumerTransaction, orderItemReference: string): Promise<boolean>;
  /** Test seam: defaults to Ordering's public Order item link Query. */
  links?: {
    load(transaction: ConsumerTransaction, orderItem: string): Promise<OrderLineLink | null>;
  };
}) {
  const links =
    options.links ??
    createPostgresOrderItemInventoryLinkReader({
      brandReference: options.scope.brandReference,
      storeReference: options.scope.storeReference,
      authorize: options.authorize,
    });
  return async (transaction: ConsumerTransaction, value: unknown) => {
    const event = parseKitchenReworkCreatedEnvelope(value);
    if (
      event.tenantId !== options.scope.brandReference ||
      event.storeId !== options.scope.storeReference
    )
      return fail();
    if (!event.payload.wasteApplies) return Object.freeze({ status: "NoWaste" as const });
    const link = await links.load(transaction, event.payload.orderItemReference);
    if (link === null || event.payload.quantity > link.quantity) return fail();
    return recordKitchenReworkWaste(
      transaction as unknown as Parameters<typeof recordKitchenReworkWaste>[0],
      options.scope,
      {
        eventReference: event.eventId,
        reworkReference: event.payload.kitchenReworkItemReference,
        kitchenReasonCode: event.payload.reasonCode,
        submissionReference: link.submissionReference,
        cartItemReference: link.cartItemReference,
        lineQuantity: link.quantity,
        reworkQuantity: event.payload.quantity,
        actorReference: event.actor.actorId,
        occurredAt: event.payload.createdAt,
        nextReference: options.nextReference,
      },
    );
  };
}
