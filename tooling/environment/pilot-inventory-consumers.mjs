import console from "node:console";
import { consumeEventInTransaction } from "../../packages/bop/eventing/src/index.ts";
import {
  parseKitchenReworkCreatedEnvelope,
  parseKitchenTicketClosedEnvelope,
  parseKitchenWorkLifecycleEnvelope,
} from "../../packages/rms/kitchen/src/index.ts";
import { createKitchenInventoryConsumption } from "../../apps/api/dist/kitchen-inventory-consumption.js";
import { createKitchenReworkWasteConsumption } from "../../apps/api/dist/kitchen-rework-waste.js";
import { createKitchenTicketClosedConsumption } from "../../apps/api/dist/kitchen-ticket-closed-consumption.js";
import { isPilotRuntime } from "./pilot-environment.mjs";

const failureLog = (event, error) => {
  // A code and source locations only (no message or business data).
  const code = error?.code ?? error?.name;
  console.error(
    JSON.stringify({
      event,
      code: /^[A-Za-z0-9_]{1,80}$/.test(code ?? "") ? code : "UNAVAILABLE",
      frames:
        String(error?.stack ?? "")
          .match(/(?:apps\/api\/dist|packages\/[a-z]+\/[a-z-]+\/src)\/[a-zA-Z0-9_./-]+:\d+:\d+/g)
          ?.slice(0, 5) ?? [],
    }),
  );
};

/**
 * WP-2423 Q26 (Handoff Section 26.6): Inventory records the first dish of a Kitchen remake as
 * Store waste, once per KitchenReworkCreated Event.
 */
function createReworkWasteConsumer(resources) {
  const consume = createKitchenReworkWasteConsumption({
    scope: {
      tenantReference: resources.publicProfile.binding.tenantReference,
      brandReference: resources.scope.brandReference,
      storeReference: resources.scope.storeReference,
    },
    nextReference: () => resources.credentials.reference(),
    authorize: async () => resources.now() < resources.publicProfile.binding.validUntil,
  });
  const authorized = (value) => {
    const event = parseKitchenReworkCreatedEnvelope(value);
    if (
      event.tenantId !== resources.scope.brandReference ||
      event.storeId !== resources.scope.storeReference
    )
      throw new Error("INTERNAL_INVENTORY_SCOPE_DENIED");
    return event;
  };
  const registration = Object.freeze({
    consumerName: "inventory.kitchen-rework-waste:v1",
    consumerVersion: 1,
    eventType: "KitchenReworkCreated",
    schemaVersions: [1],
    ownerModule: "@rms/inventory",
    tenantScope: "store",
    ordering: "none",
    sideEffect: "record_kitchen_rework_waste",
    replaySafe: true,
    handler: async ({ transaction, envelope }) => {
      try {
        await consume(transaction, authorized(envelope));
      } catch (error) {
        failureLog("INTERNAL_KITCHEN_REWORK_WASTE_FAILED", error);
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
}

/**
 * DEC-KITCHEN-STALE-TICKETS: when a manager closes an earlier day's ticket as already served, the
 * open dishes' ingredients are recorded as used, once per KitchenTicketClosed Event.
 */
function createTicketClosedConsumer(resources) {
  const consume = createKitchenTicketClosedConsumption({
    scope: {
      tenantReference: resources.publicProfile.binding.tenantReference,
      brandReference: resources.scope.brandReference,
      storeReference: resources.scope.storeReference,
    },
    nextReference: () => resources.credentials.reference(),
    authorize: async () => resources.now() < resources.publicProfile.binding.validUntil,
    retentionPolicy: { code: "AUDIT_DEFAULT", version: 1 },
  });
  const authorized = (value) => {
    const event = parseKitchenTicketClosedEnvelope(value);
    if (
      event.tenantId !== resources.scope.brandReference ||
      event.storeId !== resources.scope.storeReference
    )
      throw new Error("INTERNAL_INVENTORY_SCOPE_DENIED");
    return event;
  };
  const registration = Object.freeze({
    consumerName: "inventory.kitchen-ticket-closed-consumption:v1",
    consumerVersion: 1,
    eventType: "KitchenTicketClosed",
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
        failureLog("INTERNAL_KITCHEN_TICKET_CLOSED_CONSUMPTION_FAILED", error);
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
}

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
  const lifecycle = [
    "KitchenWorkStarted",
    "KitchenItemProgressRecorded",
    "KitchenItemCompleted",
  ].map((eventType) => {
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
  });
  return [
    ...lifecycle,
    createReworkWasteConsumer(resources),
    createTicketClosedConsumer(resources),
  ];
}
