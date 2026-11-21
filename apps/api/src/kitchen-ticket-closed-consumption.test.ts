import { beforeEach, expect, it, vi } from "vitest";
import { createKitchenTicketClosedEnvelope } from "@rms/kitchen";
import { createKitchenTicketClosedConsumption } from "./kitchen-ticket-closed-consumption.js";

const doubles = vi.hoisted(() => ({ load: vi.fn(), apply: vi.fn() }));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<object>()),
  createPostgresOrderItemInventoryLinkReader: () => ({ load: doubles.load }),
}));
vi.mock("@rms/inventory", async (original) => ({
  ...(await original<object>()),
  createPostgresOrderLineConsumptionStore: () => ({ apply: doubles.apply }),
}));
const id = (n: number) => "01a0f026-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const event = (reasonCode: "ALREADY_SERVED" | "NOT_MADE_ABANDONED") =>
  createKitchenTicketClosedEnvelope({
    eventReference: id(10),
    closureReference: id(11),
    correlationReference: id(12),
    actorReference: id(13),
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    payload: {
      kitchenTicketReference: id(20),
      orderReference: id(21),
      orderBatchReference: id(22),
      reasonCode,
      foodMade: reasonCode === "ALREADY_SERVED",
      orderBusinessDate: "2026-10-09",
      ticketVersion: "4",
      openWorkItems: [
        {
          kitchenWorkItemReference: id(30),
          orderItemReference: id(31),
          status: "Queued",
          requiredQuantity: 2,
          completedQuantity: 0,
        },
      ],
      closedAt: "2026-10-14T12:00:00.000Z",
    },
  });
const consume = () =>
  createKitchenTicketClosedConsumption({
    scope,
    nextReference: () => id(99),
    authorize: async () => true,
    retentionPolicy: { code: "AUDIT_DEFAULT", version: 1 },
  });
const tx = { query: vi.fn() };
beforeEach(() => vi.resetAllMocks());

it("DEC-KITCHEN-STALE-TICKETS: an already served ticket's open dishes are consumed in full, as a completed dish would be", async () => {
  doubles.load.mockResolvedValue({
    submissionReference: id(40),
    cartItemReference: id(41),
    quantity: 2,
  });
  doubles.apply.mockResolvedValue([{ action: "Consume" }]);
  await expect(consume()(tx, event("ALREADY_SERVED"))).resolves.toEqual([{ action: "Consume" }]);
  expect(doubles.apply.mock.calls[0]?.[0]).toMatchObject({
    submissionReference: id(40),
    cartItemReference: id(41),
    kitchen: { kind: "Progress", completedQuantity: 2, requiredQuantity: 2 },
    actorReference: id(13),
    occurredAt: "2026-10-14T12:00:00.000Z",
  });
});

it("DEC-KITCHEN-STALE-TICKETS: food that was never made consumes nothing; a mismatched line fails closed", async () => {
  await expect(consume()(tx, event("NOT_MADE_ABANDONED"))).resolves.toEqual([]);
  expect(doubles.load).not.toHaveBeenCalled();
  doubles.load.mockResolvedValue({
    submissionReference: id(40),
    cartItemReference: id(41),
    quantity: 3,
  });
  await expect(consume()(tx, event("ALREADY_SERVED"))).rejects.toMatchObject({
    code: "KITCHEN_INVENTORY_CONSUMPTION_UNAVAILABLE",
  });
  expect(doubles.apply).not.toHaveBeenCalled();
});
