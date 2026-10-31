import { describe, expect, it } from "vitest";
import { computeBillTaxRounding, type BillTaxRoundingRound } from "../domain/bill-tax-rounding.js";

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
});
