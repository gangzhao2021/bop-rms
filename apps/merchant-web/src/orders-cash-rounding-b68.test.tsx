import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  CurrentOrderLines,
  orderAmountRefunded,
  orderAmountTaken,
  orderCounterCashRoundingMinor,
  orderRefundRows,
  orderTableTaken,
} from "./CurrentOrderQueuePage.js";
import { parseCurrentOrderDetail } from "./current-order-queue-client.js";
import { setLanguageForTest } from "./i18n/i18n.js";

/**
 * Batch 68 (v15 b67 live, TM2 order 8, TEST-only data): a counter order of $3.67 was paid $3.65
 * in cash (rounded to 5 cents) and refunded in full in cash ($3.65 given back; card_machine_refund
 * 365 OrdinaryRefund). The Orders row read $0.00 / $3.65 refunded, but the detail read Total $3.67,
 * Cash given back −$3.65, Total after refunds $0.02, with no Cash rounding line: 2 cents the store
 * never took. The detail's Total is now the cash taken, its rounding said on its own line.
 */
const id = (n: number) => "0190b168-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });

afterEach(() => setLanguageForTest("en"));

const item = (n: number, total: string, subtotal: string, tax: string) => ({
  orderItemReference: id(200 + n),
  orderBatchReference: id(51),
  name: "Soy milk (Hot)",
  options: [],
  quantity: 1,
  customerNote: null,
  unitPrice: money(subtotal),
  subtotal: money(subtotal),
  discount: money("0"),
  tax: money(tax),
  fee: money("0"),
  total: money(total),
  canCancel: false,
  cancellation: null,
});
/** The detail the server sends for a counter order (as v15 sent TM2 order 8). */
const detail = (input: {
  readonly items: readonly ReturnType<typeof item>[];
  readonly totals: { subtotal: string; tax: string; total: string };
  readonly paid: Record<string, unknown>;
  readonly refunds: readonly { method: string; amountMinor: string; cash?: string }[];
}) => ({
  screenId: "OPS-ORDER-DETAIL",
  pickupContact: null,
  order: {
    orderReference: id(1),
    orderNumber: "8",
    orderType: "Pickup",
    sourceChannel: "Pos",
    submittedAt: "2026-11-27T16:02:00.000Z",
    observedAt: "2026-11-27T16:05:00.000Z",
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
    counter: { recordedAfterOutage: false, paidOnCardMachine: input.paid },
    canRequestAcceptance: false,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
    currentPhase: "Fulfilled",
    currentVersion: 6,
  },
  lines: {
    items: input.items,
    totals: {
      subtotal: money(input.totals.subtotal),
      discount: money("0"),
      tax: money(input.totals.tax),
      fee: money("0"),
      taxRounding: money("0"),
      total: money(input.totals.total),
    },
  },
  record: {
    accepted: [],
    handedOver: [],
    payments: [
      {
        method: input.paid.cash === undefined ? "CardMachine" : "Cash",
        part: null,
        round: null,
        by: "You",
        at: "2026-11-27T16:02:53.000Z",
      },
    ],
    cancellations: [],
    refunds: input.refunds.map((refund) => ({
      method: refund.method,
      amountMinor: refund.amountMinor,
      by: "You",
      approvedBy: null,
      at: "2026-11-27T16:04:42.000Z",
      cashGivenBackMinor: refund.cash ?? null,
      reasonCode: "CUSTOMER_REQUEST",
    })),
    writeOff: null,
    paidOnlineByGuest: false,
  },
});
const paid = (amountMinor: string, refundedMinor: string, cash?: Record<string, string>) => ({
  amountMinor,
  takenAt: "2026-11-27T16:02:53.000Z",
  recordedAfterOutage: false,
  refundedMinor,
  ...(cash === undefined ? {} : { cash }),
});
/** The order detail's totals as Orders renders them, by term. */
function totalsOf(value: ReturnType<typeof detail>) {
  const read = parseCurrentOrderDetail(value, id(1));
  const html = renderToStaticMarkup(
    <CurrentOrderLines
      lines={read.lines}
      refundRows={orderRefundRows(read.order, read.lines, read.paymentPosition, read.record, (at) =>
        at.slice(11, 16),
      )}
      tableTaken={orderTableTaken(read.order)}
      counterCashRoundingMinor={orderCounterCashRoundingMinor(read.order)}
    />,
  );
  const terms: Record<string, string> = {};
  for (const [, term, amount] of html.matchAll(
    /<div><dt>([^<]*)<\/dt><dd>(?:<span class="bop-amount">)?([^<]*)/gu,
  ))
    terms[term ?? ""] = amount ?? "";
  return { terms, order: read.order };
}

// TM2 order 8 on v15 (read-only SQL, 2026-11-27): total_minor 367, tender Cash, rounding_minor −2,
// tendered 500, change 135; card_machine_refund 365 OrdinaryRefund. The server sends the cash
// taken (365) as amountMinor.
const soyMilk = item(1, "367", "325", "42");
const order8 = detail({
  items: [soyMilk],
  totals: { subtotal: "325", tax: "42", total: "367" },
  paid: paid("365", "365", { tenderedMinor: "500", changeMinor: "135", roundingMinor: "-2" }),
  refunds: [{ method: "Cash", amountMinor: "367", cash: "365" }],
});

