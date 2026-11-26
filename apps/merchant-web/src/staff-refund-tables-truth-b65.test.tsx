// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orderAmountNote, orderRefundRows } from "./CurrentOrderQueuePage.js";
import {
  parseCurrentOrderDetail,
  tablePaidRefundState,
  type CurrentOrderDetail,
} from "./current-order-queue-client.js";
import { DiningRoundsProvider } from "./DiningRounds.js";
import { mount, until } from "./dom-test-kit.fixture.js";
import { setLanguageForTest } from "./i18n/i18n.js";
import { settlementReportsGapText } from "./SettlementPage.js";
import { byPaymentLeftOutText } from "./StoreReportsPage.js";
import type { StoreReportSummary } from "./store-reports-client.js";
import { TableCheckout } from "./TableCheckout.js";
import type { TableBill } from "./table-checkout-client.js";
import type { StaffDiningTable, StaffDiningTableSession } from "./dining-session-client.js";
import { paidTableAmount, paidTableWords, tableNeed } from "./table-needs.js";
import { tableFactsFromBill } from "./table-order-facts.js";

/**
 * Batch 65 (v15 b64 live, TM2 S64 A/B/E, orders 79 and the Settlement/Reports check): refunds said
 * truthfully on Tables, its open checkout panel, the Orders row and totals, and why Settlement and
 * Reports show different "Online (guest's phone)" figures.
 */
const csrf = "A".repeat(43);
const id = (n: number) => "0190a65b-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" as const });

afterEach(() => setLanguageForTest("en"));

/** S64 A/B: $14.13 and a $1.88 tip paid by phone ($16.01), with what went back. */
function bill(refunds: { givenMinor: string; onItsWayMinor: string } | null): TableBill {
  return {
    ...(refunds === null ? {} : { refunds }),
    diningSessionReference: id(2),
    sessionPhase: "Closing",
    sessionVersion: 7,
    paymentTiming: "PayLater",
    tableLabel: "S64 A (TEST)",
    orderReference: id(3),
    rounds: [
      {
        roundNumber: 1,
        orderBatchReference: id(21),
        items: [
          {
            orderItemReference: id(901),
            quantity: 1,
            displayName: "Beef noodles (TEST)",
            subtotalMinor: "1250",
            totalMinor: "1413",
          },
        ],
        subtotalMinor: "1250",
        taxMinor: "163",
        totalMinor: "1413",
        paid: true,
      },
    ],
    owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
    consistent: true,
    tips: { enabled: true, tierPercents: [10, 15, 20] },
    split: null,
    waitingRounds: [],
    writeOff: null,
    onlinePayment: null,
    settlement: {
      method: "Online",
      roundsMinor: "1413",
      tipMinor: "188",
      roundingMinor: "0",
      totalMinor: "1601",
      tenderedMinor: null,
      changeMinor: null,
      recordedAt: "2026-11-25T01:13:00.000Z",
      recordedAfterOutage: false,
    },
  } as unknown as TableBill;
}

