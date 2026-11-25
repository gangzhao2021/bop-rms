import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { roundBillLines, roundDishComps } from "./CurrentOrderQueuePage.js";
import {
  checkoutCompMinor,
  checkoutDishMinor,
  checkoutOptionsText,
  roundTaxLine,
} from "./TableCheckout.js";

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

it("b63 review: a comped dish's one amount never takes a tax-included comp off a pre-tax price", () => {
  const comp = { kind: "Comp", percent: null, amountMinor: "706", netMinor: "625" } as const;
  expect(checkoutDishMinor({ subtotalMinor: "625", reduction: comp })).toBe("0");
  expect(checkoutDishMinor({ subtotalMinor: "625", reduction: null })).toBe("625");
  // An older server sends no comp before tax: no subtraction (the comp keeps its own amount).
  expect(checkoutDishMinor({ subtotalMinor: "625", reduction: { ...comp, netMinor: null } })).toBe(
    null,
  );
});

it("b63 review (T15): a dish's options read as on the Tables rounds", () => {
  expect(
    checkoutOptionsText([
      { name: "Hot", quantity: 1 },
      { name: "Extra egg", quantity: 2 },
    ]),
  ).toBe("Hot · Extra egg × 2");
});

// b63 review (F36, T6): on the Tables rounds the comped dish read "$6.25", the round "Comps and
// discounts, before tax −$6.25" and the order "−$7.06" under its Total — one comp in three forms.
it("b63 review: a comped dish reads Comped $0.00 on its round, with no before-tax comp line", () => {
  const line = (reference: string, net: string, quantity = 1) => ({
    orderItemReference: reference,
    quantity,
    subtotal: { amountMinor: net, currencyCode: "CAD" },
    name: reference,
  });
  const batch = (comps: unknown[]) => ({ compedItems: comps }) as unknown as Batch;
  const round = (subtotal: string) => ({
    orderBatchReference: "r1",
    subtotalMinor: subtotal,
    taxMinor: "0",
    totalMinor: subtotal,
  });
  const comp = (reference: string, more: Record<string, unknown> = {}) => ({
    orderItemReference: reference,
    kind: "Comp",
    percent: null,
    amountMinor: "706",
    reasonCode: "FOOD_QUALITY",
    ...more,
  });
  const cucumber = line("cucumber", "625"),
    milk = line("milk", "325"),
    noodles = line("noodles", "2500", 2);
  // Comped whole: $0.00, "Comped"; the soy milk is not comped.
  expect(
    roundDishComps(batch([comp("cucumber")]), [cucumber, milk] as unknown as Lines, round("325")),
  ).toEqual(new Map([["cucumber", { afterMinor: 0n, word: "Comped" }]]));
  // 1 of 2 comped: the line keeps what the bill still charges for it.
  expect(
    roundDishComps(
      batch([comp("noodles", { compedQuantity: 1, lineQuantity: 2 })]),
      [noodles, milk] as unknown as Lines,
      round(String(1250 + 325)),
    ),
  ).toEqual(new Map([["noodles", { afterMinor: 1250n, word: "1 of 2 comped" }]]));
  // A percent off: what the bill took off is that dish's.
  expect(
    roundDishComps(
      batch([comp("cucumber", { kind: "Percent", percent: 20 })]),
      [cucumber, milk] as unknown as Lines,
      round(String(500 + 325)),
    ),
  ).toEqual(new Map([["cucumber", { afterMinor: 500n, word: "20% off" }]]));
  // Two dishes discounted in part can't be told apart: the round keeps its before-tax line.
  expect(
    roundDishComps(
      batch([
        comp("cucumber", { kind: "Percent", percent: 20 }),
        comp("milk", { kind: "Percent", percent: 20 }),
      ]),
      [cucumber, milk] as unknown as Lines,
      round("760"),
    ),
  ).toBeNull();
  // Figures that do not agree are never shown as a dish's amount.
  expect(
    roundDishComps(batch([comp("cucumber")]), [cucumber, milk] as unknown as Lines, round("300")),
  ).toBeNull();
  // With the dishes after their comps, the round's lines are the dishes and Tax only.
  const html = text(
    roundBillLines(
      comped,
      [dish("Smashed cucumber", "625")] as unknown as Lines,
      { orderBatchReference: "r1", subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
      "CAD",
      true,
    ),
  );
  expect(html).not.toContain("before tax");
  expect(html).toContain("Tax|");
});
