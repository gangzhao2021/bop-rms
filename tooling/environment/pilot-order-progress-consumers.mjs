import {
  createOrderKitchenProgressConsumerService,
  createOrderPickupNotCollectedConsumerService,
  createPostgresOrderKitchenProgressFactStore,
  createPostgresOrderPickupNotCollectedFactStore,
} from "../../packages/rms/ordering/src/index.ts";
import { isPilotRuntime } from "./pilot-environment.mjs";

/**
 * WP-2423 / DEC-PILOT-BATCH-PHASE-01: Ordering consumes the Kitchen preparation events
 * (started, dish ready, ticket ready, stale ticket closed) into its own inbox record so the Order
 * phase shows Accepted / In Progress / Ready, and Fulfillment's PickupNotCollected so a pickup
 * closed as not collected ends the Order phase. One registration per event type.
 */
export function createInternalOrderProgressConsumers(resources) {
  if (!isPilotRuntime()) throw new Error("INTERNAL_ORDER_PROGRESS_ONLY");
  const scope = resources.scope;
  const authorize = async (_transaction, event) =>
    resources.now() < resources.publicProfile.binding.validUntil &&
    event.brandReference === scope.brandReference &&
    event.storeReference === scope.storeReference;
  const service = createOrderKitchenProgressConsumerService({
    authorization: { authorize },
    facts: createPostgresOrderKitchenProgressFactStore(scope),
  });
  const notCollected = createOrderPickupNotCollectedConsumerService({
    authorization: { authorize },
    facts: createPostgresOrderPickupNotCollectedFactStore(scope),
  });
  return [
    ...service.registrations.map((registration) => ({
      registration,
      consume: (transaction, event) => service.consume(transaction, event),
    })),
    {
      registration: notCollected.registration,
      consume: (transaction, event) => notCollected.consume(transaction, event),
    },
  ];
}
