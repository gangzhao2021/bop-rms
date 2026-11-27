import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  orderAmountNote,
  orderAmountRefunded,
  orderRefundRows,
  orderRowNoteShownEverywhere,
} from "./CurrentOrderQueuePage.js";
import { parseCurrentOrderQueue } from "./current-order-queue-client.js";
import { setLanguageForTest } from "./i18n/i18n.js";
import { staffRoundRefusedShortText } from "./staff-round-offer.js";
import { TableReceipt, tableBillRefundState, tableCheckoutHeading } from "./TableCheckout.js";
import type { TableBill } from "./table-checkout-client.js";

/**
 * Batch 64 (v15 b62 live, TM2 S62 E and order 8; b63 F27 final check): money said truthfully once
 * a paid table bill is refunded, and every refund under the Orders totals.
 */
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" as const });
const id = (n: number) => "0190a64b-0000-7000-8000-" + n.toString(16).padStart(12, "0");

afterEach(() => setLanguageForTest("en"));

/** S62 E: $28.25 and a $3.75 tip paid by phone ($32.00), then refunded. */
function bill(refunds: { givenMinor: string; onItsWayMinor: string }): TableBill {
  return {
    refunds,
    diningSessionReference: id(2),
    sessionPhase: "Closing",
    sessionVersion: 7,
    paymentTiming: "PayLater",
    tableLabel: "S62 E (TEST)",
    orderReference: id(3),
    rounds: [
      {
        roundNumber: 1,
        orderBatchReference: id(21),
        items: [
          {
            orderItemReference: id(901),
            quantity: 2,
            displayName: "Beef noodles (TEST)",
            subtotalMinor: "2500",
            totalMinor: "2825",
          },
        ],
        subtotalMinor: "2500",
        taxMinor: "325",
        totalMinor: "2825",
        paid: true,
      },
    ],
    owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
    consistent: true,
    tips: { enabled: true },
    split: null,
    settlement: {
      method: "Online",
      roundsMinor: "2825",
      tipMinor: "375",
      roundingMinor: "0",
      totalMinor: "3200",
      tenderedMinor: null,
      changeMinor: null,
      recordedAt: "2026-11-24T22:45:00.000Z",
      recordedAfterOutage: false,
    },
  } as unknown as TableBill;
}
const receipt = (refunds: { givenMinor: string; onItsWayMinor: string }) =>
  renderToStaticMarkup(<TableReceipt bill={bill(refunds)} tableLabel="S62 E (TEST)" />)
    .replace(/<[^>]+>/gu, "|")
    .replace(/\|+/gu, "|");