describe("b65: the Tables list row of a paid table says what went back", () => {
  const now = Date.parse("2026-11-25T01:40:00.000Z");
  const closing = {
    tableReference: id(70),
    stableLabel: "S64 B (TEST)",
    areaCode: "MAIN",
    capacity: 4,
    lifecycle: "Published",
    operationalState: "Available",
    blockReasonCode: null,
    aggregateVersion: 2,
    currentDiningSessionReference: id(2),
    elapsedMinutes: 30,
    qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
    paymentTiming: "PayLater",
    session: { phase: "Closing", version: 7, orderReference: id(3) },
    staffRoundsAwaitingPayment: [],
    guestRoundsAwaitingPayment: [],
    roundsAwaitingAcceptance: [],
    staffCall: null,
  } as unknown as StaffDiningTable;
  const row = (refunds: { givenMinor: string; onItsWayMinor: string } | null) =>
    tableNeed(closing, tableFactsFromBill(bill(refunds)), now);

  it("never calls a part-refunded table paid in full, and shows what it paid after the refund", () => {
    expect(row({ givenMinor: "500", onItsWayMinor: "0" })).toMatchObject({
      tone: "done",
      words: "Part refunded · close when the guests leave",
      detail: "$11.01 · $5.00 refunded",
    });
    setLanguageForTest("zh-Hans");
    const zh = row({ givenMinor: "500", onItsWayMinor: "0" });
    expect(zh.words).toBe("部分已退款 · 客人走后关台");
    expect(zh.words).not.toContain("已付清");
    expect(zh.detail).toBe("$11.01 · 已退 $5.00");
  });

  it("shows $0.00 for a bill refunded in full, never the paid amount alone", () => {
    expect(row({ givenMinor: "1601", onItsWayMinor: "0" })).toMatchObject({
      words: "Fully refunded · close when the guests leave",
      detail: "$0.00 · $16.01 refunded",
    });
  });

  it("says a bill all of which is going back, some still on its way, as being refunded", () => {
    expect(row({ givenMinor: "1000", onItsWayMinor: "601" })).toMatchObject({
      words: "Being refunded · close when the guests leave",
      detail: "$10.00 refunded · $6.01 on its way",
    });
    setLanguageForTest("zh-Hans");
    expect(row({ givenMinor: "1000", onItsWayMinor: "601" }).words).toBe("退款中 · 客人走后关台");
  });

  it("keeps a bill nothing went back from as paid, at what it paid", () => {
    expect(row(null)).toMatchObject({
      words: "Paid · close when the guests leave",
      detail: "$16.01",
    });
  });

  it("says the same from the Orders queue's figures", () => {
    const paid = { amountMinor: "1601", refundedMinor: "500" };
    expect(paidTableWords(paid)).toBe("Part refunded · close when the guests leave");
    expect(paidTableAmount(paid)).toBe("$11.01 · $5.00 refunded");
    expect(tablePaidRefundState({ amountMinor: "1601" })).toBe("None");
    expect(tablePaidRefundState({ amountMinor: "1601", refundedMinor: "1601" })).toBe("Full");
    expect(
      tablePaidRefundState({
        amountMinor: "1601",
        refundedMinor: "1000",
        refundPendingMinor: "601",
      }),
    ).toBe("AllOnItsWay");
  });
});

describe("b65: the Orders row of a part-refunded table", () => {
  const order = (paid: Record<string, string>, method = "Online") =>
    ({
      orderType: "DineIn",
      paidOnline: null,
      counter: null,
      batches: [],
      tableBill: {
        totalMinor: "1413",
        paid: { amountMinor: "1601", method, ...paid },
        checkingOut: true,
      },
    }) as never;

  it("says part refunded, never paid in full, and still how it was paid", () => {
    expect(orderAmountNote(order({ refundedMinor: "500" }))).toBe(
      "Part refunded at the table · guest's phone",
    );
    expect(orderAmountNote(order({ refundedMinor: "500" }, "Cash"))).toBe(
      "Part refunded at the table · cash",
    );
    setLanguageForTest("zh-Hans");
    expect(orderAmountNote(order({ refundedMinor: "500" }))).toBe("已在桌上部分退款 · 客人手机");
  });
});

describe("b65: the Tables panel's rounds line of a paid table", () => {
  const progress = {
    orderReference: id(3),
    tableLabel: "S64 B (TEST)",
    sessionVersion: 7,
    diningSessionReference: id(2),
    sessionPhase: "Closing",
    tableAssignmentVersion: 3,
    closureStatus: "Open",
    closureVersion: 0,
    currentOrderVersion: 4,
    orderVersion: 4,
    phase: "Fulfilled",
    observedAt: "2026-11-25T01:30:00.000Z",
    items: [
      {
        orderItemReference: id(901),
        orderBatchReference: id(21),
        displayName: "Beef noodles (TEST)",
        batchSequence: 1,
        itemOrdinal: 1,
        phase: "Fulfilled",
        orderedQuantity: 1,
        deliveredQuantity: 1,
        remainingQuantity: 0,
        itemServiceVersion: 2,
      },
    ],
  };
  const line = async (billRefundState: "None" | "Part" | "Full" | "AllOnItsWay") => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(progress), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
    );
    const { container } = await mount(
      <DiningRoundsProvider
        orderReference={id(3)}
        csrf={csrf}
        refreshKey="1"
        fetcher={fetcher}
        billPaid
        billRefundState={billRefundState}
      >
        <p>Rounds</p>
      </DiningRoundsProvider>,
    );
    await until(() => container.querySelector(".dining-rounds__table") !== null);
    const text = container.querySelector(".dining-rounds__table")?.textContent ?? "";
    container.remove();
    return text;
  };

  it("says part refunded or being refunded, never only paid", async () => {
    expect(await line("Part")).toBe("Part refunded · close when the guests leave");
    expect(await line("AllOnItsWay")).toBe("Being refunded · close when the guests leave");
    expect(await line("Full")).toBe("Fully refunded · close when the guests leave");
    expect(await line("None")).toBe("Paid · close when the guests leave");
  });
});

