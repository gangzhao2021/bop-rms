import type { ConsumerTransaction } from "@bop/eventing";
import {
  lockKitchenReworkWaste,
  recordKitchenReworkWaste,
  voidKitchenReworkWaste,
} from "@rms/inventory";
import {
  parseKitchenReworkCancelledEnvelope,
  parseKitchenReworkCreatedEnvelope,
  readKitchenReworkCancellation,
} from "@rms/kitchen";
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

interface Cancellations {
  read(
    transaction: ConsumerTransaction,
    reworkReference: string,
  ): Promise<{ readonly cancelReasonCode: string } | null>;
}

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
  /** Test seam: defaults to Kitchen's public remake cancellation Query. */
  cancellations?: Cancellations;
}) {
  const cancellations: Cancellations = options.cancellations ?? {
    read: (transaction, reworkReference) =>
      readKitchenReworkCancellation(transaction, options.scope, reworkReference),
  };
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
    // DEC-KITCHEN-REWORK cancel: a remake already cancelled as opened by mistake threw nothing
    // away (also after a dead-lettered first attempt is retried). Checked under the remake's waste
    // lock, which the cancel consumer also takes.
    await lockKitchenReworkWaste(
      transaction as unknown as Parameters<typeof lockKitchenReworkWaste>[0],
      event.payload.kitchenReworkItemReference,
    );
    const cancelled = await cancellations.read(
      transaction,
      event.payload.kitchenReworkItemReference,
    );
    if (cancelled?.cancelReasonCode === "OPENED_BY_MISTAKE")
      return Object.freeze({ status: "CancelledOpenedByMistake" as const });
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

/**
 * DEC-KITCHEN-REWORK cancel (2026-10-18) composition: Inventory consumes `KitchenReworkCancelled`.
 * A remake cancelled because it was opened by mistake threw nothing away, so the waste recorded
 * for it (keyed by its creation event) is voided by the staff member who cancelled it; a remake
 * the guest no longer wants keeps its waste (the first dish was still thrown away). A remake never
 * reserved or used stock of its own, so nothing else is released. Inventory owns every write; the
 * consumer inbox and the cancel-event-keyed review make a replay a no-op.
 */
export function createKitchenReworkCancelledWasteConsumption(options: {
  scope: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>;
  nextReference(): string;
}) {
  return async (transaction: ConsumerTransaction, value: unknown) => {
    const event = parseKitchenReworkCancelledEnvelope(value);
    if (
      event.tenantId !== options.scope.brandReference ||
      event.storeId !== options.scope.storeReference
    )
      return fail();
    if (!event.payload.wasteApplies || event.payload.cancelReasonCode !== "OPENED_BY_MISTAKE")
      return Object.freeze({ status: "WasteStands" as const });
    const tx = transaction as unknown as Parameters<typeof voidKitchenReworkWaste>[0];
    await lockKitchenReworkWaste(tx, event.payload.kitchenReworkItemReference);
    return voidKitchenReworkWaste(tx, options.scope, {
      createdEventReference: event.payload.createdEventReference,
      cancelEventReference: event.eventId,
      actorReference: event.actor.actorId,
      occurredAt: event.payload.cancelledAt,
      nextReference: options.nextReference,
    });
  };
}