describe("b64: Tables checkout of a paid bill refunded afterwards", () => {
  it("reads a bill refunded in full as refunded, net $0.00, never as paid", () => {
    expect(tableBillRefundState(bill({ givenMinor: "3200", onItsWayMinor: "0" }))).toBe("Full");
    const text = receipt({ givenMinor: "3200", onItsWayMinor: "0" });
    expect(text).toContain("|Total|$32.00|");
    expect(text).toContain("|Fully refunded|−$32.00|");
    expect(text).toContain("|Total after refunds|$0.00|");
    expect(text).toContain("Fully refunded. Close the table when the guests have left.");
    expect(text).toContain("|Print bill|");
    expect(text).not.toContain("Total paid");
    expect(text).not.toContain("Print paid bill");
    expect(text).not.toContain("Paid in full");
  });

  it("reads a part refund as paid, part of it refunded, with what it comes to after", () => {
    expect(tableBillRefundState(bill({ givenMinor: "500", onItsWayMinor: "0" }))).toBe("Part");
    const text = receipt({ givenMinor: "500", onItsWayMinor: "0" });
    expect(text).toContain("|Total|$32.00|");
    expect(text).toContain("|Refunded|−$5.00|");
    expect(text).toContain("|Total after refunds|$27.00|");
    expect(text).toContain("Paid, part of it refunded. Close the table when the guests have left.");
    expect(text).not.toContain("Total paid");
    expect(text).not.toContain("Paid in full");
  });

  it("says all of it is being refunded while some is still on its way to the card", () => {
    expect(tableBillRefundState(bill({ givenMinor: "2000", onItsWayMinor: "1200" }))).toBe(
      "AllOnItsWay",
    );
    const text = receipt({ givenMinor: "2000", onItsWayMinor: "1200" });
    expect(text).toContain("Being refunded in full. Close the table when the guests have left.");
    expect(text).toContain("|Refund on its way|$12.00|");
    expect(text).not.toContain("Paid in full");
  });

  it("heads a bill all of which is going back, some still on its way, as being refunded", () => {
    const onItsWay = bill({ givenMinor: "2000", onItsWayMinor: "1200" });
    // Money not yet back on the guest's card is never said as given back.
    expect(tableCheckoutHeading(onItsWay)).toBe("Being refunded");
    expect(tableCheckoutHeading(bill({ givenMinor: "3200", onItsWayMinor: "0" }))).toBe("Refunded");
    expect(tableCheckoutHeading(bill({ givenMinor: "500", onItsWayMinor: "0" }))).toBe("Paid");
    expect(tableCheckoutHeading(bill({ givenMinor: "0", onItsWayMinor: "0" }))).toBe("Paid");
    setLanguageForTest("zh-Hans");
    expect(tableCheckoutHeading(onItsWay)).toBe("退款中");
    expect(tableCheckoutHeading(bill({ givenMinor: "3200", onItsWayMinor: "0" }))).toBe("已退款");
  });

  it("keeps a bill nothing went back from as paid in full", () => {
    expect(tableBillRefundState(bill({ givenMinor: "0", onItsWayMinor: "0" }))).toBe("None");
    const text = receipt({ givenMinor: "0", onItsWayMinor: "0" });
    expect(text).toContain("|Total paid|$32.00|");
    expect(text).toContain("Paid in full. Close the table when the guests have left.");
    expect(text).toContain("|Print paid bill|");
  });

  it("says it in Chinese too", () => {
    setLanguageForTest("zh-Hans");
    const full = receipt({ givenMinor: "3200", onItsWayMinor: "0" });
    expect(full).toContain("已全部退款。客人离开后关台。");
    expect(full).toContain("|打印账单|");
    expect(full).not.toContain("实付合计");
    expect(full).not.toContain("已付账单");
    expect(receipt({ givenMinor: "500", onItsWayMinor: "0" })).toContain(
      "已付款，部分已退款。客人离开后关台。",
    );
  });

  it("never says the refunded bill is paid when no round can be added", () => {
    expect(staffRoundRefusedShortText("Paid", true, true)).toBe(
      "No new rounds on a refunded bill. New dishes start a new bill once the table is closed.",
    );
    expect(staffRoundRefusedShortText("Paid", true)).toBe(
      "No new rounds on a paid bill. New dishes start a new bill once the table is closed.",
    );
  });
});

