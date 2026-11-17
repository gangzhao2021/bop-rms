import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { roundBillLines } from "./CurrentOrderQueuePage.js";
import { checkoutCompMinor, roundTaxLine } from "./TableCheckout.js";

// b26 (v15 live25, TM2 'L25 TCP (TEST)'): round 1 kept Smashed cucumber $6.25 (comped $7.06,
// $6.25 before tax), round 3 Soy milk $3.25 + Smashed cucumber $6.25 at $10.74 on the bill.
const dish = (name: string, net: string) => ({
  subtotal: { amountMinor: net, currencyCode: "CAD" },
  name,
});
type Batch = Parameters<typeof roundBillLines>[0];
type Lines = Parameters<typeof roundBillLines>[1];
const comped = { compedItems: [{ reasonCode: "GOODWILL" }] } as unknown as Batch;
const plain = { compedItems: [] } as unknown as Batch;
const text = (node: unknown) =>
  renderToStaticMarkup(<ul>{node as never}</ul>).replace(/<[^>]+>/gu, "|");

it("live25: a comped round on Orders and Tables lists its comp and Tax before tax, adding up to $0.00", () => {
  const html = text(
    roundBillLines(
      comped,
      [dish("Smashed cucumber", "625")] as unknown as Lines,
      {
        orderBatchReference: "r1",
        subtotalMinor: "0",
        taxMinor: "0",
        totalMinor: "0",
      },
      "CAD",
    ),
  );
  expect(html).toContain("Comps and discounts, before tax");
  expect(html).toContain("−$6.25");
  expect(html).toContain("Tax|");
  expect(html).toContain("$0.00");
});

it("live25: round 3's $3.25 + $6.25 and Tax $1.24 make its $10.74", () => {
  const html = text(
    roundBillLines(
      plain,
      [dish("Soy milk", "325"), dish("Smashed cucumber", "625")] as unknown as Lines,
      { orderBatchReference: "r3", subtotalMinor: "950", taxMinor: "124", totalMinor: "1074" },
      "CAD",
    ),
  );
  expect(html).not.toContain("Comps");
  expect(html).toContain("$1.24");
  // Dishes that can't be read as the bill's (an order-time discount) get no Tax line.
  expect(
    roundBillLines(
      plain,
      [dish("Soy milk", "325")] as unknown as Lines,
      { orderBatchReference: "r", subtotalMinor: "300", taxMinor: "39", totalMinor: "339" },
      "CAD",
    ),
  ).toBeNull();
});

it("live25: checkout's round lines (dishes and comps before tax, Tax) add up to the round", () => {
  const round = (items: unknown[], tax: string, total: string) =>
    ({ items, taxMinor: tax, totalMinor: total }) as unknown as Parameters<typeof roundTaxLine>[0];
  const comp = { kind: "Comp", percent: null, amountMinor: "706", netMinor: "625" } as const;
  // Round 1 read "Smashed cucumber · Comped −$7.06 … $6.25": the comp is now before tax too.
  expect(checkoutCompMinor(comp)).toBe("625");
  expect(checkoutCompMinor({ ...comp, netMinor: null })).toBe("706");
  expect(roundTaxLine(round([{ subtotalMinor: "625", reduction: comp }], "0", "0"))).toBe(true);
  expect(
    roundTaxLine(
      round(
        [
          { subtotalMinor: "325", reduction: null },
          { subtotalMinor: "625", reduction: null },
        ],
        "124",
        "1074",
      ),
    ),
  ).toBe(true);
  // An older server's comp has no amount before tax: no Tax line that would not add up.
  expect(
    roundTaxLine(
      round([{ subtotalMinor: "625", reduction: { ...comp, netMinor: null } }], "0", "0"),
    ),
  ).toBe(false);
  expect(roundTaxLine(round([], "0", "0"))).toBe(false);
});
