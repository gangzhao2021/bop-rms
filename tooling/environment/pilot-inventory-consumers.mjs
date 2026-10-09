import console from "node:console";
import { consumeEventInTransaction } from "../../packages/bop/eventing/src/index.ts";
import { parseKitchenWorkLifecycleEnvelope } from "../../packages/rms/kitchen/src/index.ts";
import { createKitchenInventoryConsumption } from "../../apps/api/dist/kitchen-inventory-consumption.js";
import { isPilotRuntime } from "./pilot-environment.mjs";

/** WP-2423: Inventory consumes Kitchen lifecycle Events per Order line (Section 30.6). */
export function createInternalInventoryConsumers(resources) {
  if (!isPilotRuntime()) throw new Error("INTERNAL_INVENTORY_ONLY");
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
          try {
            await consume(transaction, authorized(envelope));
          } catch (error) {
            // A code and source locations only (no message or business data).
            const code = error?.code ?? error?.name;
            console.error(
              JSON.stringify({
                event: "INTERNAL_INVENTORY_CONSUMPTION_FAILED",
                code: /^[A-Za-z0-9_]{1,80}$/.test(code ?? "") ? code : "UNAVAILABLE",
                frames:
                  String(error?.stack ?? "")
                    .match(
                      /(?:apps\/api\/dist|packages\/[a-z]+\/[a-z-]+\/src)\/[a-zA-Z0-9_./-]+:\d+:\d+/g,
                    )
                    ?.slice(0, 5) ?? [],
              }),
            );
            throw error;
          }
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
