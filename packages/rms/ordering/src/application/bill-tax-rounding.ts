import { createHash } from "node:crypto";
import { roundRational, taxRateRatio, type RoundingMode } from "@rms/pricing";

/**
 * WP-2423 DEC-TAX-WHOLE-RECEIPT step 2 (coordinator 2026-10-30, Owner authorized): a table's bill
 * is one receipt. Its tax per tax type is round(Σ taxable × rate) over every dish on the bill once;
 * the rounds were each priced (and their tax rounded) on their own, so the bill's "Tax rounding" is
 * that whole-bill tax allocated to the rounds by largest remainder, minus the tax each round was
 * charged. Normally a cent or two, positive or negative; never more than whole-bill rounding needs.
 *
 * A dish's taxable amount is what it is charged before tax after any comp or discount; its charged
 * tax per tax type is its frozen tax less the comp's tax, shared across tax types by largest
 * remainder. A compound tax's basis includes the dish's charged earlier tax.
 */
export const billTaxRoundingRule = Object.freeze({ code: "DEC_TAX_WHOLE_RECEIPT", version: 1 });

export interface BillTaxRoundingItem {
  readonly orderItemReference: string;
  /** Price before tax (subtotal less any discount on the dish's own snapshot). */
  readonly netMinor: bigint;
  readonly taxComponents: readonly {
    readonly taxComponentCode: string;
    readonly treatment: "Taxable" | "Exempt" | "ZeroRated";
    readonly rate: string;
    readonly roundingMode: RoundingMode;
    readonly calculationOrder: number;
    readonly compoundOnPriorTax: boolean;
    readonly taxAmountMinor: bigint;
  }[];
  /** A comp or discount on the dish: what it took off the net and the tax (null: none). */
  readonly reduction: { readonly netMinor: bigint; readonly taxMinor: bigint } | null;
}

export interface BillTaxRoundingRound {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly items: readonly BillTaxRoundingItem[];
}

export interface BillTaxRoundingLine {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly taxComponentCode: string;
  readonly amountMinor: bigint;
}

export interface BillTaxRounding {
  readonly totalMinor: bigint;
  readonly lines: readonly BillTaxRoundingLine[];
  /** The bill's taxable amounts and charged taxes this was computed from. */
  readonly basisDigest: string;
}

