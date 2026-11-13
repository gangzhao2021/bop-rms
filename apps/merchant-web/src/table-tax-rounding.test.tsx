import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseTableBill } from "./table-checkout-client.js";
import { splitBillFixture } from "./table-split.fixtures.js";
import { CurrentOrderLines, orderBill } from "./CurrentOrderQueuePage.js";
import { parseCurrentOrderDetail } from "./current-order-queue-client.js";
import {
  CURRENT_ORDER_REFS,
  currentOrderDetailFixture as detailOf,
} from "./current-order-queue.fixtures.js";

const orderId = CURRENT_ORDER_REFS.accepted;
const currentOrderDetailFixture = () =>
  detailOf(orderId) as NonNullable<ReturnType<typeof detailOf>>;

describe("WP-2423 DEC-TAX-WHOLE-RECEIPT: the bill's tax rounding at the Tables checkout", () => {
  it("reads the bill's and each round's tax rounding, signed, and 0 from an older server", () => {
    const value = splitBillFixture();
    const rounds = value.rounds as Record<string, unknown>[];
    expect(parseTableBill(value).taxRoundingMinor).toBe("0");
    expect(parseTableBill(value).rounds.map((round) => round.taxRoundingMinor)).toEqual(["0", "0"]);
    value.taxRoundingMinor = "-1";
    rounds[1] = { ...rounds[1], taxRoundingMinor: "-1" };
    const bill = parseTableBill(value);
    expect(bill.taxRoundingMinor).toBe("-1");
    expect(bill.rounds[1]?.taxRoundingMinor).toBe("-1");
    for (const broken of ["--1", "-0", "1.5", 1])
      expect(() => parseTableBill({ ...value, taxRoundingMinor: broken })).toThrow();
    expect(renderToStaticMarkup(<p>{bill.taxRoundingMinor}</p>)).toContain("-1");
  });
});

// v15 publishing-contention finding (Fireside Hotpot, 6 × $3.99 over 5 rounds, 13% HST): the
// rounds were charged $3.12 tax but the bill's tax is round(23.94 × 13%) = $3.11. The table panel
// and Orders read the Order's total with its share of the bill's tax rounding, as checkout takes it.
describe("WP-2423 DEC-TAX-WHOLE-RECEIPT: the Order's detail on Tables and Orders", () => {
  const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
  const totals = (taxRounding: string, total: string) => ({
    subtotal: money("2394"),
    discount: money("0"),
    tax: money("312"),
    fee: money("0"),
    total: money(total),
    taxRounding: money(taxRounding),
    tip: null,
  });
  it("b15: says one Tax, its rounding in it, and a total equal to checkout", () => {
    const html = renderToStaticMarkup(
      <CurrentOrderLines lines={{ items: [], totals: totals("-1", "2705") }} />,
    );
    expect(html).toContain("<dt>Tax</dt><dd>$3.11</dd>");
    expect(html).not.toContain("Tax rounding");
    expect(html).toContain("<dt>Total</dt><dd>$27.05</dd>");
    const none = renderToStaticMarkup(
      <CurrentOrderLines lines={{ items: [], totals: totals("0", "2706") }} />,
    );
    expect(none).not.toContain("Tax rounding");
    expect(none).toContain("<dt>Total</dt><dd>$27.06</dd>");
  });
  it("reads the rounding from the detail, refuses another currency, and 0 from an older server", () => {
    const detail = currentOrderDetailFixture();
    const lines = detail.lines as { totals: Record<string, unknown> };
    expect(parseCurrentOrderDetail(detail, orderId).lines.totals.taxRounding).toEqual(money("0"));
    lines.totals = { ...lines.totals, taxRounding: money("-1") };
    expect(parseCurrentOrderDetail(detail, orderId).lines.totals.taxRounding).toEqual(money("-1"));
    for (const broken of [
      { amountMinor: "-1", currencyCode: "USD" },
      money("-0"),
      money("0.5"),
      "-1",
      null,
    ]) {
      lines.totals = { ...lines.totals, taxRounding: broken };
      expect(() => parseCurrentOrderDetail(detail, orderId)).toThrow();
    }
  });
});

