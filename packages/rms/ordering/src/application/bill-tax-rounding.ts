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
export const billTaxRoundingRule = Object.freeze({ code: "DEC_TAX_WHOLE_RECEIPT", version: 2 });
/*
 * Rule version 2 (v15 batch 9, docs/spec/design/tax-whole-receipt.md "并桌"): a bill holding the
 * Orders of tables merged into it puts its whole tax rounding on the rounds of the Order that holds
 * the bill (the carrier), shared among them by largest remainder; a merged table's rounds keep what
 * they ordered. Version 1 shared it over every round of the bill, so a merged table's part could
 * differ by a cent from what its Order said it ordered. A bill of one Order allocates as before.
 */

/**
 * b28 (2026-11-17, v15 live26): the whole bill's rounding sits on the last round that can take it
 * and every other round keeps the tax it was charged, so a round's figure does not move by a cent
 * when another round changes. A round takes at most what its own dishes could have caused (half a
 * cent a dish, rounded up, plus one for the bill's own rounding: billTaxRoundingRoundLimitMinor);
 * the rest goes back a round at a time. Same bill, same tax and same charge as before; only which
 * round shows the cent differs. The rule version stays 2 (the database allows 1 and 2, and nothing
 * reads the sharing back from the version: every recorded line names its round); the sharing is
 * named in the basis, so the version recorded for an unpaid bill is superseded.
 */
export const billTaxRoundingAllocation = "LastRoundBounded";
/** b39: how a merged table's Order is charged on the bill it joined (named in a merged basis). */
export const billTaxRoundingMergedOrders = "MergedOrderKeepsOwnBill";
/** b28: the most of the bill's rounding a round with `dishes` taxed dishes takes, per tax type. */
export const billTaxRoundingRoundLimitMinor = (dishes: number): bigint =>
  BigInt(Math.ceil(dishes / 2) + 1);

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
  /**
   * A comp or discount on the dish: what it took off the net and the tax (null: none).
   * `taxRoundingMinor` is the part of that tax that is the whole bill's cent (DEC-COMP-BILL-CENT;
   * absent: 0). A round of a merged table's Order gives it back in its rounding line, so a dish
   * comped in full there still comes to nothing.
   */
  readonly reduction: {
    readonly netMinor: bigint;
    readonly taxMinor: bigint;
    readonly taxRoundingMinor?: bigint;
  } | null;
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
/**
 * v15 b16 (DEC-COMP-BILL-CENT): the most of the whole bill's tax rounding one reduction puts on
 * one dish, in cents either way. A bill's tax rounding moves by at most about a cent per tax type
 * (two in Canada) plus one from a compound tax when dishes come off it, and the shares go a cent
 * at a time over every dish of the reduction, so a dish takes one or two at most. The database
 * holds the same bound (migration 2000_996), so a defect can never record more than $0.09 of a
 * dish's tax beyond its own share.
 */
export const billTaxRoundingShareLimitMinor = 9n;
/** A tax type the dish is taxed at (Taxable, at a rate above nothing). */
const taxedComponent = (component: BillTaxRoundingItem["taxComponents"][number]) =>
  component.treatment === "Taxable" && taxRateRatio(component.rate as never).numerator !== 0n;

