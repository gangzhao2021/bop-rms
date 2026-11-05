import { describe, expect, it } from "vitest";
import {
  decideOrderAutoAcceptance,
  orderAutoAcceptanceFailureIsQuiet,
  resolveOrderAutoAcceptedPickupRefund,
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

  describe("when an untouched pickup refunds", () => {
    const sentAt = "2026-11-05T12:00:00.000Z";
    const at = (time: string) => `2026-11-05T${time}:00.000Z`;
    const online = async () => ({ online: true, backOnlineAt: null });
    const base = {
      sentAt,
      reachedKitchen: true,
      lastKitchenStepAt: null,
      storeAt: online,
    };

    it("30 minutes after it was sent, with staff on and a quiet kitchen", async () => {
      expect(
        await resolveOrderAutoAcceptedPickupRefund({ ...base, observedAt: at("12:10") }),
      ).toEqual({ refundAt: at("12:30"), due: false });
      expect(
        await resolveOrderAutoAcceptedPickupRefund({ ...base, observedAt: at("12:30") }),
      ).toEqual({ refundAt: at("12:30"), due: true });
    });

    it("a kitchen still recording steps holds it: the queue may just be long", async () => {
      expect(
        await resolveOrderAutoAcceptedPickupRefund({
          ...base,
          observedAt: at("12:35"),
          lastKitchenStepAt: at("12:31"),
        }),
      ).toEqual({ refundAt: at("12:41"), due: false });
      expect(
        await resolveOrderAutoAcceptedPickupRefund({
          ...base,
          observedAt: at("12:41"),
          lastKitchenStepAt: at("12:31"),
        }),
      ).toEqual({ refundAt: at("12:41"), due: true });
    });

    it("one that never reached the kitchen is not held by steps on other tickets", async () => {
      expect(
        await resolveOrderAutoAcceptedPickupRefund({
          ...base,
          reachedKitchen: false,
          observedAt: at("12:30"),
          lastKitchenStepAt: at("12:29"),
        }),
      ).toEqual({ refundAt: at("12:30"), due: true });
    });

    it("the Store offline at its time: no refund and no time, until staff are back", async () => {
      const asked: string[] = [];
      expect(
        await resolveOrderAutoAcceptedPickupRefund({
          ...base,
          observedAt: at("13:00"),
          storeAt: async (when) => {
            asked.push(when);
            return { online: false, backOnlineAt: null };
          },
        }),
      ).toEqual({ refundAt: null, due: false });
      expect(asked).toEqual([at("12:30")]);
    });

    it("staff back gets a new window of 15 minutes, with no refund before it ends", async () => {
      const storeAt = async (when: string) =>
        when === at("12:30")
          ? { online: false, backOnlineAt: at("13:00") }
          : { online: true, backOnlineAt: null };
      expect(
        await resolveOrderAutoAcceptedPickupRefund({ ...base, observedAt: at("13:01"), storeAt }),
      ).toEqual({ refundAt: at("13:15"), due: false });
      expect(
        await resolveOrderAutoAcceptedPickupRefund({ ...base, observedAt: at("13:15"), storeAt }),
      ).toEqual({ refundAt: at("13:15"), due: true });
    });

    it("an outage inside the new window moves it again", async () => {
      expect(
        await resolveOrderAutoAcceptedPickupRefund({
          ...base,
          observedAt: at("14:00"),
          storeAt: async (when) =>
            when === at("12:30")
              ? { online: false, backOnlineAt: at("13:00") }
              : when === at("13:15")
                ? { online: false, backOnlineAt: at("13:50") }
                : { online: true, backOnlineAt: null },
        }),
      ).toEqual({ refundAt: at("14:05"), due: false });
    });

    it("gives up after a chain of outages rather than refund on a guess", async () => {
      let hours = 12;
      expect(
        await resolveOrderAutoAcceptedPickupRefund({
          ...base,
          observedAt: "2026-11-06T12:00:00.000Z",
          storeAt: async () => {
            hours += 1;
            return { online: false, backOnlineAt: at(String(hours) + ":00") };
          },
        }),
      ).toEqual({ refundAt: null, due: false });
    });
  });

  it("expected refusals stay quiet; anything else is reported", () => {
    expect(orderAutoAcceptanceFailureIsQuiet({ name: "OrderAcceptanceRecordError" })).toBe(true);
    for (const code of ["55P03", "40001", "40P01"])
      expect(orderAutoAcceptanceFailureIsQuiet({ code })).toBe(true);
    expect(orderAutoAcceptanceFailureIsQuiet({ code: "23514" })).toBe(false);
    expect(orderAutoAcceptanceFailureIsQuiet(new Error("boom"))).toBe(false);
  });
});
