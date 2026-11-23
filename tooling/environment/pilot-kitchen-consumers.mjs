import { consumeEventInTransaction } from "../../packages/bop/eventing/src/index.ts";
import {
  parseKitchenWorkCancelledEnvelope,
  parseKitchenWorkCreatedEnvelope,
  parseKitchenWorkLifecycleEnvelope,
  parseKitchenReadyEnvelope,
  parseKitchenTicketClosedEnvelope,
} from "../../packages/rms/kitchen/src/index.ts";
import { isPilotRuntime } from "./pilot-environment.mjs";
/** Kitchen ticket events whose aggregate version is the ticket version they produced. */
const ticketVersionEvents = new Set([
  "KitchenWorkAccepted",
  "KitchenWorkStarted",
  "KitchenItemProgressRecorded",
  "KitchenItemCompleted",
  "KitchenOrderReady",
]);
/**
 * WP-2423 batch 52 (kitchen ready speed): the ticket change an event refreshes the board for, so a
 * board that already shows it is not rebuilt again (see the Kitchen read model's refresh). A
 * created, cancelled or closed ticket always refreshes in full.
 */
export function kitchenQueueChange(event) {
  if (event.aggregateType === "KitchenTicket" && ticketVersionEvents.has(event.eventType))
    return { ticketReference: event.aggregateId, ticketVersion: event.aggregateVersion };
  if (event.eventType === "KitchenItemReady")
    return {
      ticketReference: event.payload.kitchenTicketReference,
      readyResultReference: event.payload.readyResultReference,
    };
  return undefined;
}
export function createInternalKitchenConsumers(resources, { createQueue }) {
  if (!isPilotRuntime()) throw new Error("INTERNAL_KITCHEN_ONLY");
  const parsers = {
    KitchenWorkCreated: parseKitchenWorkCreatedEnvelope,
    KitchenWorkAccepted: parseKitchenWorkLifecycleEnvelope,
    KitchenWorkStarted: parseKitchenWorkLifecycleEnvelope,
    KitchenItemCompleted: parseKitchenWorkLifecycleEnvelope,
    KitchenItemProgressRecorded: parseKitchenWorkLifecycleEnvelope,
    // WP-2423 Q6: staff cancelled a batch before the kitchen started it.
    KitchenWorkCancelled: parseKitchenWorkCancelledEnvelope,
    // DEC-KITCHEN-STALE-TICKETS: a manager closed an earlier business day's ticket.
    KitchenTicketClosed: parseKitchenTicketClosedEnvelope,
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
        const event = authorized(envelope);
        await createQueue({
          ...resources,
          transactions: { run: (work) => work(transaction) },
        }).refresh(kitchenQueueChange(event));
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