describe("b68: a counter cash order's detail adds up to the cash taken and given back", () => {
  it("TM2 order 8: rounded down and refunded in full, nothing is left after refunds", () => {
    const { terms, order } = totalsOf(order8);
    expect(orderCounterCashRoundingMinor(order)).toBe("-2");
    expect(terms).toEqual({
      Subtotal: "$3.25",
      Tax: "$0.42",
      "Cash rounding": "−$0.02",
      Total: "$3.65",
      "Cash given back · Customer asked for a refund · 16:04": "−$3.65",
      "Total after refunds": "$0.00",
    });
    // The Orders row says the same: $3.65 taken, $3.65 refunded.
    expect(orderAmountTaken(order)?.amountMinor).toBe("365");
    expect(orderAmountRefunded(order)).toBe(365n);
  });

  it("says it in Chinese with the same figures", () => {
    setLanguageForTest("zh-Hans");
    const { terms } = totalsOf(order8);
    expect(terms["现金取整"]).toBe("−$0.02");
    expect(terms["合计"]).toBe("$3.65");
    expect(terms["退款后合计"]).toBe("$0.00");
  });

  it("rounded down and refunded in part, or rounded up: the Total is the cash taken", () => {
    // 2 × $3.68 = $7.36 is taken as $7.35 (−$0.01); one $3.68 refunded is $3.70 from the drawer.
    const two = detail({
      items: [item(1, "368", "326", "42"), item(2, "368", "326", "42")],
      totals: { subtotal: "652", tax: "84", total: "736" },
      paid: paid("735", "370", { tenderedMinor: "1000", changeMinor: "265", roundingMinor: "-1" }),
      refunds: [{ method: "Cash", amountMinor: "368", cash: "370" }],
    });
    expect(totalsOf(two).terms).toMatchObject({
      "Cash rounding": "−$0.01",
      Total: "$7.35",
      "Total after refunds": "$3.65",
    });
    // $3.68 alone is taken as $3.70 (+$0.02), and all of it is given back.
    const up = detail({
      items: [item(1, "368", "326", "42")],
      totals: { subtotal: "326", tax: "42", total: "368" },
      paid: paid("370", "370", { tenderedMinor: "500", changeMinor: "130", roundingMinor: "2" }),
      refunds: [{ method: "Cash", amountMinor: "368", cash: "370" }],
    });
    expect(totalsOf(up).terms).toMatchObject({
      "Cash rounding": "+$0.02",
      Total: "$3.70",
      "Total after refunds": "$0.00",
    });
  });

  it("leaves a cash payment with nothing to round, a card machine payment and a phone payment as they were", () => {
    const even = detail({
      items: [item(1, "365", "323", "42")],
      totals: { subtotal: "323", tax: "42", total: "365" },
      paid: paid("365", "0", { tenderedMinor: "500", changeMinor: "135", roundingMinor: "0" }),
      refunds: [],
    });
    const evenTerms = totalsOf(even).terms;
    expect(evenTerms["Cash rounding"]).toBeUndefined();
    expect(evenTerms.Total).toBe("$3.65");
    const machine = detail({
      items: [soyMilk],
      totals: { subtotal: "325", tax: "42", total: "367" },
      paid: paid("367", "367"),
      refunds: [{ method: "CardMachine", amountMinor: "367" }],
    });
    const { terms, order } = totalsOf(machine);
    expect(orderCounterCashRoundingMinor(order)).toBe("0");
    expect(terms).toEqual({
      Subtotal: "$3.25",
      Tax: "$0.42",
      Total: "$3.67",
      "Refunded on the card machine · Customer asked for a refund · 16:04": "−$3.67",
      "Total after refunds": "$0.00",
    });
    // A guest's phone payment has no counter payment, so nothing is rounded.
    expect(orderCounterCashRoundingMinor({ counter: null })).toBe("0");
    const phone = renderToStaticMarkup(
      <CurrentOrderLines
        lines={parseCurrentOrderDetail(order8, id(1)).lines}
        refundRows={[{ label: "Refunded to card", amount: money("200") }]}
        counterCashRoundingMinor={orderCounterCashRoundingMinor({ counter: null })}
      />,
    );
    expect(phone).not.toContain("Cash rounding");
    expect(phone).toContain("<dt>Total</dt><dd>$3.67</dd>");
    expect(phone).toContain("<dt>Total after refunds</dt><dd>$1.67</dd>");
  });

  it("reads the cash rounding from the server, signed, and refuses anything else", () => {
    const withRounding = (roundingMinor: unknown) =>
      parseCurrentOrderDetail(
        detail({
          items: [soyMilk],
          totals: { subtotal: "325", tax: "42", total: "367" },
          paid: paid("365", "0", {
            tenderedMinor: "500",
            changeMinor: "135",
            roundingMinor: roundingMinor as string,
          }),
          refunds: [],
        }),
        id(1),
      ).order.counter?.paidOnCardMachine?.cash?.roundingMinor;
    expect(withRounding("-2")).toBe("-2");
    expect(withRounding("2")).toBe("2");
    expect(withRounding("0")).toBe("0");
    for (const broken of ["-0", "1.5", "+2", -2, null])
      expect(() => withRounding(broken)).toThrow();
  });
});
