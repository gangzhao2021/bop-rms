import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseTableBill } from "./table-checkout-client.js";
import { splitBillFixture } from "./table-split.fixtures.js";
import { billRoundingApart, CurrentOrderLines } from "./CurrentOrderQueuePage.js";
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
// checkout and the paid bill read Tax $4.88 / Total $42.38 — one tax figure everywhere now.
describe("v15 b15: an Order on a pay-at-end table reads the bill's one Tax and Total", () => {
  const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
  const lines = {
    items: [],
    totals: {
      subtotal: money("3750"),
      discount: money("0"),
      tax: money("489"),
      fee: money("0"),
      total: money("4239"),
      taxRounding: money("0"),
      tip: null,
    },
  };
  const order = (tableBill: Record<string, unknown>, comped = false) =>
    ({
      tableBill,
      batches: [{ compedItems: comped ? [{ orderItemReference: "x", amountMinor: "1413" }] : [] }],
    }) as never;
  it("puts the rounding in the Tax and Total, with no second total to pay", () => {
    const html = renderToStaticMarkup(
      <CurrentOrderLines
        lines={lines}
        billRounding={billRoundingApart(
          order({ totalMinor: "4238", paid: null, taxRoundingMinor: "-1" }),
        )}
      />,
    );
    expect(html).toContain("<dt>Subtotal</dt><dd>$37.50</dd>");
    expect(html).toContain("<dt>Tax</dt><dd>$4.88</dd>");
    expect(html).toContain("<dt>Total</dt><dd>$42.38</dd>");
    expect(html).not.toContain("Tax rounding");
    expect(html).not.toContain("Whole bill to pay");
  });
  it("says the whole bill to pay apart only when a table merged into it adds to it", () => {
    // The host's rounding moved to +$0.01 because a dish on the merged table was comped; the
    // host's own Order has no comps, so its Tax and Total hold it; the bill has both tables.
    const html = renderToStaticMarkup(
      <CurrentOrderLines
        lines={lines}
        billRounding={billRoundingApart(
          order({ totalMinor: "5410", paid: null, taxRoundingMinor: "1" }),
          "Whole bill to pay, with Table 3",
        )}
      />,
    );
    expect(html).toContain("<dt>Tax</dt><dd>$4.90</dd>");
    expect(html).toContain("<dt>Total</dt><dd>$42.40</dd>");
    expect(html).not.toContain("Tax rounding");
    expect(html).toContain("<dt>Whole bill to pay, with Table 3</dt><dd>$54.10</dd>");
  });
  it("leaves it to the comps list when this Order has comps, and says no amount once paid", () => {
    expect(
      billRoundingApart(order({ totalMinor: "2543", paid: null, taxRoundingMinor: "1" }, true)),
    ).toBeUndefined();
    expect(billRoundingApart(order({ totalMinor: "4238", paid: null }))).toBeUndefined();
    expect(
      billRoundingApart(
        order({
          totalMinor: "4238",
          paid: { amountMinor: "4238", method: "Cash" },
          taxRoundingMinor: "-1",
        }),
      ),
    ).toEqual({ taxRoundingMinor: "-1", toPay: null });
    expect(
      billRoundingApart(
        order({
          totalMinor: "0",
          paid: null,
          mergedInto: { tableLabel: "Table 3", paid: false },
          taxRoundingMinor: "-1",
        }),
      ),
    ).toEqual({ taxRoundingMinor: "-1", toPay: null });
    const paidHtml = renderToStaticMarkup(
      <CurrentOrderLines lines={lines} billRounding={{ taxRoundingMinor: "-1", toPay: null }} />,
    );
    // Paid: the Tax and Total are what the printed paid bill says ($4.88 / $42.38).
    expect(paidHtml).toContain("<dt>Tax</dt><dd>$4.88</dd>");
    expect(paidHtml).toContain("<dt>Total</dt><dd>$42.38</dd>");
    expect(paidHtml).not.toContain("Tax rounding");
    expect(paidHtml).not.toContain("to pay");
  });
});