describe("b64: the Orders row of a table bill refunded in full", () => {
  const order = (paid: Record<string, string>, checkingOut?: true) =>
    ({
      orderType: "DineIn",
      paidOnline: null,
      counter: null,
      batches: [],
      tableBill: {
        totalMinor: "2825",
        paid: { amountMinor: "3200", method: "Online", ...paid },
        ...(checkingOut ? { checkingOut } : {}),
      },
    }) as never;

  it("says it was fully refunded and, while the table is open, to close it when the guests leave", () => {
    const refunded = order({ refundedMinor: "3200" }, true);
    expect(orderAmountNote(refunded)).toBe("Fully refunded · close when the guests leave");
    expect(orderRowNoteShownEverywhere(refunded)).toBe(true);
    // The table was closed already: no step left, still never "Paid at the table".
    expect(orderAmountNote(order({ refundedMinor: "3200" }))).toBe("Fully refunded at the table");
    setLanguageForTest("zh-Hans");
    expect(orderAmountNote(refunded)).toBe("已全部退款 · 客人走后关台");
    expect(orderAmountNote(order({ refundedMinor: "3200" }))).toBe("已在桌上全部退款");
  });

  // Batch 65 (v15 b64 live, S64 B) changed this: a part refund is never "Paid at the table"
  // (已在桌上付清), and all of it on its way back is said as being refunded, with its next step.
  it("says a part refund as part refunded and one still on its way as being refunded", () => {
    expect(orderAmountNote(order({ refundedMinor: "500" }, true))).toBe(
      "Part refunded at the table · guest's phone",
    );
    // Batch 67 (v15 b65 live) changed this: a part refund's note shows at every width too.
    expect(orderRowNoteShownEverywhere(order({ refundedMinor: "500" }, true))).toBe(true);
    const onItsWay = order({ refundedMinor: "3200", refundPendingMinor: "300" }, true);
    expect(orderAmountNote(onItsWay)).toBe("Being refunded · close when the guests leave");
    expect(orderRowNoteShownEverywhere(onItsWay)).toBe(true);
  });

  it("reads checkingOut from the server only on a paid bill, and refuses anything but true", () => {
    const row = (tableBill: unknown) => ({
      orderReference: id(1),
      orderNumber: "8",
      orderType: "DineIn",
      sourceChannel: "Qr",
      submittedAt: "2026-11-24T22:44:00.000Z",
      observedAt: "2026-11-24T22:53:00.000Z",
      initialBatchReference: id(51),
      batches: [
        {
          orderBatchReference: id(51),
          sequence: 1,
          acceptanceStatus: "Accepted",
          canRequestAcceptance: false,
          canCancel: false,
          staffCancellation: null,
          canCancelItems: false,
        },
      ],
      canRequestAcceptance: false,
      unfulfillable: null,
      pickupNotCollected: false,
      acceptBy: null,
      awaitingPayment: false,
      tableBill,
      currentPhase: "Fulfilled",
      currentVersion: 4,
    });
    const parse = (tableBill: unknown) =>
      parseCurrentOrderQueue({ items: [row(tableBill)], nextAfterOrderReference: null }).items[0]
        ?.tableBill;
    const paid = { amountMinor: "3200", method: "Online", refundedMinor: "3200" };
    expect(parse({ totalMinor: "2825", paid, checkingOut: true })?.checkingOut).toBe(true);
    expect(parse({ totalMinor: "2825", paid })?.checkingOut).toBeUndefined();
    expect(() => parse({ totalMinor: "2825", paid, checkingOut: false })).toThrow();
  });
});

