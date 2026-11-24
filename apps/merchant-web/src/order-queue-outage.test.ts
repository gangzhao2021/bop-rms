import { describe, expect, it } from "vitest";
import {
  awaitingFirst,
  awaitingSince,
  earlierDayWaiting,
  ordersSummary,
  statusTabCount,
} from "./CurrentOrderQueuePage.js";
import type { CurrentOrderQueue } from "./current-order-queue-client.js";

type Item = CurrentOrderQueue["items"][number];
const order = (
  number: string,
  submittedAt: string,
  options: {
    readonly awaiting?: boolean;
    readonly acceptBy?: string | null;
    readonly roundSentAt?: string;
    readonly day?: string;
    readonly earlierOpen?: boolean;
    /** The business day the order belongs to, when it is listed under another (`day`). */
    readonly opened?: string;
  } = {},
): Item =>
  ({
    orderReference: number,
    orderNumber: number,
    orderType: options.acceptBy ? "Pickup" : "DineIn",
    submittedAt,
    acceptBy: options.acceptBy ?? null,
    businessDate: options.opened ?? options.day ?? "2026-11-06",
    listedBusinessDate: options.day ?? "2026-11-06",
    heldStock: null,
    earlierOpenPickup: options.earlierOpen === true,
    batches: [
      {
        orderBatchReference: number + "-1",
        sequence: 1,
        canRequestAcceptance: options.awaiting === true && options.roundSentAt === undefined,
        submittedAt,
        awaitingAcceptanceSince: null,
      },
      ...(options.roundSentAt === undefined
        ? []
        : [
            {
              orderBatchReference: number + "-2",
              sequence: 2,
              canRequestAcceptance: true,
              submittedAt: options.roundSentAt,
              awaitingAcceptanceSince: null,
            },
          ]),
    ],
  }) as unknown as Item;

describe("merchant-outage-recovery M43: orders to accept come first, the longest waiting on top", () => {
  it("puts a dine-in round waiting 15 minutes above a pickup placed a minute ago", () => {
    const pickup = order("P-2", "2026-11-06T18:14:00.000Z", {
      awaiting: true,
      acceptBy: "2026-11-06T18:24:00.000Z",
    });
    const table = order("T-1", "2026-11-06T17:00:00.000Z", {
      roundSentAt: "2026-11-06T18:00:00.000Z",
    });
    const done = order("D-9", "2026-11-06T18:20:00.000Z");
    // The server lists newest first.
    const sorted = awaitingFirst([done, pickup, table]);
    expect(sorted.map((item) => item.orderNumber)).toEqual(["T-1", "P-2", "D-9"]);
    // A table's later round counts from when it was sent, not from when the table opened.
    expect(awaitingSince(table)).toBe("2026-11-06T18:00:00.000Z");
  });

  it("keeps each day group together and the other orders in the server's order", () => {
    const today = [
      order("A", "2026-11-06T18:05:00.000Z"),
      order("B", "2026-11-06T18:04:00.000Z", { awaiting: true }),
      order("C", "2026-11-06T18:03:00.000Z"),
      order("E", "2026-11-06T18:01:00.000Z", { awaiting: true }),
    ];
    const yesterday = [
      order("Y1", "2026-11-05T18:00:00.000Z", { day: "2026-11-05" }),
      order("Y2", "2026-11-05T17:00:00.000Z", { day: "2026-11-05", awaiting: true }),
    ];
    expect(awaitingFirst([...today, ...yesterday]).map((item) => item.orderNumber)).toEqual([
      "E",
      "B",
      "A",
      "C",
      "Y2",
      "Y1",
    ]);
  });

  // Batch 55 (v15 batch 54 live, Test Merchant 2): the server sends the earlier days' unfinished
  // pickups first (earlierDayItems), 46 of them, and a New order sat about 15,000 px down a phone.
  it("lists today's orders, the New order to accept on top, before the earlier days' unfinished ones", () => {
    const earlier = ["2026-11-04", "2026-11-05", "2026-11-04"].map((day, index) =>
      order(day.slice(5) + "-" + (index + 1), day + "T21:33:01.000Z", { day, earlierOpen: true }),
    );
    const today = [
      order("51", "2026-11-06T18:20:00.000Z", {
        awaiting: true,
        acceptBy: "2026-11-06T18:50:00.000Z",
      }),
      order("49", "2026-11-06T18:10:00.000Z"),
      order("48", "2026-11-06T18:09:00.000Z"),
    ];
    const sorted = awaitingFirst([...earlier, ...today]).map((item) => item.orderNumber);
    expect(sorted).toEqual(["51", "49", "48", "11-04-1", "11-05-2", "11-04-3"]);
    // Every order stays listed.
    expect(sorted).toHaveLength(earlier.length + today.length);
  });
});

