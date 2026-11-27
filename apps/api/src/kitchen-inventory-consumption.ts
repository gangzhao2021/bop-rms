import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrderLineConsumptionStore } from "@rms/inventory";
import { parseKitchenWorkLifecycleEnvelope } from "@rms/kitchen";
import { createPostgresOrderItemInventoryLinkReader } from "@rms/ordering";

export class KitchenInventoryConsumptionError extends Error {
  readonly code = "KITCHEN_INVENTORY_CONSUMPTION_UNAVAILABLE" as const;
  constructor() {
    super("Kitchen inventory consumption is unavailable");
    this.name = "KitchenInventoryConsumptionError";
  }
}
const fail = (): never => {
  throw new KitchenInventoryConsumptionError();
};

/**
 * WP-2423 / Section 30.6 composition: Inventory consumes Kitchen lifecycle Events. Start locks the
 * Order line's reservations; recorded progress and completion consume the completed share.
 * Ordering resolves the line through its public Query; Inventory owns every write. The Kitchen
 * Actor named on the Event is the audited performer. Runs inside the consumer's transaction.
 */
export function createKitchenInventoryConsumption(options: {
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
    const event = parseKitchenWorkLifecycleEnvelope(value);
    if (
      event.tenantId !== options.scope.brandReference ||
      event.storeId !== options.scope.storeReference
    )
      return fail();
    if (event.eventType === "KitchenWorkAccepted") return Object.freeze([]);
    const payload: Readonly<Record<string, unknown>> = event.payload;
    const text = (key: string) => {
      const field = payload[key];
      return typeof field === "string" ? field : fail();
    };
    const count = (key: string) => {
      const field = payload[key];
      return Number.isSafeInteger(field) ? Number(field) : fail();
    };
    const link = await links.load(transaction, text("orderItemReference"));
    if (link === null) return fail();
    const kitchen =
      event.eventType === "KitchenWorkStarted"
        ? ({ kind: "Start" } as const)
        : ({
            kind: "Progress",
            completedQuantity: count("completedQuantity"),
            requiredQuantity: count("requiredQuantity"),
          } as const);
    // Kitchen keeps one work item per Order item today (split ordinal 1). A split item would need
    // progress summed across its work items, so a mismatch fails closed instead of misdeducting.
    if (kitchen.kind === "Progress" && kitchen.requiredQuantity !== link.quantity) return fail();
    const occurredAt = text(
      event.eventType === "KitchenWorkStarted"
        ? "startedAt"
        : event.eventType === "KitchenItemCompleted"
          ? "completedAt"
          : "recordedAt",
    );
    return createPostgresOrderLineConsumptionStore(
      { run: async (work) => work(transaction) },
      options.scope,
      { nextReference: options.nextReference },
    ).apply({
      submissionReference: link.submissionReference,
      cartItemReference: link.cartItemReference,
      kitchen,
      occurredAt,
      actorReference: event.actor.actorId,
      correlationReference: event.correlationId,
      audit: {
        reasonCode:
          event.eventType === "KitchenWorkStarted" ? "KITCHEN_WORK_STARTED" : "KITCHEN_PROGRESS",
        sourceChannel: "KDS_COMMAND",
        retentionPolicyCode: options.retentionPolicy.code,
        retentionPolicyVersion: options.retentionPolicy.version,
      },
    });
  };
}