describe("b64 (b63 F27 final check): every refund under the Orders totals, counted once", () => {
  const lines = {
    items: [],
    totals: { total: money("1413") },
  } as unknown as Parameters<typeof orderRefundRows>[1];
  const clock = (at: string) => at.slice(11, 16);
  const record = (
    refunds: { method: "Online" | "Cash" | "CardMachine"; amountMinor: string; at: string }[],
  ) =>
    ({
      accepted: [],
      handedOver: [],
      payments: [],
      cancellations: [],
      refunds: refunds.map((refund) => ({
        ...refund,
        by: "You",
        approvedBy: null,
        cashGivenBackMinor: null,
      })),
      writeOff: null,
      paidOnlineByGuest: false,
    }) as unknown as Parameters<typeof orderRefundRows>[3];
  const counter = (refundedMinor: string, cash = false, cancelled?: string) =>
    ({
      orderType: "Pickup",
      paidOnline: null,
      tableBill: null,
      counter: {
        paidOnCardMachine: {
          amountMinor: "1413",
          refundedMinor,
          ...(cash
            ? { cash: { tenderedMinor: "2000", changeMinor: "585", roundingMinor: "-2" } }
            : {}),
        },
      },
      batches: [
        {
          sequence: 1,
          staffRound: null,
          staffCancellation:
            cancelled === undefined
              ? null
              : {
                  reasonCode: "CUSTOMER_REQUEST",
                  cancelledAt: "2026-11-25T17:30:00.000Z",
                  refundStatus: "Refunded",
                  refundMethod: "CardMachine",
                  refundAmountMinor: cancelled,
                },
        },
      ],
    }) as unknown as Parameters<typeof orderRefundRows>[0];

  it("lists a counter order's own card-machine refund, with its way and time from the record", () => {
    const machine = record([
      { method: "CardMachine", amountMinor: "200", at: "2026-11-25T17:28:00.000Z" },
    ]);
    expect(orderRefundRows(counter("200"), lines, null, machine, clock)).toEqual([
      { label: "Refunded on the card machine · 17:28", amount: money("200") },
    ]);
    // Without the record: the money still shows, said plainly.
    expect(orderRefundRows(counter("200"), lines, null)).toEqual([
      { label: "Refunded", amount: money("200") },
    ]);
    // The list's "refunded" and the lines agree.
    expect(orderAmountRefunded(counter("200") as never)).toBe(200n);
  });

  it("lists a counter order's cash given back", () => {
    const cash = record([{ method: "Cash", amountMinor: "300", at: "2026-11-25T17:29:00.000Z" }]);
    expect(orderRefundRows(counter("300", true), lines, null, cash, clock)).toEqual([
      { label: "Cash given back · 17:29", amount: money("300") },
    ]);
  });

  it("never counts a counter cancellation's refund twice beside the ordinary one", () => {
    // $10.00 given back when part was cancelled, then $2.00 more at the guest's request: the
    // payment's refunds hold both ($12.00).
    const both = record([
      { method: "CardMachine", amountMinor: "1000", at: "2026-11-25T17:30:00.000Z" },
      { method: "CardMachine", amountMinor: "200", at: "2026-11-25T17:40:00.000Z" },
    ]);
    expect(orderRefundRows(counter("1200", false, "1000"), lines, null, both, clock)).toEqual([
      { label: "Order cancellation refund (card machine)", amount: money("1000") },
      { label: "Refunded on the card machine · 17:40", amount: money("200") },
      { label: "Total refunded", amount: money("1200") },
    ]);
    // Only the cancellation: nothing else is said.
    expect(orderRefundRows(counter("1000", false, "1000"), lines, null)).toEqual([
      { label: "Order cancellation refund (card machine)", amount: money("1000") },
    ]);
  });

  // Payment's position is the order's settlement across every way it was paid
  // (order-financial-position.ts: settlement.confirmedRefundMinor adds the card machine's and the
  // table's refunds), so the page must not add them again.
  const position = (refundedMinor: string, refundPendingMinor = "0") => ({
    refundedMinor,
    refundPendingMinor,
    refundNotSentMinor: "0",
    refundOnMachineMinor: "0",
  });

  it("counts a staff round's card-machine refund once when Payment's position is read", () => {
    // A pay-first table: round 1 paid by phone, round 2 entered by staff and paid on the card
    // machine; $2.00 back on the machine.
    const order = {
      orderType: "DineIn",
      paidOnline: money("1413"),
      tableBill: null,
      counter: null,
      batches: [
        { sequence: 1, staffRound: null, staffCancellation: null },
        {
          sequence: 2,
          staffCancellation: null,
          staffRound: { paidOnCardMachine: { amountMinor: "1413", refundedMinor: "200" } },
        },
      ],
    } as unknown as Parameters<typeof orderRefundRows>[0];
    expect(orderAmountRefunded(order as never, position("200"))).toBe(200n);
    expect(orderRefundRows(order, lines, position("200"))).toEqual([
      { label: "Refunded", amount: money("200") },
    ]);
  });

  it("counts a phone-paid table's refunds once when Payment's position is read", () => {
    const order = {
      orderType: "DineIn",
      paidOnline: null,
      counter: null,
      batches: [{ sequence: 1, staffRound: null, staffCancellation: null }],
      tableBill: {
        totalMinor: "2825",
        paid: {
          amountMinor: "3200",
          method: "Online",
          refundedMinor: "3000",
          refundPendingMinor: "200",
        },
      },
    } as unknown as Parameters<typeof orderRefundRows>[0];
    expect(orderRefundRows(order, lines, position("3000", "200"))).toEqual([
      { label: "Refunded", amount: money("3000") },
      { label: "Refund on its way", amount: money("200"), pending: true },
    ]);
    expect(orderAmountRefunded(order as never, position("3000", "200"))).toBe(3000n);
    // Without a position (the pilot's pay-later table: no online payment of its own), the table's.
    expect(orderRefundRows(order, lines, null)).toEqual([
      { label: "Refunded", amount: money("3000") },
      { label: "Refund on its way", amount: money("200"), pending: true },
    ]);
  });
});
