import { describe, expect, it } from "vitest";
import {
  computeBillTaxRounding,
  type BillTaxRoundingRound,
} from "../application/bill-tax-rounding.js";

const id = (n: number) => `018fb000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const hst = (taxAmountMinor: bigint) => ({
  taxComponentCode: "HST",
  treatment: "Taxable" as const,
  rate: "0.13",
  roundingMode: "HalfUp" as const,
  calculationOrder: 1,
  compoundOnPriorTax: false,
  taxAmountMinor,
});
/** One round with one dish (its own quote: tax rounded on its own). */
const round = (
  n: number,
  netMinor: bigint,
  taxMinor: bigint,
  reduction: BillTaxRoundingRound["items"][number]["reduction"] = null,
): BillTaxRoundingRound => ({
  orderReference: id(1),
  orderBatchReference: id(100 + n),
  items: [{ orderItemReference: id(200 + n), netMinor, taxComponents: [hst(taxMinor)], reduction }],
});

describe("WP-2423 DEC-TAX-WHOLE-RECEIPT: the bill's tax rounding", () => {
  // The value the code gave in src/domain before it moved to src/application (full regression
  // 2026-11-02): amounts and the digest kept on the receipt must never change with a move. Rule
  // version 2 (v15 batch 9: a merged bill's rounding on the Order holding it) changed the basis
  // (it names the rule and the carrier); version 1 gave sha256:f860907f…be457ae. The amounts of a
  // bill with no carrier named are those of version 1.
  it("gives the recorded result for two taxes, a compound and a comp", () => {
    const tax = (code: string, rate: string, order: number, taxAmountMinor: bigint) => ({
      taxComponentCode: code,
      treatment: "Taxable" as const,
      rate,
      roundingMode: "HalfUp" as const,
      calculationOrder: order,
      compoundOnPriorTax: order === 2,
      taxAmountMinor,
    });
    const result = computeBillTaxRounding([
      {
        orderReference: "o1",
        orderBatchReference: "b1",
        items: [
          {
            orderItemReference: "i1",
            netMinor: 333n,
            reduction: null,
            taxComponents: [tax("GST", "0.05", 1, 17n), tax("PST", "0.08", 2, 28n)],
          },
          {
            orderItemReference: "i2",
            netMinor: 1099n,
            reduction: { netMinor: 99n, taxMinor: 5n },
            taxComponents: [tax("GST", "0.05", 1, 55n), tax("PST", "0.08", 2, 92n)],
          },
        ],
      },
      {
        orderReference: "o2",
        orderBatchReference: "b2",
        items: [
          {
            orderItemReference: "i3",
            netMinor: 777n,
            reduction: null,
            taxComponents: [tax("GST", "0.05", 1, 39n), tax("PST", "0.08", 2, 65n)],
          },
        ],
      },
    ]);
    expect(result).toEqual({
      totalMinor: -7n,
      lines: [
        {
          orderReference: "o1",
          orderBatchReference: "b1",
          taxComponentCode: "GST",
          amountMinor: -3n,
        },
        {
          orderReference: "o1",
          orderBatchReference: "b1",
          taxComponentCode: "PST",
          amountMinor: -4n,
        },
      ],
      basisDigest: "sha256:4230790695bcf863b1cc04c993600e6b41b70863607168203ba1c0df49163847",
    });
  });

  it("brings three rounds of $1.05 (14¢ tax each) to the whole bill's 41¢", () => {
    const result = computeBillTaxRounding([
      round(1, 105n, 14n),
      round(2, 105n, 14n),
      round(3, 105n, 14n),
    ]);
    // 315 × 13% = 40.95 → 41¢; the rounds were charged 42¢.
    expect(result.totalMinor).toBe(-1n);
    expect(result.lines).toEqual([
      {
        orderReference: id(1),
        orderBatchReference: id(103),
        taxComponentCode: "HST",
        amountMinor: -1n,
      },
    ]);
  });

  it("adds what rounding each round down left out, never more than the whole bill needs", () => {
    // 3¢ dishes: 0.39¢ tax each rounds to 0; the bill's 1.17¢ rounds to 1¢.
    const result = computeBillTaxRounding([round(1, 3n, 0n), round(2, 3n, 0n), round(3, 3n, 0n)]);
    expect(result.totalMinor).toBe(1n);
    expect(result.lines.map((line) => line.amountMinor)).toEqual([1n]);
  });

  it("is nothing when the rounds already add up, and follows comps", () => {
    expect(computeBillTaxRounding([round(1, 1000n, 130n), round(2, 1000n, 130n)]).totalMinor).toBe(
      0n,
    );
    // A dish comped in full leaves the bill's taxable amount: only the other round counts.
    const comped = computeBillTaxRounding([
      round(1, 105n, 14n, { netMinor: 105n, taxMinor: 14n }),
      round(2, 105n, 14n),
    ]);
    expect(comped.totalMinor).toBe(0n);
  });

  it("is deterministic: the same bill gives the same lines and basis", () => {
    const rounds = [round(1, 105n, 14n), round(2, 105n, 14n), round(3, 105n, 14n)];
    expect(computeBillTaxRounding(rounds)).toEqual(computeBillTaxRounding(rounds));
    expect(computeBillTaxRounding(rounds).basisDigest).not.toBe(
      computeBillTaxRounding(rounds.slice(0, 2)).basisDigest,
    );
  });

  it("charges exactly round(Σ taxable × rate) for any mix of rounds", () => {
    const prices = [105n, 299n, 1n, 1349n, 875n, 33n, 450n];
    for (let size = 1; size <= prices.length; size++) {
      const rounds = prices
        .slice(0, size)
        .map((net, index) => round(index + 1, net, (net * 13n + 50n) / 100n));
      const charged = rounds.reduce(
        (sum, r) => sum + (r.items[0]?.taxComponents[0]?.taxAmountMinor ?? 0n),
        0n,
      );
      const taxable = rounds.reduce((sum, r) => sum + (r.items[0]?.netMinor ?? 0n), 0n);
      const whole = (taxable * 13n + 50n) / 100n;
      const result = computeBillTaxRounding(rounds);
      expect(charged + result.totalMinor).toBe(whole);
      expect(result.lines.reduce((sum, line) => sum + line.amountMinor, 0n)).toBe(
        result.totalMinor,
      );
    }
  });
  // v15 batch 9 (original finding L5): table B merged into table A, one $12.50 dish each at 13%
  // HST. Each round was charged $1.63; the whole bill's tax is $3.25, so $0.01 comes off. Version 1
  // put it on B's round (B's part $14.12 while B's Order said $14.13); it is on A's round now.
  const merged = (order: number, n: number, netMinor: bigint, taxMinor: bigint) => ({
    ...round(n, netMinor, taxMinor),
    orderReference: id(order),
  });
  it("puts a merged bill's rounding on the rounds of the Order holding the bill", () => {
    const rounds = [merged(1, 1, 1250n, 163n), merged(2, 2, 1250n, 163n)];
    const v1 = computeBillTaxRounding(rounds);
    expect(v1.lines.map((line) => [line.orderReference, line.amountMinor])).toEqual([[id(2), -1n]]);
    for (const order of [1, 2]) {
      const result = computeBillTaxRounding(rounds, { carrierOrderReference: id(order) });
      expect(result.totalMinor).toBe(-1n);
      expect(result.lines.map((line) => [line.orderReference, line.amountMinor])).toEqual([
        [id(order), -1n],
      ]);
      // Which Order carries it is part of the basis: a new holder records a new version.
      expect(result.basisDigest).not.toBe(v1.basisDigest);
    }
  });

  it("shares a merged bill's rounding over the holder's own rounds by largest remainder", () => {
    // A: two rounds of $1.05 (14¢ each); B: one $1.05 round. Whole: 40.95 → 41¢, charged 42¢.
    const rounds = [merged(1, 1, 105n, 14n), merged(2, 2, 105n, 14n), merged(1, 3, 105n, 14n)];
    const result = computeBillTaxRounding(rounds, { carrierOrderReference: id(1) });
    expect(result.totalMinor).toBe(-1n);
    expect(result.lines.every((line) => line.orderReference === id(1))).toBe(true);
    expect(result.lines.reduce((sum, line) => sum + line.amountMinor, 0n)).toBe(-1n);
  });

  it("shares it over every round when the holder can't carry it without negative tax", () => {
    // A ordered a 1¢ dish (no tax charged); B three $1.05 rounds. Whole: 3.16 × 13% = 41¢,
    // charged 42¢: A's round would be taxed −1¢, so the rounding is shared over the bill.
    const rounds = [
      merged(1, 1, 1n, 0n),
      merged(2, 2, 105n, 14n),
      merged(2, 3, 105n, 14n),
      merged(2, 4, 105n, 14n),
    ];
    const result = computeBillTaxRounding(rounds, { carrierOrderReference: id(1) });
    expect(result.totalMinor).toBe(-1n);
    expect(result.lines.map((line) => line.orderReference)).toEqual([id(2)]);
    // A holder with no round on the bill: shared over every round too.
    expect(
      computeBillTaxRounding(rounds.slice(1), { carrierOrderReference: id(1) }).totalMinor,
    ).toBe(-1n);
  });

  it("charges the whole-bill tax exactly whoever holds the bill", () => {
    const prices = [105n, 299n, 1n, 1349n, 875n, 33n, 450n];
    for (let size = 1; size <= prices.length; size++)
      for (const holder of [1, 2]) {
        const rounds = prices
          .slice(0, size)
          .map((net, index) => merged((index % 2) + 1, index + 1, net, (net * 13n + 50n) / 100n));
        const charged = rounds.reduce(
          (sum, r) => sum + (r.items[0]?.taxComponents[0]?.taxAmountMinor ?? 0n),
          0n,
        );
        const taxable = rounds.reduce((sum, r) => sum + (r.items[0]?.netMinor ?? 0n), 0n);
        const result = computeBillTaxRounding(rounds, { carrierOrderReference: id(holder) });
        expect(charged + result.totalMinor).toBe((taxable * 13n + 50n) / 100n);
        // No round's tax goes below nothing.
        for (const r of rounds)
          expect(
            (r.items[0]?.taxComponents[0]?.taxAmountMinor ?? 0n) +
              result.lines
                .filter((line) => line.orderBatchReference === r.orderBatchReference)
                .reduce((sum, line) => sum + line.amountMinor, 0n),
          ).toBeGreaterThanOrEqual(0n);
      }
  });
});
