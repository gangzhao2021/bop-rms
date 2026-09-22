import process from "node:process";
import { consumeEventInTransaction } from "../../packages/bop/eventing/src/index.ts";
import {
  parseKitchenWorkCreatedEnvelope,
  parseKitchenWorkLifecycleEnvelope,
  parseKitchenReadyEnvelope,
} from "../../packages/rms/kitchen/src/index.ts";
export function createInternalKitchenConsumers(resources, { createQueue }) {
  if (process.env.NODE_ENV !== "development") throw new Error("INTERNAL_KITCHEN_ONLY");
  const parsers = {
    KitchenWorkCreated: parseKitchenWorkCreatedEnvelope,
    KitchenWorkAccepted: parseKitchenWorkLifecycleEnvelope,
    KitchenWorkStarted: parseKitchenWorkLifecycleEnvelope,
    KitchenItemCompleted: parseKitchenWorkLifecycleEnvelope,
    KitchenItemProgressRecorded: parseKitchenWorkLifecycleEnvelope,
    KitchenItemReady: parseKitchenReadyEnvelope,
    KitchenOrderReady: parseKitchenReadyEnvelope,
  };
  return Object.entries(parsers).map(([eventType, parse]) => {
    const authorized = (value) => {
      const event = parse(value);
      if (
        event.eventType !== eventType ||
        event.tenantId !== resources.scope.brandReference ||
        event.storeId !== resources.scope.storeReference ||
        resources.now() >= resources.publicProfile.binding.validUntil
      )
        throw new Error("INTERNAL_KITCHEN_SCOPE_DENIED");
      return event;
    };
    const registration = Object.freeze({
      consumerName: "kitchen.internal-queue-" + eventType.toLowerCase() + ":v1",
      consumerVersion: 1,
      eventType,
      schemaVersions: [1],
      ownerModule: "@rms/kitchen",
      tenantScope: "store",
      ordering: "none",
      sideEffect: "refresh_kitchen_queue_from_owner_snapshot",
      replaySafe: true,
      handler: async ({ transaction, envelope }) => {
        authorized(envelope);
        await createQueue({
          ...resources,
          transactions: { run: (work) => work(transaction) },
        }).refresh();
        return { status: "completed" };
      },
    });
    return {
      registration,
      consume: (transaction, value) =>
        consumeEventInTransaction(transaction, registration, authorized(value)),
    };
  });
}