export function computeBillTaxRounding(
  rounds: readonly BillTaxRoundingRound[],
  options: {
    /**
     * The Order that holds the bill: its rounds carry the whole rounding. When it has no round
     * with a tax type, that tax type's rounding is shared over every round (absent: every round).
     */
    readonly carrierOrderReference?: string;
  } = {},
): BillTaxRounding {
  // Per tax type (and its rounding mode): each round's exact tax and charged tax.
  interface Group {
    readonly mode: RoundingMode;
    readonly code: string;
    denominator: bigint;
    readonly perRound: Map<
      number,
      { numerator: bigint; denominator: bigint; charged: bigint; given: bigint; dishes: number }
    >;
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
      // The comp's tax, shared across the dish's tax types by largest remainder. v15 b16: a dish
      // too cheap to have been charged tax (a few cents) can still take the whole bill's cent;
      // it goes to its taxed tax types.
      const weights = components.map((component) => component.taxAmountMinor);
      const shareWeights = weights.some((weight) => weight > 0n)
        ? weights
        : components.map((component) => (taxedComponent(component) ? 1n : 0n));
      const compTax = allocate(reduction.taxMinor, shareWeights);
      const roundingShare = reduction.taxRoundingMinor ?? 0n;
      if (
        roundingShare < -billTaxRoundingShareLimitMinor ||
        roundingShare > billTaxRoundingShareLimitMinor
      )
        fail();
      const givenBack = allocate(roundingShare, shareWeights);
      let priorCharged = 0n;
      components.forEach((component, index) => {
        // v15 b16 (DEC-COMP-BILL-CENT): a reduction's tax may hold the whole bill's cent beyond
        // the dish's own tax, so a fully comped dish can be charged a cent or two below nothing;
        // the bill's tax rounding gives it back (the bill never goes below its whole tax).
        const charged = component.taxAmountMinor - (compTax[index] ?? 0n);
        if (charged < -billTaxRoundingShareLimitMinor) fail();
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
        const entry: {
          numerator: bigint;
          denominator: bigint;
          charged: bigint;
          given: bigint;
          dishes: number;
        } = group.perRound.get(roundIndex) ?? {
          numerator: 0n,
          denominator: 1n,
          charged: 0n,
          given: 0n,
          dishes: 0,
        };
        // Exact sum of fractions with power-of-ten denominators: keep the largest denominator.
        const denominator =
          ratio.denominator > entry.denominator ? ratio.denominator : entry.denominator;
        entry.numerator =
          entry.numerator * (denominator / entry.denominator) +
          numerator * (denominator / ratio.denominator);
        entry.denominator = denominator;
        entry.charged += charged;
        entry.given += givenBack[index] ?? 0n;
        if (numerator > 0n) entry.dishes += 1;
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
    const charged = indexes.map(
      (index) => (group.perRound.get(index) as { charged: bigint }).charged,
    );
    // What a round that does not carry keeps: what it was charged, with the whole bill's cent its
    // reductions took given back (b16: a merged table's dish comped in full comes to nothing).
    const kept = indexes.map((index) => {
      const entry = group.perRound.get(index) as { charged: bigint; given: bigint };
      return entry.charged + entry.given;
    });
    const carries = indexes.map(
      (index) =>
        options.carrierOrderReference === undefined ||
        (rounds[index] as BillTaxRoundingRound).orderReference === options.carrierOrderReference,
    );
    // The rounds that do not carry keep what they were charged; the carrier's rounds take the rest
    // of the whole-bill tax, by largest remainder of their exact shares (rule v1/v2; now only the
    // fallback when no round can carry it on its own).
    const sharesOver = (carried: readonly boolean[]) => {
      const left =
        whole - kept.reduce((sum, value, position) => (carried[position] ? sum : sum + value), 0n);
      const carrierShares = allocate(
        left,
        scaled.filter((_, position) => carried[position]),
      );
      let next = 0;
      return indexes.map((_, position) =>
        carried[position] ? (carrierShares[next++] ?? 0n) : (kept[position] ?? 0n),
      );
    };
    // b28 (docs/spec/design/tax-whole-receipt.md "b28"): each round keeps the tax it was charged,
    // so a round staff did not touch reads the same before and after a dish comes off another
    // round; the whole bill's rounding sits on the last of the carrier's rounds taxed at this tax
    // type, up to what that round's own dishes could have caused (billTaxRoundingRoundLimitMinor)
    // and never taking its tax below nothing; what it can't take goes to the round before it, and
    // so on (then the same over every round of the bill). A comp's cent (b16) is already on the
    // comped round's charged tax, so the comped round goes down by exactly the comp. A round with
    // nothing taxable left, or charged below nothing by a comp's cent, keeps that cent given back
    // (it comes to nothing).
    const stays = indexes.map((_, position) => {
      const own = charged[position] ?? 0n;
      return carries[position] && (scaled[position] ?? 0n) > 0n && own >= 0n
        ? own
        : (kept[position] ?? 0n);
    });
    // b39: `counted` limits the tax `target` is compared with to some rounds (one merged Order).
    const fromTheLast = (
      candidates: readonly boolean[],
      base: readonly bigint[] = stays,
      target: bigint = whole,
      counted: readonly boolean[] = indexes.map(() => true),
    ) => {
      const result = [...base];
      let left =
        target - base.reduce((sum, value, position) => (counted[position] ? sum + value : sum), 0n);
      for (let position = indexes.length - 1; position >= 0 && left !== 0n; position -= 1) {
        if (!candidates[position] || (scaled[position] ?? 0n) <= 0n) continue;
        const own = result[position] ?? 0n;
        const limit = billTaxRoundingRoundLimitMinor(
          (group.perRound.get(indexes[position] as number) as { dishes: number }).dishes,
        );
        const most = left > 0n ? (left < limit ? left : limit) : left > -limit ? left : -limit;
        const take = own + most < 0n ? -own : most;
        result[position] = own + take;
        left -= take;
      }
      return left === 0n ? result : null;
    };
    const everyRound = indexes.map(() => true);
    // b39 (docs/spec/design/tax-whole-receipt.md "b39"): a merged table's Order keeps the bill it
    // had on its own: its rounds take that Order's own whole tax (worked out on its dishes, placed
    // as above), so what its guests saw before the merge does not move by a cent. The carrier's
    // rounds take the rest of the whole bill's tax, so the bill stays exact.
    const ownBase = [...stays];
    if (options.carrierOrderReference !== undefined)
      for (const orderReference of new Set(
        indexes.map((index) => (rounds[index] as BillTaxRoundingRound).orderReference),
      )) {
        if (orderReference === options.carrierOrderReference) continue;
        const mine = indexes.map(
          (index) => (rounds[index] as BillTaxRoundingRound).orderReference === orderReference,
        );
        const own = indexes.map((_, position) => {
          const value = charged[position] ?? 0n;
          return (scaled[position] ?? 0n) > 0n && value >= 0n ? value : (kept[position] ?? 0n);
        });
        const ownWhole = roundRational(
          scaled.reduce((sum, value, position) => (mine[position] ? sum + value : sum), 0n),
          group.denominator,
          group.mode,
        );
        const alone = fromTheLast(mine, own, ownWhole, mine);
        if (alone !== null)
          mine.forEach((isMine, position) => {
            if (isMine) ownBase[position] = alone[position] ?? 0n;
          });
      }
    const shares =
      fromTheLast(carries, ownBase) ?? fromTheLast(everyRound) ?? sharesOver(everyRound);
    indexes.forEach((index, position) => {
      const amount = (shares[position] ?? 0n) - (charged[position] ?? 0n);
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
          // b28: how the rounding is shared out over the rounds is part of the basis, so a bill
          // recorded with the earlier sharing records a new version before it is paid.
          billTaxRoundingAllocation,
          options.carrierOrderReference ?? null,
          // b39: a merged Order keeps its own bill; a merged bill recorded before records anew.
          ...(options.carrierOrderReference === undefined ? [] : [billTaxRoundingMergedOrders]),
          rounds.map((round) => [
            round.orderReference,
            round.orderBatchReference,
            round.items.map((item) => [
              item.orderItemReference,
              item.netMinor.toString(),
              item.reduction === null
                ? null
                : [
                    item.reduction.netMinor.toString(),
                    item.reduction.taxMinor.toString(),
                    // Only when there is one, so a bill without it keeps its digest.
                    ...((item.reduction.taxRoundingMinor ?? 0n) === 0n
                      ? []
                      : [(item.reduction.taxRoundingMinor as bigint).toString()]),
                  ],
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

/**
 * v15 b16 (DEC-COMP-BILL-CENT, docs/spec/design/comp-bill-cent-b16.md): what one comp, discount or
 * points redemption takes off a table's bill is exactly what the bill goes down by. Each dish's
 * reduction first takes its own share of the dish's tax (half up); the whole bill's tax, worked
 * out once over the bill, can then move by a cent more or less than those shares. That difference
 * is put on the reductions' tax, a cent at a time from the last dish (by reference) backwards, so
 * the bill's tax rounding is the same after the reductions as before them, and
 * Σ reductions + what is still owed = the bill before, to the cent. On a merged bill the dishes of
 * the Order holding it (which carries the rounding) take it first; a merged table's dish that takes
 * it has it given back on its own round, so that round still comes to what it now owes.
 *
 * `rounds` is the bill as it stands (earlier reductions included); `planned` are the new
 * reductions with their dish shares. Returns each planned dish's cent share (0 for most). Only a
 * dish that is taxed (Taxable at a rate) takes a share, and a share never makes a reduction's tax
 * negative.
 */
export function billReductionTaxRoundingShares(
  rounds: readonly BillTaxRoundingRound[],
  planned: readonly {
    readonly orderItemReference: string;
    readonly netMinor: bigint;
    readonly taxMinor: bigint;
  }[],
  options: { readonly carrierOrderReference?: string } = {},
): ReadonlyMap<string, bigint> {
  const shares = new Map<string, bigint>(planned.map((line) => [line.orderItemReference, 0n]));
  if (planned.length === 0) return shares;
  const itemOf = new Map<string, BillTaxRoundingItem>();
  const orderOf = new Map<string, string>();
  for (const round of rounds)
    for (const item of round.items) {
      itemOf.set(item.orderItemReference, item);
      orderOf.set(item.orderItemReference, round.orderReference);
    }
  const before = computeBillTaxRounding(rounds, options).totalMinor;
  const taxed = [...planned]
    .filter((line) => {
      const item = itemOf.get(line.orderItemReference);
      return (
        item !== undefined && item.reduction === null && item.taxComponents.some(taxedComponent)
      );
    })
    // The carrier's dishes last, so they are the first to take a cent.
    .sort((a, b) => {
      const carried = (line: typeof a) =>
        options.carrierOrderReference === undefined ||
        orderOf.get(line.orderItemReference) === options.carrierOrderReference;
      if (carried(a) !== carried(b)) return carried(a) ? 1 : -1;
      return a.orderItemReference < b.orderItemReference ? -1 : 1;
    });
  if (taxed.length === 0) return shares;
  const plannedOf = new Map(planned.map((line) => [line.orderItemReference, line]));
  const after = () =>
    computeBillTaxRounding(
      rounds.map((round) => ({
        ...round,
        items: round.items.map((item) => {
          const line = plannedOf.get(item.orderItemReference);
          if (line === undefined || item.reduction !== null) return item;
          return {
            ...item,
            reduction: {
              netMinor: line.netMinor,
              taxMinor: line.taxMinor + (shares.get(item.orderItemReference) ?? 0n),
              taxRoundingMinor: shares.get(item.orderItemReference) ?? 0n,
            },
          };
        }),
      })),
      options,
    ).totalMinor;
  // Raising a reduction's tax by a cent lowers what the bill charged its dishes by a cent and
  // raises the rounding by one (a compound tax can move once more: a few passes settle it).
  for (let pass = 0; pass < 4; pass += 1) {
    let left = before - after();
    if (left === 0n) break;
    let moved = true;
    while (left !== 0n && moved) {
      moved = false;
      for (let index = taxed.length - 1; index >= 0 && left !== 0n; index -= 1) {
        const line = taxed[index] as (typeof taxed)[number];
        const share = shares.get(line.orderItemReference) ?? 0n;
        if (left > 0n && share < billTaxRoundingShareLimitMinor) {
          shares.set(line.orderItemReference, share + 1n);
          left -= 1n;
          moved = true;
        } else if (
          left < 0n &&
          line.taxMinor + share > 0n &&
          share > -billTaxRoundingShareLimitMinor
        ) {
          shares.set(line.orderItemReference, share - 1n);
          left += 1n;
          moved = true;
        }
      }
    }
  }
  return shares;
}