describe("b65: a Tables checkout panel already open follows a refund made on another screen", () => {
  const table = {
    tableReference: id(70),
    stableLabel: "S64 E (TEST)",
    areaCode: "MAIN",
    capacity: 4,
    lifecycle: "Published",
    operationalState: "Available",
    blockReasonCode: null,
    aggregateVersion: 2,
    currentDiningSessionReference: id(2),
    elapsedMinutes: 30,
    qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
    paymentTiming: "PayLater",
    session: { phase: "Closing", version: 7, orderReference: id(3) },
    staffRoundsAwaitingPayment: [],
  } as unknown as StaffDiningTable;
  const session = {
    phase: "Closing",
    version: 7,
    orderReference: id(3),
  } as StaffDiningTableSession;

  it("reads the paid bill again when the floor is read again, and says Refunded", async () => {
    let refunded = false;
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>(async () => {
      reads += 1;
      // The server's figures: refundedMinor counts a refund on its way too.
      return new Response(
        JSON.stringify({ ...bill(null), ...(refunded ? { refundedMinor: "1601" } : {}) }),
        {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        },
      );
    });
    const panel = (refreshKey: string) => (
      <TableCheckout
        table={table}
        session={session}
        csrf={csrf}
        locked={false}
        canStart
        onChanged={() => undefined}
        fetcher={fetcher}
        refreshKey={refreshKey}
      />
    );
    const { container, root } = await mount(panel("floor-1"));
    const heading = () => container.querySelector("#table-checkout-title")?.textContent ?? "";

    await until(() => heading() === "Paid");
    expect(container.textContent).toContain("Total paid");
    const before = reads;
    // The bill is refunded in full from Orders on another screen; this screen reads the floor.
    refunded = true;
    await act(async () => root.render(panel("floor-2")));
    await until(() => heading() === "Refunded");
    expect(reads).toBe(before + 1);
    expect(container.textContent).toContain("Fully refunded");
    expect(container.textContent).not.toContain("Total paid");
    expect(container.textContent).not.toContain("Print paid bill");
    // Nothing new on the floor: no read more.
    await act(async () => root.render(panel("floor-2")));
    expect(reads).toBe(before + 1);
  });
});

