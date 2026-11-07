import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseTableBill } from "./table-checkout-client.js";
import { splitBillFixture } from "./table-split.fixtures.js";
import { CurrentOrderLines } from "./CurrentOrderQueuePage.js";
import { roundAsOrderedMinor } from "./TableCheckout.js";
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
  it("shows the bill's tax rounding on its own line and a total equal to checkout", () => {
    const html = renderToStaticMarkup(
      <CurrentOrderLines lines={{ items: [], totals: totals("-1", "2705") }} />,
    );
    expect(html).toContain("<dt>Tax</dt><dd>$3.12</dd>");
    expect(html).toContain("<dt>Tax rounding</dt><dd>−$0.01</dd>");
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
  it("lists each checkout round as it was ordered; the rounding is the bill's one line", () => {
    const value = splitBillFixture();
    const rounds = value.rounds as Record<string, unknown>[];
    rounds[0] = { ...rounds[0], taxMinor: "630", totalMinor: "5480", taxRoundingMinor: "-1" };
    const bill = parseTableBill(value);
    expect(bill.rounds.map(roundAsOrderedMinor)).toEqual(["5481", "4011"]);
  });
});