// Batch 56 (v15 batch 55 live, Test Merchant 2): the table order "11/4 · 2", whose only round from
// Wed Nov 4 still waited to be accepted, was listed first under Today, above the real New order.
describe("batch 56: an earlier day's order still waiting to be accepted is listed with the earlier days", () => {
  const day = { businessDate: "2026-11-23", startsAt: "2026-11-23T09:00:00.000Z" };
  const leftover = order("2", "2026-11-05T01:47:04.758Z", {
    awaiting: true,
    day: "2026-11-23",
    opened: "2026-11-04",
  });
  const fresh = order("75", "2026-11-23T20:24:00.000Z", {
    awaiting: true,
    acceptBy: "2026-11-23T20:54:00.000Z",
    day: "2026-11-23",
  });
  const accepted = order("74", "2026-11-23T20:14:00.000Z", { day: "2026-11-23" });
  const pickup = order("20", "2026-11-04T21:33:01.000Z", { day: "2026-11-04", earlierOpen: true });
  // An older table that sent a round today is today's work.
  const tonight = order("9", "2026-11-22T22:00:00.000Z", {
    day: "2026-11-23",
    opened: "2026-11-22",
    roundSentAt: "2026-11-23T19:00:00.000Z",
  });

  it("tells a leftover from today's work", () => {
    expect(earlierDayWaiting(leftover, day)).toBe(true);
    expect(earlierDayWaiting(tonight, day)).toBe(false);
    expect(earlierDayWaiting(fresh, day)).toBe(false);
    expect(earlierDayWaiting(pickup, day)).toBe(false);
    // Not known until the business day is read: listed as the server lists it.
    expect(earlierDayWaiting(leftover, null)).toBe(false);
  });

  it("lists today's orders first, the New order on top, and keeps the leftover", () => {
    const sorted = awaitingFirst([leftover, pickup, fresh, tonight, accepted], day);
    expect(sorted.map((item) => item.orderNumber)).toEqual(["9", "75", "74", "2", "20"]);
  });

  it("counts the day's orders as the server counts them, and the leftover as an earlier day's", () => {
    const base = { unreadable: [] } as unknown as CurrentOrderQueue;
    const view = {
      ...base,
      items: [leftover, pickup, fresh, accepted],
      nextAfterOrderReference: "74",
      todayOrderCount: 75,
    } as CurrentOrderQueue;
    expect(ordersSummary(view, "2026-11-23", 2, day)).toBe(
      "75 orders today · 1 to accept · 2 from earlier days (1 to accept)",
    );
    // An older server (no count) and a next page: the page's count says it is the page's.
    const older = Object.fromEntries(
      Object.entries(view).filter(([key]) => key !== "todayOrderCount"),
    ) as CurrentOrderQueue;
    expect(ordersSummary(older, "2026-11-23", 2, day)).toBe(
      "2 of today's orders on this page · 1 to accept · 2 from earlier days (1 to accept)",
    );
    // The whole day on one page: the page's count is the day's.
    expect(
      ordersSummary(
        { ...older, nextAfterOrderReference: null } as CurrentOrderQueue,
        "2026-11-23",
        2,
        day,
      ),
    ).toBe("2 orders today · 1 to accept · 2 from earlier days (1 to accept)");
  });
});

// Batch 57 (v15 batch 56 live, Test Merchant 2, business date 2026-11-23).
describe("batch 57: the Orders header and tabs count what they say", () => {
  const day = { businessDate: "2026-11-23", startsAt: "2026-11-23T09:00:00.000Z" };
  const filters = {
    orderNumber: "",
    type: "All",
    channel: "All",
    phase: "All",
    day: "Today" as const,
    today: "2026-11-23",
  };
  // The 11/4 table order still waiting, 45 earlier-day open pickups, and today's newest 50 of 89
  // with none to accept.
  const leftover = order("2", "2026-11-05T01:47:04.758Z", {
    awaiting: true,
    day: "2026-11-23",
    opened: "2026-11-04",
  });
  const pickups = Array.from({ length: 45 }, (_, i) =>
    order(String(20 + i), "2026-11-04T21:33:01.000Z", { day: "2026-11-04", earlierOpen: true }),
  );
  const todays = Array.from({ length: 50 }, (_, i) =>
    order(String(89 - i), "2026-11-23T20:00:00.000Z", { day: "2026-11-23" }),
  );
  const view = {
    unreadable: [],
    items: [leftover, ...pickups, ...todays],
    nextAfterOrderReference: "40",
    todayOrderCount: 89,
  } as unknown as CurrentOrderQueue;

  it("says the one to accept is the earlier days', not one of today's", () => {
    // Before: "89 orders today · 1 to accept · 46 from earlier days".
    expect(ordersSummary(view, "2026-11-23", 1, day)).toBe(
      "89 orders today · 46 from earlier days (1 to accept)",
    );
  });

  it("counts All as today's orders and the earlier days' listed with them, and no partial tab", () => {
    // Before: "All 96" (the loaded rows), and every tab a count of the loaded rows only.
    expect(statusTabCount(view, null, filters)).toBe(89 + 46);
    expect(statusTabCount(view, null, { ...filters, phase: "AwaitingAcceptance" })).toBeNull();
    expect(statusTabCount(view, null, { ...filters, phase: "Fulfilled" })).toBeNull();
    // A narrowed list, a later page or no server count: no number that reads as the day's.
    expect(statusTabCount(view, null, { ...filters, type: "Pickup" })).toBeNull();
    expect(statusTabCount(view, null, { ...filters, day: "All" })).toBeNull();
    expect(statusTabCount(view, "40", filters)).toBeNull();
    const older = Object.fromEntries(
      Object.entries(view).filter(([key]) => key !== "todayOrderCount"),
    ) as CurrentOrderQueue;
    expect(statusTabCount(older, null, filters)).toBeNull();
  });

  it("counts every tab when the whole list is loaded", () => {
    const whole = {
      ...view,
      items: [leftover, ...todays.slice(0, 3)],
      nextAfterOrderReference: null,
      todayOrderCount: 3,
    } as CurrentOrderQueue;
    expect(statusTabCount(whole, null, filters)).toBe(4);
    expect(statusTabCount(whole, null, { ...filters, phase: "AwaitingAcceptance" })).toBe(1);
  });
});