// v15 batch 9 review: three separate $12.50 rounds at 13% are charged $1.63 tax each ($4.89); the
// whole bill's tax is $4.88, so the bill rounds by −$0.01. v15 b15 live (TM2): the Tables panel
// read "Tax $4.89 / Total $42.39 / Tax rounding −$0.01 / Whole bill to pay $42.38" while the guest,
// checkout and the paid bill read Tax $4.88 / Total $42.38. b15 review: the round amounts too
// ($14.13 three times, $42.39) and, with comps, the ordered block's Tax $6.51 / $56.51 — one figure
// everywhere now: each round as the bill charges it, the Tax and Total its sums.
describe("v15 b15: an Order on a pay-at-end table reads the bill's rounds, Tax and Total", () => {
  const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
  const ref = (n: number) => "0190996a-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const line = (n: number) => ({
    orderItemReference: ref(200 + n),
    orderBatchReference: ref(50 + n),
    name: "Wonton soup " + String(n),
    options: [],
    quantity: 1,
    customerNote: null,
    unitPrice: money("1250"),
    subtotal: money("1250"),
    discount: money("0"),
    tax: money("163"),
    fee: money("0"),
    total: money("1413"),
    canCancel: false,
    cancellation: null,
  });
  const lines = {
    items: [line(1), line(2), line(3)],
    totals: {
      subtotal: money("3750"),
      discount: money("0"),
      tax: money("489"),
      fee: money("0"),
      total: money("4239"),
      taxRounding: money("0"),
      tip: null,
    },
  } as never;
  const batch = (n: number, comped: boolean) => ({
    orderBatchReference: ref(50 + n),
    sequence: n,
    submittedAt: null,
    staffRound: null,
    paymentDue: null,
    kitchenRelease: null,
    compedItems: comped ? [{ orderItemReference: ref(200 + n), amountMinor: "1413" }] : [],
  });
  const round = (n: number, subtotal: string, tax: string, total: string) => ({
    orderBatchReference: ref(50 + n),
    subtotalMinor: subtotal,
    taxMinor: tax,
    totalMinor: total,
  });
  const order = (tableBill: Record<string, unknown> | null, comped = false) =>
    ({
      tableBill,
      batches: [1, 2, 3].map((n) => batch(n, comped && n === 2)),
    }) as never;
  const render = (bill: ReturnType<typeof orderBill>, comped = false) =>
    renderToStaticMarkup(
      <CurrentOrderLines
        lines={lines}
        billRounding={bill}
        rounds={{ batches: (order(null, comped) as { batches: never[] }).batches }}
      />,
    );
  const amounts = (html: string) =>
    [...html.matchAll(/<span class="order-round__amount">([^<]+)<\/span>/gu)].map(
      (match) => match[1],
    );
  // Rule v2: the bill's −$0.01 sits on round 3 (largest remainder), as checkout and the split say.
  const unpaid = {
    totalMinor: "4238",
    paid: null,
    taxRoundingMinor: "-1",
    rounds: [
      round(1, "1250", "163", "1413"),
      round(2, "1250", "163", "1413"),
      round(3, "1250", "162", "1412"),
    ],
  };
  it("says each round, the Tax and the Total as the bill charges them, with no second total", () => {
    const html = render(orderBill(order(unpaid)));
    expect(amounts(html)).toEqual(["$14.13", "$14.13", "$14.12"]);
    expect(html).toContain("<dt>Subtotal</dt><dd>$37.50</dd>");
    expect(html).toContain("<dt>Tax</dt><dd>$4.88</dd>");
    expect(html).toContain("<dt>Total</dt><dd>$42.38</dd>");
    expect(html).not.toContain("Tax rounding");
    expect(html).not.toContain("Whole bill to pay");
    // Paid: the same figures (the bill as paid), and no amount to pay.
    const paid = render(
      orderBill(order({ ...unpaid, paid: { amountMinor: "4238", method: "Cash" } })),
    );
    expect(amounts(paid)).toEqual(["$14.13", "$14.13", "$14.12"]);
    expect(paid).toContain("<dt>Total</dt><dd>$42.38</dd>");
    expect(paid).not.toContain("to pay");
  });
  it("with comps, says the bill after them: one Tax, the one checkout and the guest read", () => {
    // Round 2 comped: the bill is $25.00 + round(25.00 × 13%) = $3.25 tax, $28.25; the rounds
    // were charged $1.63 each, so the −$0.01 is on round 1.
    const html = render(
      orderBill(
        order(
          {
            totalMinor: "2825",
            paid: null,
            taxRoundingMinor: "-1",
            rounds: [
              round(1, "1250", "162", "1412"),
              round(2, "0", "0", "0"),
              round(3, "1250", "163", "1413"),
            ],
          },
          true,
        ),
      ),
      true,
    );
    expect(amounts(html)).toEqual(["$14.12", "$0.00", "$14.13"]);
    expect(html).toContain("<dt>Subtotal after comps</dt><dd>$25.00</dd>");
    expect(html).toContain("<dt>Tax</dt><dd>$3.25</dd>");
    expect(html).toContain("<dt>Total</dt><dd>$28.25</dd>");
    expect(html).not.toContain("$4.89");
    expect(html).not.toContain("$42.39");
    expect(html).not.toContain("Tax rounding");
  });
  it("says the whole bill to pay apart only when a table merged into it adds to it", () => {
    const html = render(
      orderBill(order({ ...unpaid, totalMinor: "5651" }), "Whole bill to pay, with Table 3"),
    );
    expect(html).toContain("<dt>Total</dt><dd>$42.38</dd>");
    expect(html).toContain("<dt>Whole bill to pay, with Table 3</dt><dd>$56.51</dd>");
    expect(
      orderBill(
        order({ ...unpaid, totalMinor: "0", mergedInto: { tableLabel: "Table 3", paid: false } }),
      )?.toPay,
    ).toBeNull();
  });
  it("an older server: its share in the Tax and Total without comps, the lines as ordered with", () => {
    const older = { totalMinor: "4238", paid: null, taxRoundingMinor: "-1" };
    const html = render(orderBill(order(older)));
    expect(html).toContain("<dt>Tax</dt><dd>$4.88</dd>");
    expect(html).toContain("<dt>Total</dt><dd>$42.38</dd>");
    expect(amounts(html)).toEqual(["$14.13", "$14.13", "$14.13"]);
    expect(orderBill(order(older, true))).toBeUndefined();
    expect(orderBill(order({ totalMinor: "4238", paid: null }))).toBeUndefined();
    expect(orderBill(order(null))).toBeUndefined();
  });
});
