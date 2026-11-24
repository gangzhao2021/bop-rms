import { describe, expect, it } from "vitest";
import { tableRefundPosition } from "./merchant-dining-table-checkout.js";
import { tableBillRefunds, tableBillTipAndRounding } from "./persistent-merchant-order-queue.js";

/**
 * b60 (v15 b59 live, TM2 order 27): a paid table's refunds as the Orders row reads them. Part 1
 * ($14.13) was paid on a phone and refunded to the card four times ($5.00, $1.00, $0.50, $0.25,
 * each Succeeded); here part 2 also has $2.00 refunded on the card machine and $1.50 in cash, one
 * refund to the card is still on its way ($3.00) and one the Provider refused ($4.00).
 */
const order = "01909971-0000-7000-8000-000000000001";
const online = (amountMinor: bigint, status: "Succeeded" | "Failed" | null) => ({
  orderReference: order,
  amountMinor,
  outcome:
    status === null
      ? null
      : { status, providerRefundReference: null, providerCreatedAt: null, recordedAt: "" },
});
const store = (refunds: {
  cash?: readonly { amountMinor: bigint }[];
  card?: readonly { amountMinor: bigint }[];
  online?: readonly ReturnType<typeof online>[];
}) =>
  ({
    listCashRefundsByOrders: async () => refunds.cash ?? [],
    listCardRefundsByOrders: async () => refunds.card ?? [],
    listOnlineRefundsByOrders: async () => refunds.online ?? [],
  }) as never;

describe("b60: a table's refunds on Orders", () => {
  it("counts only money given back; a refund on its way apart; a refused one in neither", async () => {
    const position = await tableRefundPosition(
      {} as never,
      store({
        cash: [{ amountMinor: 150n }],
        card: [{ amountMinor: 200n }],
        online: [
          online(500n, "Succeeded"),
          online(100n, "Succeeded"),
          online(50n, "Succeeded"),
          online(25n, "Succeeded"),
          online(300n, null),
          online(400n, "Failed"),
        ],
      }),
      order,
    );
    expect(position).toEqual({ refundedMinor: 1025n, pendingMinor: 300n });
    expect(tableBillRefunds(position)).toEqual({
      refundedMinor: "1025",
      refundPendingMinor: "300",
    });
  });

  it("sends neither figure while it is zero (a bill with no refund reads as before)", async () => {
    const none = await tableRefundPosition({} as never, store({}), order);
    expect(tableBillRefunds(none)).toEqual({});
    const refused = await tableRefundPosition(
      {} as never,
      store({ online: [online(400n, "Failed")] }),
      order,
    );
    expect(tableBillRefunds(refused)).toEqual({});
    const sending = await tableRefundPosition(
      {} as never,
      store({ online: [online(300n, null)] }),
      order,
    );
    expect(tableBillRefunds(sending)).toEqual({ refundPendingMinor: "300" });
  });
});

describe("b60 review: a table's tip and cash rounding on its Orders row", () => {
  it("adds up a whole payment or its paid parts, signed, and leaves out zeros", () => {
    expect(tableBillTipAndRounding([{ tipMinor: 600n, roundingMinor: 0n }])).toEqual({
      tipMinor: "600",
    });
    expect(
      tableBillTipAndRounding([
        { tipMinor: 300n, roundingMinor: -2n },
        { tipMinor: 0n, roundingMinor: 1n },
      ]),
    ).toEqual({ tipMinor: "300", roundingMinor: "-1" });
    expect(tableBillTipAndRounding([{ tipMinor: 0n, roundingMinor: 0n }])).toEqual({});
    expect(tableBillTipAndRounding([])).toEqual({});
  });
});