/** Largest remainder: floor shares, then the leftover units to the largest remainders (ties: order). */
function allocate(total: bigint, weights: readonly bigint[]): readonly bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n) return weights.map(() => 0n);
  const negative = total < 0n;
  const magnitude = negative ? -total : total;
  const base = weights.map((weight) => (magnitude * weight) / sum);
  let left = magnitude - base.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((weight, index) => ({ index, remainder: (magnitude * weight) % sum }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  const result = [...base];
  for (const entry of order) {
    if (left <= 0n) break;
    result[entry.index] = (result[entry.index] ?? 0n) + 1n;
    left -= 1n;
  }
  return negative ? result.map((value) => -value) : result;
}

const fail = (): never => {
  throw new Error("BILL_TAX_ROUNDING_INVALID");
};

export function computeBillTaxRounding(rounds: readonly BillTaxRoundingRound[]): BillTaxRounding {
  // Per tax type (and its rounding mode): each round's exact tax and charged tax.
  interface Group {
    readonly mode: RoundingMode;
    readonly code: string;
    denominator: bigint;
    readonly perRound: Map<number, { numerator: bigint; denominator: bigint; charged: bigint }>;
  }
  const groups = new Map<string, Group>();
  rounds.forEach((round, roundIndex) => {
    for (const item of round.items) {
      if (item.netMinor < 0n) fail();
      const reduction = item.reduction ?? { netMinor: 0n, taxMinor: 0n };
      const net = item.netMinor - reduction.netMinor;
      if (net < 0n || reduction.taxMinor < 0n) fail();
      const components = [...item.taxComponents].sort(
        (a, b) => a.calculationOrder - b.calculationOrder,
      );
      // The comp's tax, shared across the dish's tax types by largest remainder.
      const compTax = allocate(
        reduction.taxMinor,
        components.map((component) => component.taxAmountMinor),
      );
      let priorCharged = 0n;
      components.forEach((component, index) => {
        const charged = component.taxAmountMinor - (compTax[index] ?? 0n);
        if (charged < 0n) fail();
        const ratio: { readonly numerator: bigint; readonly denominator: bigint } = taxRateRatio(
          component.rate as never,
        );
        const basis: bigint = net + (component.compoundOnPriorTax ? priorCharged : 0n);
        const numerator: bigint =
          component.treatment === "Taxable" && ratio.numerator !== 0n
            ? basis * ratio.numerator
            : 0n;
        const key = component.taxComponentCode + "\u0000" + component.roundingMode;
        const group =
          groups.get(key) ??
          ({
            mode: component.roundingMode,
            code: component.taxComponentCode,
            denominator: 1n,
            perRound: new Map(),
          } satisfies Group);
        groups.set(key, group);
        const entry: { numerator: bigint; denominator: bigint; charged: bigint } =
          group.perRound.get(roundIndex) ?? {
            numerator: 0n,
            denominator: 1n,
            charged: 0n,
          };
        // Exact sum of fractions with power-of-ten denominators: keep the largest denominator.
        const denominator =
          ratio.denominator > entry.denominator ? ratio.denominator : entry.denominator;
        entry.numerator =
          entry.numerator * (denominator / entry.denominator) +
          numerator * (denominator / ratio.denominator);
        entry.denominator = denominator;
        entry.charged += charged;
        group.perRound.set(roundIndex, entry);
        if (denominator > group.denominator) group.denominator = denominator;
        priorCharged += charged;
      });
    }
  });
  const lines: BillTaxRoundingLine[] = [];
  for (const group of [...groups.values()].sort((a, b) =>
    a.code === b.code ? (a.mode < b.mode ? -1 : 1) : a.code < b.code ? -1 : 1,
  )) {
    const indexes = [...group.perRound.keys()].sort((a, b) => a - b);
    const scaled = indexes.map((index) => {
      const entry = group.perRound.get(index) as { numerator: bigint; denominator: bigint };
      return entry.numerator * (group.denominator / entry.denominator);
    });
    const whole = roundRational(
      scaled.reduce((a, b) => a + b, 0n),
      group.denominator,
      group.mode,
    );
    const shares = allocate(whole, scaled);
    indexes.forEach((index, position) => {
      const entry = group.perRound.get(index) as { charged: bigint };
      const amount = (shares[position] ?? 0n) - entry.charged;
      if (amount === 0n) return;
      const round = rounds[index] as BillTaxRoundingRound;
      lines.push(
        Object.freeze({
          orderReference: round.orderReference,
          orderBatchReference: round.orderBatchReference,
          taxComponentCode: group.code,
          amountMinor: amount,
        }),
      );
    });
  }
  const basisDigest =
    "sha256:" +
    createHash("sha256")
      .update(
        JSON.stringify([
          billTaxRoundingRule,
          rounds.map((round) => [
            round.orderReference,
            round.orderBatchReference,
            round.items.map((item) => [
              item.orderItemReference,
              item.netMinor.toString(),
              item.reduction === null
                ? null
                : [item.reduction.netMinor.toString(), item.reduction.taxMinor.toString()],
              item.taxComponents.map((component) => [
                component.taxComponentCode,
                component.treatment,
                component.rate,
                component.roundingMode,
                component.calculationOrder,
                component.compoundOnPriorTax,
                component.taxAmountMinor.toString(),
              ]),
            ]),
          ]),
        ]),
      )
      .digest("hex");
  return Object.freeze({
    totalMinor: lines.reduce((sum, line) => sum + line.amountMinor, 0n),
    lines: Object.freeze(lines),
    basisDigest,
  });
}
