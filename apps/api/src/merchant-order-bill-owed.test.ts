import { expect, it } from "vitest";
import {
  billOwedMinor,
  billRemovedMinor,
  orderBillWithRemoved,
  type OrderBillPrice,
} from "./merchant-order-bill-owed.js";

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
// Table A (Order 1) has rounds 1 and 2; table B (Order 2) merged into it with round 3.
const merged = [
  { orderReference: id(1), orderBatchReference: id(101) },
  { orderReference: id(1), orderBatchReference: id(102) },
  { orderReference: id(2), orderBatchReference: id(103) },
];

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

it("v15 b19: on a merged bill, a dish taken off one table's Order takes off what the merged bill went down by", () => {
  const off = [
    [id(1), new Set([id(202)])],
    [id(2), new Set<string>()],
  ] as const;
  // With it the merged bill is $42.38, without it $28.25 ($25.00 + $3.25 tax): $14.13 came off.
  expect(billRemovedMinor(id(1), merged, prices, new Map(), off, id(1))).toBe(1413n);
  // Order 1's own rounds alone would say $14.12: a cent off the merged bill it was on.
  expect(
    orderBillWithRemoved(id(1), [id(101), id(102)], prices.slice(0, 2), new Map(), off[0][1]),
  ).toEqual({ owedMinor: 1413n, removedMinor: 1412n });
  // Table B's Order had nothing taken off.
  expect(billRemovedMinor(id(1), merged, prices, new Map(), off, id(2))).toBeNull();
});

it("v15 b19: two tables' dishes taken off a merged bill add up to what the bill went down by", () => {
  const off = [
    [id(1), new Set([id(202)])],
    [id(2), new Set([id(203)])],
  ] as const;
  const a = billRemovedMinor(id(1), merged, prices, new Map(), off, id(1));
  const b = billRemovedMinor(id(1), merged, prices, new Map(), off, id(2));
  // $42.38 down to $14.13 (round 1 alone): $28.25 off in all, $14.13 then $14.12, never 2 × $14.13.
  expect([a, b]).toEqual([1413n, 1412n]);
  expect((a ?? 0n) + (b ?? 0n)).toBe(4238n - 1413n);
});

// v15 b26 live25 (TM2 'L25 TCP (TEST)'): 3 rounds of Soy milk $3.25 ($0.42 tax) + Smashed cucumber
// $6.25 ($0.82 tax on its round's quote), $32.21 on the bill (whole-bill tax $3.71, a cent less).
const line = (n: number, round: number, net: bigint, tax: bigint): OrderBillPrice => ({
  orderItemReference: id(300 + n),
  orderBatchReference: id(100 + round),
  subtotal: { amountMinor: net },
  discountMinor: 0n,
  total: { amountMinor: net + tax },
  taxComponents: [
    {
      taxComponentCode: "HST",
      treatment: "Taxable",
      rate: "0.13",
      roundingMode: "HalfUp",
      calculationOrder: 1,
      compoundOnPriorTax: false,
      taxAmountMinor: tax,
    },
  ],
});
const live = [1, 2, 3].flatMap((round) => [
  line(round * 2 - 1, round, 325n, 42n),
  line(round * 2, round, 625n, 82n),
]);
const liveRounds = rounds;
// The manager's comp of round 1's cucumber, as recorded: net 625, tax 81 (its cent of the bill).
const comp = new Map([
  [id(302), { totalMinor: 706n, netMinor: 625n, taxMinor: 81n, taxRoundingMinor: -1n }],
]);

it("v15 b26: taken off is what the bill went down by at each take-off ($3.68 + $10.73), not recomputed with a later comp", () => {
  const off = (lines: readonly number[]) => new Set(lines.map((n) => id(300 + n)));
  // In the order it happened: $32.21, Soy milk off round 1 → $28.53, round 2 off → $17.80.
  const noComp = new Map();
  expect(orderBillWithRemoved(id(1), liveRounds, live, noComp, new Set()).owedMinor).toBe(3221n);
  expect(orderBillWithRemoved(id(1), liveRounds, live, noComp, off([1])).owedMinor).toBe(2853n);
  expect(orderBillWithRemoved(id(1), liveRounds, live, noComp, off([1, 3, 4]))).toEqual({
    owedMinor: 1780n,
    removedMinor: 1441n,
  });
  // Then the $7.06 comp: $10.74 left. Taken off stays $14.41, so 10.74 + 7.06 + 14.41 = 32.21.
  const now = orderBillWithRemoved(id(1), liveRounds, live, comp, off([1, 3, 4]));
  expect(now).toEqual({ owedMinor: 1074n, removedMinor: 1441n });
  expect(now.owedMinor + 706n + (now.removedMinor ?? 0n)).toBe(3221n);
});

it("v15 b26: a comp first and a take-off after: taken off is what the take-off button took off then", () => {
  const off = new Set([id(301), id(303), id(304)]);
  // The comp was made on the whole $32.21 bill (its record is what the bill went down by then).
  const first = new Map([
    [id(302), { totalMinor: 707n, netMinor: 625n, taxMinor: 82n, taxRoundingMinor: 0n }],
  ]);
  expect(orderBillWithRemoved(id(1), liveRounds, live, first, new Set()).owedMinor).toBe(2514n);
  // What the take-off button said: the bill as it stood less the bill without those dishes.
  const button =
    orderBillWithRemoved(id(1), liveRounds, live, first, new Set()).owedMinor -
    orderBillWithRemoved(id(1), liveRounds, live, first, off).owedMinor;
  const now = orderBillWithRemoved(id(1), liveRounds, live, first, off);
  expect(now.removedMinor).toBe(button);
  expect(now.owedMinor + 707n + (now.removedMinor ?? 0n)).toBe(3221n);
});

it("v15 b26: on a merged bill with a comp, the tables' taken-off shares add up to ordered − Total − comps", () => {
  // Table A (Order 1) rounds 1–2, table B (Order 2) round 3 merged in; dishes as live25.
  const rounds3 = [
    { orderReference: id(1), orderBatchReference: id(101) },
    { orderReference: id(1), orderBatchReference: id(102) },
    { orderReference: id(2), orderBatchReference: id(103) },
  ];
  const off = [
    [id(1), new Set([id(301), id(303), id(304)])],
    [id(2), new Set([id(305)])],
  ] as const;
  const a = billRemovedMinor(id(1), rounds3, live, comp, off, id(1));
  const b = billRemovedMinor(id(1), rounds3, live, comp, off, id(2));
  const kept = live.filter(
    (price) => ![id(301), id(303), id(304), id(305)].includes(String(price.orderItemReference)),
  );
  const owed = billOwedMinorOf(rounds3, kept);
  expect(owed + 706n + (a ?? 0n) + (b ?? 0n)).toBe(3221n);
});

function billOwedMinorOf(
  billRounds: readonly { orderReference: string; orderBatchReference: string }[],
  kept: readonly OrderBillPrice[],
) {
  return billOwedMinor(id(1), billRounds, kept, comp);
}
