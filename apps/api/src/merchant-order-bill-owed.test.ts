import { expect, it } from "vitest";
import { orderBillWithRemoved, type OrderBillPrice } from "./merchant-order-bill-owed.js";

const id = (n: number) => `018fb000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
// One $12.50 Beef noodles per round, 13 % HST: $1.63 tax on its own quote, $14.13.
const noodles = (n: number): OrderBillPrice => ({
  orderItemReference: id(200 + n),
  orderBatchReference: id(100 + n),
  subtotal: { amountMinor: 1250n },
  discountMinor: 0n,
  total: { amountMinor: 1413n },
  taxComponents: [
    {
      taxComponentCode: "HST",
      treatment: "Taxable",
      rate: "0.13",
      roundingMode: "HalfUp",
      calculationOrder: 1,
      compoundOnPriorTax: false,
      taxAmountMinor: 163n,
    },
  ],
});
const rounds = [id(101), id(102), id(103)];
const prices = [noodles(1), noodles(2), noodles(3)];

it("v15 b19: three $12.50 rounds come to $42.38 on the bill (tax $4.88 on the whole bill)", () => {
  expect(orderBillWithRemoved(id(1), rounds, prices, new Map(), new Set())).toEqual({
    owedMinor: 4238n,
    removedMinor: null,
  });
});

it("v15 b19: taking every round off takes off the $42.38 bill it replaced, never 3 × $14.13", () => {
  const all = new Set(prices.map((price) => String(price.orderItemReference)));
  expect(orderBillWithRemoved(id(1), rounds, prices, new Map(), all)).toEqual({
    owedMinor: 0n,
    removedMinor: 4238n,
  });
});

it("v15 b19: what is taken off and what is left always add up to the bill", () => {
  const one = new Set([id(203)]);
  const result = orderBillWithRemoved(id(1), rounds, prices, new Map(), one);
  // $25.00 at 13 % is $3.25 once: $28.25 left, $14.13 taken off.
  expect(result).toEqual({ owedMinor: 2825n, removedMinor: 1413n });
  expect(result.owedMinor + (result.removedMinor ?? 0n)).toBe(4238n);
});
