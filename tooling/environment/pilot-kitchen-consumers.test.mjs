import { afterEach, expect, it, vi } from "vitest";
import { createKitchenWorkCancelledEnvelope } from "../../packages/rms/kitchen/src/index.ts";
import { createInternalKitchenConsumers } from "./pilot-kitchen-consumers.mjs";

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
  await expect(
    consumer.registration.handler({ transaction, envelope: cancelled(id(99)) }),
  ).rejects.toThrow("INTERNAL_KITCHEN_SCOPE_DENIED");
  expect(refresh).toHaveBeenCalledTimes(1);
});