describe("b65: a counter cash refund under the Orders totals", () => {
  const lines = {
    items: [],
    totals: { total: money("1780") },
  } as unknown as Parameters<typeof orderRefundRows>[1];
  const clock = (at: string) => at.slice(11, 16);
  // Order 79: $17.80 in cash; a $3.67 request given back as $3.65 from the drawer.
  const counter = {
    orderType: "Pickup",
    paidOnline: null,
    tableBill: null,
    counter: {
      paidOnCardMachine: {
        amountMinor: "1780",
        refundedMinor: "365",
        cash: { tenderedMinor: "2000", changeMinor: "220", roundingMinor: "0" },
      },
    },
    batches: [{ sequence: 1, staffRound: null, staffCancellation: null }],
  } as unknown as Parameters<typeof orderRefundRows>[0];
  const record = (refund: Record<string, unknown>) =>
    ({
      accepted: [],
      handedOver: [],
      payments: [],
      cancellations: [],
      refunds: [
        {
          method: "Cash",
          amountMinor: "367",
          by: "You",
          approvedBy: null,
          at: "2026-11-25T01:41:00.000Z",
          cashGivenBackMinor: "365",
          ...refund,
        },
      ],
      writeOff: null,
      paidOnlineByGuest: false,
    }) as unknown as Parameters<typeof orderRefundRows>[3];

  it("names the cash given back, why and when, at the drawer's amount", () => {
    expect(
      orderRefundRows(counter, lines, null, record({ reasonCode: "CUSTOMER_REQUEST" }), clock),
    ).toEqual([
      {
        label: "Cash given back · Customer asked for a refund · 01:41",
        amount: money("365"),
      },
    ]);
    // No reason known (an older server): the way and the time still.
    expect(orderRefundRows(counter, lines, null, record({}), clock)).toEqual([
      { label: "Cash given back · 01:41", amount: money("365") },
    ]);
    setLanguageForTest("zh-Hans");
    expect(
      orderRefundRows(counter, lines, null, record({ reasonCode: "CUSTOMER_REQUEST" }), clock)[0]
        ?.label,
    ).toMatch(/^已退现金 · .+ · 01:41$/u);
  });

  it("reads why from the order's record, and refuses a malformed reason", () => {
    const detail = (reasonCode: unknown) => ({
      screenId: "OPS-ORDER-DETAIL",
      pickupContact: null,
      order: {
        orderReference: id(79),
        orderNumber: "79",
        orderType: "Pickup",
        sourceChannel: "Pos",
        submittedAt: "2026-11-25T01:30:00.000Z",
        observedAt: "2026-11-25T01:42:00.000Z",
        initialBatchReference: id(81),
        batches: [
          {
            orderBatchReference: id(81),
            sequence: 1,
            acceptanceStatus: "Accepted",
            canRequestAcceptance: false,
            canCancel: false,
            staffCancellation: null,
            canCancelItems: false,
          },
        ],
        canRequestAcceptance: false,
        canViewPayments: false,
        canRecordCardMachinePayment: false,
        currentVersion: 4,
        unfulfillable: null,
        pickupNotCollected: false,
        acceptBy: null,
        awaitingPayment: false,
        currentPhase: "Fulfilled",
      },
      lines: {
        items: [
          {
            orderItemReference: id(201),
            orderBatchReference: id(81),
            name: "Soy milk (TEST)",
            options: [],
            quantity: 1,
            customerNote: null,
            unitPrice: money("1575"),
            subtotal: money("1575"),
            discount: money("0"),
            tax: money("205"),
            fee: money("0"),
            total: money("1780"),
            canCancel: false,
            cancellation: null,
          },
        ],
        totals: {
          subtotal: money("1575"),
          discount: money("0"),
          tax: money("205"),
          fee: money("0"),
          taxRounding: money("0"),
          total: money("1780"),
        },
      },
      record: {
        accepted: [],
        handedOver: [],
        payments: [],
        cancellations: [],
        refunds: [
          {
            method: "Cash",
            amountMinor: "367",
            by: "You",
            approvedBy: null,
            at: "2026-11-25T01:41:00.000Z",
            cashGivenBackMinor: "365",
            reasonCode,
          },
        ],
        writeOff: null,
        paidOnlineByGuest: false,
      },
    });
    const parsed = parseCurrentOrderDetail(
      detail("CUSTOMER_REQUEST"),
      id(79),
    ) as CurrentOrderDetail;
    expect(parsed.record?.refunds[0]?.reasonCode).toBe("CUSTOMER_REQUEST");
    expect(() => parseCurrentOrderDetail(detail("customer asked"), id(79))).toThrow();
  });
});

describe("b65: Settlement and Reports under the same label", () => {
  const channel = (
    entry: "Online" | "CardMachine" | "Cash",
    cancelledInFullCount: number,
    cancelledInFullMinor: string,
  ) =>
    ({
      channel: entry,
      cancelledInFullCount,
      cancelledInFullMinor,
    }) as unknown as StoreReportSummary & { channel: "Online" | "CardMachine" | "Cash" };

  it("says under Reports' payment table what it leaves out that Settlement counts", () => {
    expect(byPaymentLeftOutText([channel("Online", 3, "4239"), channel("Cash", 0, "0")])).toBe(
      "Online (guest's phone) leaves out 3 orders ($42.39) taken and given back the same day. Settlement counts them in its Online (guest's phone) taken and refunded, so both read $42.39 more there; Net taken is the same.",
    );
    expect(byPaymentLeftOutText([channel("Online", 0, "0")])).toBeNull();
    setLanguageForTest("zh-Hans");
    expect(byPaymentLeftOutText([channel("Online", 3, "4239")])).toContain("$42.39");
    expect(byPaymentLeftOutText([channel("Online", 3, "4239")])).toContain("线上（客人手机）");
  });

  it("says on Settlement why Reports can read lower under the same label", () => {
    expect(settlementReportsGapText()).toContain("Reports lists orders taken and given back");
    setLanguageForTest("zh-Hans");
    expect(settlementReportsGapText()).toContain("净实收相同");
  });
});
