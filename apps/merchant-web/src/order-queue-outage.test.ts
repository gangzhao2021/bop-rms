import { describe, expect, it } from "vitest";
import { awaitingFirst, awaitingSince } from "./CurrentOrderQueuePage.js";
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
  } = {},
): Item =>
  ({
    orderReference: number,
    orderNumber: number,
    orderType: options.acceptBy ? "Pickup" : "DineIn",
    submittedAt,
    acceptBy: options.acceptBy ?? null,
    listedBusinessDate: options.day ?? "2026-11-06",
    heldStock: null,
    earlierOpenPickup: false,
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
});
