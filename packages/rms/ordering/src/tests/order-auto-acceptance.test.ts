import { describe, expect, it } from "vitest";
import {
  decideOrderAutoAcceptance,
  orderAutoAcceptanceFailureIsQuiet,
  orderAutoAcceptedPickupRefundAt,
  type OrderAutoAcceptanceFacts,
} from "../domain/order-auto-acceptance.js";

const ready: OrderAutoAcceptanceFacts = {
  switchState: { on: true, since: "2026-11-05T10:00:00.000Z" },
  paidAt: "2026-11-05T12:00:00.000Z",
  observedAt: "2026-11-05T12:00:05.000Z",
  paidOnCardMachine: false,
  deadlineKind: "Standard",
  kitchenScreenSeenAt: "2026-11-05T11:59:30.000Z",
  storeOpen: true,
  hasAlcohol: false,
  itemCount: 3,
  stockIntact: true,
};

describe("DEC-PAID-ORDER-AUTO-ACCEPT decision", () => {
  it("accepts a paid order nothing needs a person for, a later round included", () => {
    expect(decideOrderAutoAcceptance(ready)).toEqual({ action: "Accept" });
    expect(decideOrderAutoAcceptance({ ...ready, deadlineKind: null })).toEqual({
      action: "Accept",
    });
  });

  it.each([
    ["switch off", { switchState: { on: false, since: null } }, "SwitchOff"],
    ["paid on the card machine", { paidOnCardMachine: true }, "CardMachine"],
    ["held through an outage", { deadlineKind: "Held" as const }, "OutageHold"],
  ])("writes nothing when %s", (_name, facts, reason) => {
    expect(decideOrderAutoAcceptance({ ...ready, ...facts })).toEqual({ action: "Silent", reason });
  });

  it.each([
    [
      "paid before the switch was turned on",
      { paidAt: "2026-11-05T09:59:59.999Z", observedAt: "2026-11-05T10:01:00.000Z" },
      "PaidBeforeSwitch",
    ],
    ["paid 30 minutes ago", { observedAt: "2026-11-05T12:30:00.000Z" }, "PaidTooLongAgo"],
    ["the Store not open", { storeOpen: false }, "StoreNotOpen"],
    ["no kitchen board ever read", { kitchenScreenSeenAt: null }, "KitchenScreenOff"],
    [
      "the kitchen board last read over 3 minutes ago",
      { kitchenScreenSeenAt: "2026-11-05T11:57:04.999Z" },
      "KitchenScreenOff",
    ],
    ["alcohol", { hasAlcohol: true }, "HasAlcohol"],
    ["more than 15 items", { itemCount: 16 }, "LargeOrder"],
    ["stock changed", { stockIntact: false }, "StockChanged"],
  ])("leaves it to a person with %s", (_name, facts, reason) => {
    expect(decideOrderAutoAcceptance({ ...ready, ...facts })).toEqual({ action: "Skip", reason });
  });

  it("15 items still go; a board read exactly 3 minutes ago still counts", () => {
    expect(decideOrderAutoAcceptance({ ...ready, itemCount: 15 }).action).toBe("Accept");
    expect(
      decideOrderAutoAcceptance({ ...ready, kitchenScreenSeenAt: "2026-11-05T11:57:05.000Z" })
        .action,
    ).toBe("Accept");
  });

  it("names the first condition that fails, cheapest facts first", () => {
    expect(
      decideOrderAutoAcceptance({
        ...ready,
        storeOpen: false,
        hasAlcohol: true,
        kitchenScreenSeenAt: null,
      }),
    ).toEqual({ action: "Skip", reason: "StoreNotOpen" });
  });

  it("a pickup the kitchen has not touched refunds 30 minutes after it was sent", () => {
    expect(orderAutoAcceptedPickupRefundAt("2026-11-05T12:00:00.000Z")).toBe(
      "2026-11-05T12:30:00.000Z",
    );
  });

  it("expected refusals stay quiet; anything else is reported", () => {
    expect(orderAutoAcceptanceFailureIsQuiet({ name: "OrderAcceptanceRecordError" })).toBe(true);
    for (const code of ["55P03", "40001", "40P01"])
      expect(orderAutoAcceptanceFailureIsQuiet({ code })).toBe(true);
    expect(orderAutoAcceptanceFailureIsQuiet({ code: "23514" })).toBe(false);
    expect(orderAutoAcceptanceFailureIsQuiet(new Error("boom"))).toBe(false);
  });
});
