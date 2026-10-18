import { expect, it, vi } from "vitest";
import { createKitchenReworkCreatedEnvelope } from "@rms/kitchen";
import { createKitchenReworkWasteConsumption } from "./kitchen-rework-waste.js";

const id = (n: number) => "01a0f026-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const event = (reasonCode: "DROPPED" | "NOT_READY", storeReference = scope.storeReference) =>
  createKitchenReworkCreatedEnvelope({
    eventReference: id(10),
    operationReference: id(11),
    correlationReference: id(12),
    actorReference: id(13),
    brandReference: scope.brandReference,
    storeReference,
    payload: {
      kitchenReworkItemReference: id(14),
      kitchenTicketReference: id(15),
      originalKitchenWorkItemReference: id(16),
      orderReference: id(17),
      orderBatchReference: id(18),
      orderItemReference: id(19),
      reasonCode,
      quantity: 1,
      wasteApplies: reasonCode !== "NOT_READY",
      createdAt: "2026-10-14T12:00:00.000Z",
    },
  });

it("WP-2423 Q26: a dish marked done too early records no waste and reads no Order line", async () => {
  const links = { load: vi.fn() };
  const consume = createKitchenReworkWasteConsumption({
    scope,
    nextReference: () => id(99),
    authorize: async () => true,
    links,
  });
  const tx = { query: vi.fn() };
  await expect(consume(tx, event("NOT_READY"))).resolves.toEqual({ status: "NoWaste" });
  expect(links.load).not.toHaveBeenCalled();
  expect(tx.query).not.toHaveBeenCalled();
});

it("WP-2423 Q26: refuses another Store's event or an unknown Order line", async () => {
  const links = { load: vi.fn(async () => null) };
  const consume = createKitchenReworkWasteConsumption({
    scope,
    nextReference: () => id(99),
    authorize: async () => true,
    links,
  });
  const tx = { query: vi.fn() };
  await expect(consume(tx, event("DROPPED", id(4)))).rejects.toMatchObject({
    code: "KITCHEN_REWORK_WASTE_UNAVAILABLE",
  });
  await expect(consume(tx, event("DROPPED"))).rejects.toMatchObject({
    code: "KITCHEN_REWORK_WASTE_UNAVAILABLE",
  });
  expect(links.load).toHaveBeenCalledWith(tx, id(19));
});
