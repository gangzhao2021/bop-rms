import { expect, it, vi } from "vitest";
import {
  createKitchenReworkCancelledEnvelope,
  createKitchenReworkCreatedEnvelope,
} from "@rms/kitchen";
import {
  createKitchenReworkCancelledWasteConsumption,
  createKitchenReworkWasteConsumption,
} from "./kitchen-rework-waste.js";

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

it("WP-2423 (2026-10-18): a remake already cancelled as opened by mistake records no waste, under the remake's waste lock", async () => {
  const links = {
    load: vi.fn(async () => ({
      submissionReference: id(30),
      cartItemReference: id(31),
      quantity: 2,
    })),
  };
  const cancellations = { read: vi.fn(async () => ({ cancelReasonCode: "OPENED_BY_MISTAKE" })) };
  const consume = createKitchenReworkWasteConsumption({
    scope,
    nextReference: () => id(99),
    authorize: async () => true,
    links,
    cancellations,
  });
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) };
  await expect(consume(tx, event("DROPPED"))).resolves.toEqual({
    status: "CancelledOpenedByMistake",
  });
  expect(cancellations.read).toHaveBeenCalledWith(tx, id(14));
  // Only the advisory lock ran: no waste was written.
  expect(tx.query).toHaveBeenCalledTimes(1);
  expect(String((tx.query.mock.calls[0] as unknown[] | undefined)?.[0])).toMatch(
    /pg_advisory_xact_lock/u,
  );
});

const cancelled = (
  cancelReasonCode: "GUEST_DECLINED" | "OPENED_BY_MISTAKE",
  storeReference = scope.storeReference,
) =>
  createKitchenReworkCancelledEnvelope({
    eventReference: id(40),
    operationReference: id(41),
    correlationReference: id(42),
    actorReference: id(43),
    brandReference: scope.brandReference,
    storeReference,
    version: 2,
    payload: {
      kitchenReworkItemReference: id(14),
      kitchenTicketReference: id(15),
      originalKitchenWorkItemReference: id(16),
      orderReference: id(17),
      orderBatchReference: id(18),
      orderItemReference: id(19),
      reasonCode: "DROPPED",
      cancelReasonCode,
      quantity: 1,
      wasteApplies: true,
      createdEventReference: id(10),
      cancelledAt: "2026-10-18T12:00:00.000Z",
    },
  });

it("WP-2423 (2026-10-18): a remake the guest no longer wants keeps its waste; another Store's event is refused", async () => {
  const consume = createKitchenReworkCancelledWasteConsumption({
    scope,
    nextReference: () => id(99),
  });
  const tx = { query: vi.fn() };
  await expect(consume(tx, cancelled("GUEST_DECLINED"))).resolves.toEqual({
    status: "WasteStands",
  });
  expect(tx.query).not.toHaveBeenCalled();
  await expect(consume(tx, cancelled("OPENED_BY_MISTAKE", id(4)))).rejects.toMatchObject({
    code: "KITCHEN_REWORK_WASTE_UNAVAILABLE",
  });
});

it("WP-2423 (2026-10-18): a remake opened by mistake with no waste recorded yet leaves nothing to void", async () => {
  const consume = createKitchenReworkCancelledWasteConsumption({
    scope,
    nextReference: () => id(99),
  });
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  await expect(consume(tx, cancelled("OPENED_BY_MISTAKE"))).resolves.toEqual({
    status: "NoWaste",
  });
  const sql = tx.query.mock.calls.map((call) => String((call as unknown[])[0]));
  expect(sql[0]).toMatch(/pg_advisory_xact_lock/u);
  expect(sql.some((text) => /FROM rms_inventory\.store_waste /u.test(text))).toBe(true);
});
