import { afterEach, expect, it, vi } from "vitest";
import { createInternalOrderProgressConsumers } from "./pilot-order-progress-consumers.mjs";
import { parseCatchUpArguments } from "./pilot-order-progress-catch-up.mjs";

const id = (n) => `0198b000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = { brandReference: id(1), storeReference: id(2) };
const resources = (validUntil = "2999-01-01T00:00:00.000Z") => ({
  scope,
  now: () => "2026-10-17T12:00:00.000Z",
  publicProfile: { binding: { validUntil } },
});
const started = (storeId = scope.storeReference) => ({
  eventId: id(10),
  eventType: "KitchenWorkStarted",
  schemaVersion: 1,
  occurredAt: "2026-10-17T11:59:00.000Z",
  producerModule: "@rms/kitchen",
  tenantId: scope.brandReference,
  storeId,
  aggregateType: "KitchenTicket",
  aggregateId: id(11),
  aggregateVersion: 3n,
  correlationId: id(12),
  actor: { type: "System" },
  payload: {
    kitchenTicketReference: id(11),
    kitchenWorkItemReference: id(13),
    orderItemReference: id(14),
    ticketVersion: "3",
    workItemVersion: "3",
    fromStatus: "Queued",
    toStatus: "In Progress",
    startedAt: "2026-10-17T11:59:00.000Z",
  },
  redactionClassification: "indirect_identifier",
  replayMetadata: { replaySafe: true },
});

const notCollected = (storeId = scope.storeReference) => ({
  eventId: id(20),
  eventType: "PickupNotCollected",
  schemaVersion: 1,
  occurredAt: "2026-10-17T11:59:00.000Z",
  producerModule: "@rms/fulfillment",
  tenantId: scope.brandReference,
  storeId,
  aggregateType: "Fulfillment",
  aggregateId: id(21),
  aggregateVersion: 4n,
  correlationId: id(22),
  causationId: id(24),
  actor: { type: "System" },
  payload: {
    fulfillmentReference: id(21),
    orderReference: id(23),
    notCollectedReference: id(24),
    storeReference: storeId,
    readyAt: "2026-10-17T10:00:00.000Z",
    closedAt: "2026-10-17T11:59:00.000Z",
  },
  redactionClassification: "indirect_identifier",
  replayMetadata: { replaySafe: true },
});

afterEach(() => vi.unstubAllEnvs());

it("registers Ordering's Kitchen progress consumer for each Kitchen event and refuses another Store or an expired binding", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const consumers = createInternalOrderProgressConsumers(resources());
  expect(consumers.map((c) => [c.registration.consumerName, c.registration.eventType])).toEqual([
    ["ordering.kitchen-progress:v1", "KitchenWorkStarted"],
    ["ordering.kitchen-progress:v1", "KitchenItemReady"],
    ["ordering.kitchen-progress:v1", "KitchenOrderReady"],
    ["ordering.kitchen-progress:v1", "KitchenTicketClosed"],
    ["ordering.pickup-not-collected:v1", "PickupNotCollected"],
  ]);
  const transaction = { query: vi.fn() };
  await expect(consumers[0].consume(transaction, started(id(99)))).rejects.toThrow();
  const expired = createInternalOrderProgressConsumers(resources("2026-10-17T00:00:00.000Z"));
  await expect(expired[0].consume(transaction, started())).rejects.toThrow(
    "ORDERING_KITCHEN_PROGRESS_DENIED",
  );
  await expect(expired[4].consume(transaction, notCollected())).rejects.toThrow(
    "ORDERING_PICKUP_NOT_COLLECTED_DENIED",
  );
  await expect(consumers[4].consume(transaction, notCollected(id(99)))).rejects.toThrow(
    "ORDERING_PICKUP_NOT_COLLECTED_DENIED",
  );
  expect(transaction.query).not.toHaveBeenCalled();
});

it("requires an explicit runtime directory and dry-run or apply", () => {
  expect(parseCatchUpArguments([".local/pilot-v15", "--dry-run"])).toEqual({
    directory: ".local/pilot-v15",
    dryRun: true,
  });
  expect(parseCatchUpArguments([".local/pilot-v15", "--apply"]).dryRun).toBe(false);
  for (const args of [
    [],
    [".local/pilot-v15"],
    ["/tmp/x", "--apply"],
    [".local/p", "--apply", "x"],
  ])
    expect(() => parseCatchUpArguments(args)).toThrow("ORDER_PROGRESS_CATCH_UP_ARGUMENTS");
});
