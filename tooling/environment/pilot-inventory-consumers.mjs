import process from "node:process";
import { consumeEventInTransaction } from "../../packages/bop/eventing/src/index.ts";
import { parseKitchenWorkLifecycleEnvelope } from "../../packages/rms/kitchen/src/index.ts";
import { createKitchenInventoryConsumption } from "../../apps/api/dist/kitchen-inventory-consumption.js";

/** WP-2423: Inventory consumes Kitchen lifecycle Events per Order line (Section 30.6). */
export function createInternalInventoryConsumers(resources) {
  if (process.env.NODE_ENV !== "development") throw new Error("INTERNAL_INVENTORY_ONLY");
  const consume = createKitchenInventoryConsumption({
    scope: {
      tenantReference: resources.publicProfile.binding.tenantReference,
      brandReference: resources.scope.brandReference,
      storeReference: resources.scope.storeReference,
    },
    nextReference: () => resources.credentials.reference(),
    // The consumer is the owning Inventory process for this Store; scope is checked per Event.
    authorize: async () => resources.now() < resources.publicProfile.binding.validUntil,
    retentionPolicy: { code: "AUDIT_DEFAULT", version: 1 },
  });
  return ["KitchenWorkStarted", "KitchenItemProgressRecorded", "KitchenItemCompleted"].map(
    (eventType) => {
      const authorized = (value) => {
        const event = parseKitchenWorkLifecycleEnvelope(value);
        if (
          event.eventType !== eventType ||
          event.tenantId !== resources.scope.brandReference ||
          event.storeId !== resources.scope.storeReference
        )
          throw new Error("INTERNAL_INVENTORY_SCOPE_DENIED");
        return event;
      };
      const registration = Object.freeze({
        consumerName: "inventory.order-line-" + eventType.toLowerCase() + ":v1",
        consumerVersion: 1,
        eventType,
        schemaVersions: [1],
        ownerModule: "@rms/inventory",
        tenantScope: "store",
        ordering: "none",
        sideEffect: "record_order_line_inventory_consumption",
        replaySafe: true,
        handler: async ({ transaction, envelope }) => {
          await consume(transaction, authorized(envelope));
          return { status: "completed" };
        },
      });
      return {
        registration,
        consume: (transaction, value) =>
          consumeEventInTransaction(transaction, registration, authorized(value)),
      };
    },
  );
}
