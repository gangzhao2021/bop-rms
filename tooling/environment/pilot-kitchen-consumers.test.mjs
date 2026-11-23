import { afterEach, expect, it, vi } from "vitest";
import { createKitchenWorkCancelledEnvelope } from "../../packages/rms/kitchen/src/index.ts";
import { createInternalKitchenConsumers, kitchenQueueChange } from "./pilot-kitchen-consumers.mjs";

const id = (n) => `0198b000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = { brandReference: id(1), storeReference: id(2) };
const cancelled = (brandReference = scope.brandReference) =>
  createKitchenWorkCancelledEnvelope({
    eventReference: id(10),
    operationReference: id(11),
    actorReference: id(12),
    brandReference,
    storeReference: scope.storeReference,
    payload: {
      kitchenTicketReference: id(3),
      orderReference: id(4),
      orderBatchReference: id(5),
      orderCancellationReference: id(6),
      ticketVersion: "3",
      reasonCode: "ORDER_CANCELLED_BEFORE_PREPARATION",
      workItems: [
        {
          kitchenWorkItemReference: id(7),
          orderItemReference: id(8),
          fromStatus: "Queued",
          toStatus: "Cancelled",
          workItemVersion: "3",
        },
      ],
      cancelledAt: "2026-10-11T12:00:00.000Z",
    },
  });

afterEach(() => vi.unstubAllEnvs());

it("refreshes the owner queue snapshot when staff cancel a batch before the kitchen starts", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const refresh = vi.fn(async () => 1);
  const createQueue = vi.fn(() => ({ refresh }));
  const resources = {
    scope,
    now: () => "2026-10-11T12:00:01.000Z",
    publicProfile: { binding: { validUntil: "2026-10-12T00:00:00.000Z" } },
  };
  const consumers = createInternalKitchenConsumers(resources, { createQueue });
  const consumer = consumers.find(
    (candidate) => candidate.registration.eventType === "KitchenWorkCancelled",
  );
  expect(consumer?.registration).toMatchObject({
    consumerName: "kitchen.internal-queue-kitchenworkcancelled:v1",
    sideEffect: "refresh_kitchen_queue_from_owner_snapshot",
    schemaVersions: [1],
  });
  const transaction = { query: vi.fn() };
  await expect(
    consumer.registration.handler({ transaction, envelope: cancelled() }),
  ).resolves.toEqual({ status: "completed" });
  expect(refresh).toHaveBeenCalledTimes(1);
  // A cancellation may not move the ticket version the board compares, so it rebuilds in full.
  expect(refresh.mock.calls[0]).toEqual([undefined]);
  await expect(
    consumer.registration.handler({ transaction, envelope: cancelled(id(99)) }),
  ).rejects.toThrow("INTERNAL_KITCHEN_SCOPE_DENIED");
  expect(refresh).toHaveBeenCalledTimes(1);
});

/**
 * WP-2423 batch 52 (v15 2026-11-23): the five events of one Finished tap, as the outbox held them
 * for order 65 at Test Merchant 2: four on the KitchenTicket (versions 2, 3, 4 and 4) and the item
 * ready result. Each names the ticket change the board already shows after the first refresh.
 */
it("names the ticket change of each kitchen event so a board that shows it is not rebuilt", () => {
  const ticket = id(3);
  const onTicket = (eventType, version) => ({
    eventType,
    aggregateType: "KitchenTicket",
    aggregateId: ticket,
    aggregateVersion: version,
    payload: { kitchenTicketReference: ticket },
  });
  expect(
    [
      onTicket("KitchenWorkAccepted", 2n),
      onTicket("KitchenWorkStarted", 3n),
      onTicket("KitchenItemCompleted", 4n),
      onTicket("KitchenOrderReady", 4n),
      onTicket("KitchenItemProgressRecorded", 5n),
    ].map(kitchenQueueChange),
  ).toEqual(
    [2n, 3n, 4n, 4n, 5n].map((ticketVersion) => ({ ticketReference: ticket, ticketVersion })),
  );
  expect(
    kitchenQueueChange({
      eventType: "KitchenItemReady",
      aggregateType: "KitchenOrderItemReadyResult",
      aggregateId: id(9),
      aggregateVersion: 1n,
      payload: { kitchenTicketReference: ticket, readyResultReference: id(9) },
    }),
  ).toEqual({ ticketReference: ticket, readyResultReference: id(9) });
  // A new, cancelled or closed ticket always rebuilds.
  for (const eventType of ["KitchenWorkCreated", "KitchenWorkCancelled", "KitchenTicketClosed"])
    expect(kitchenQueueChange(onTicket(eventType, 1n))).toBeUndefined();
});
