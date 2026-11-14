import {
  DiningTableSettlementError,
  type DiningTableSettlementRound,
} from "./dining-table-settlement.js";

/**
 * WP-2423 item 8 ④ (DEC-DINE-IN-SPLIT-BILL): a table's bill split into parts that are paid one by
 * one. Every amount comes from the Order's own rounds (tax included, comps and removed dishes
 * already taken off); the browser only says how to split.
 *
 * - Even: N parts; the bill divided by N, the leftover cents one each to the first parts.
 * - ByRounds: each part is the rounds assigned to it, whole.
 * - ByItems: each dish (one unit at a time when a line has several) goes to one part, at its own
 *   price and tax, or is shared evenly by all the parts; a round's tax rounding goes to the part
 *   with most of that round's tax.
 *
 * A part's rounds are slices: the parts take from the rounds in order until each part's amount is
 * reached, so each round's slices add up to the round exactly and a part's slices add up to the
 * part exactly. Each slice's share of its round's before-tax subtotal and tax is apportioned by
 * largest remainder within the round, so those add up per round too. A part's slices are what its
 * payment is split into (planDiningTableSettlement), so settlement, reports and refunds stay per
 * round.
 */
export type DiningTableSplitMode = "Even" | "ByRounds" | "ByItems" | "ByGuests";

export interface DiningTableSplitRound extends DiningTableSettlementRound {
  /** The round's before-tax subtotal and tax, as priced (their difference from roundMinor is fees). */
  readonly subtotalMinor: bigint;
  readonly taxMinor: bigint;
}

export interface DiningTableSplitSlice {
  readonly orderBatchReference: string;
  readonly submissionReference: string;
  readonly sequence: number;
  readonly roundMinor: bigint;
  readonly subtotalMinor: bigint;
  readonly taxMinor: bigint;
}

export interface DiningTableSplitPart {
  /** 1, 2, … in the order guests see them. */
  readonly partNumber: number;
  readonly amountMinor: bigint;
  readonly subtotalMinor: bigint;
  readonly taxMinor: bigint;
  readonly slices: readonly DiningTableSplitSlice[];
}

/** A line on the bill as it stands now: after any comp or discount. */
export interface DiningTableSplitDish {
  readonly orderBatchReference: string;
  readonly orderItemReference: string;
  readonly quantity: number;
  readonly subtotalMinor: bigint;
  readonly taxMinor: bigint;
  readonly totalMinor: bigint;
}

/** Where one unit of a line goes: a part, or null when all the parts share it. */
export interface DiningTableSplitDishChoice {
  readonly orderItemReference: string;
  /** 1 … the line's quantity. */
  readonly unit: number;
  readonly partNumber: number | null;
}

export interface DiningTableSplit {
  readonly mode: DiningTableSplitMode;
  readonly billMinor: bigint;
  readonly parts: readonly DiningTableSplitPart[];
  /** ByItems only: the choices the parts were computed from. */
  readonly dishChoices?: readonly DiningTableSplitDishChoice[];
}

export const DINING_TABLE_SPLIT_MAXIMUM_PARTS = 20;

const fail = (): never => {
  throw new DiningTableSettlementError("DINING_TABLE_SETTLEMENT_INVALID");
};

/** `total` apportioned over `weights` (summing to `weightSum`) by largest remainder; sums exactly. */
function apportion(total: bigint, weights: readonly bigint[], weightSum: bigint): bigint[] {
  if (weightSum <= 0n) return weights.map(() => 0n);
  const shares = weights.map((weight) => (total * weight) / weightSum);
  const remainders = weights.map((weight, index) => ({
    index,
    remainder: (total * weight) % weightSum,
  }));
  let left = total - shares.reduce((sum, share) => sum + share, 0n);
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const entry of remainders) {
    if (left <= 0n) break;
    shares[entry.index] = (shares[entry.index] ?? 0n) + 1n;
    left -= 1n;
  }
  return shares;
}

function checkedRounds(rounds: readonly DiningTableSplitRound[]): DiningTableSplitRound[] {
  if (!Array.isArray(rounds) || rounds.length < 1 || rounds.length > 200) return fail();
  const seen = new Set<string>();
  for (const round of rounds) {
    if (
      typeof round.orderBatchReference !== "string" ||
      seen.has(round.orderBatchReference) ||
      !Number.isSafeInteger(round.sequence) ||
      round.sequence < 1 ||
      typeof round.roundMinor !== "bigint" ||
      round.roundMinor < 1n ||
      typeof round.subtotalMinor !== "bigint" ||
      round.subtotalMinor < 0n ||
      typeof round.taxMinor !== "bigint" ||
      round.taxMinor < 0n
    )
      return fail();
    seen.add(round.orderBatchReference);
  }
  const ordered = [...rounds].sort((a, b) => a.sequence - b.sequence);
  if (new Set(ordered.map((round) => round.sequence)).size !== ordered.length) return fail();
  return ordered;
}

/** Each round's slices with their share of its subtotal and tax. */
function withShares(
  round: DiningTableSplitRound,
  amounts: readonly bigint[],
): { subtotal: bigint[]; tax: bigint[] } {
  return {
    subtotal: apportion(round.subtotalMinor, amounts, round.roundMinor),
    tax: apportion(round.taxMinor, amounts, round.roundMinor),
  };
}

function assemble(
  mode: DiningTableSplitMode,
  rounds: readonly DiningTableSplitRound[],
  partCount: number,
  cells: readonly {
    part: number;
    round: number;
    amount: bigint;
    /** Known exactly (ByItems); otherwise apportioned over the round. */
    exact?: { subtotal: bigint; tax: bigint };
  }[],
): DiningTableSplit {
  const sliceOf = new Map<string, DiningTableSplitSlice>();
  rounds.forEach((round, roundIndex) => {
    const here = cells.filter((cell) => cell.round === roundIndex);
    const shares = withShares(
      round,
      here.map((cell) => cell.amount),
    );
    here.forEach((cell, index) =>
      sliceOf.set(
        `${cell.part}:${roundIndex}`,
        Object.freeze({
          orderBatchReference: round.orderBatchReference,
          submissionReference: round.submissionReference,
          sequence: round.sequence,
          roundMinor: cell.amount,
          subtotalMinor: cell.exact?.subtotal ?? shares.subtotal[index] ?? 0n,
          taxMinor: cell.exact?.tax ?? shares.tax[index] ?? 0n,
        }),
      ),
    );
  });
  const parts = Array.from({ length: partCount }, (_, part) => {
    const slices = rounds
      .map((_, roundIndex) => sliceOf.get(`${part}:${roundIndex}`))
      .filter((slice): slice is DiningTableSplitSlice => slice !== undefined);
    if (slices.length === 0) return fail();
    return Object.freeze({
      partNumber: part + 1,
      amountMinor: slices.reduce((sum, slice) => sum + slice.roundMinor, 0n),
      subtotalMinor: slices.reduce((sum, slice) => sum + slice.subtotalMinor, 0n),
      taxMinor: slices.reduce((sum, slice) => sum + slice.taxMinor, 0n),
      slices: Object.freeze(slices),
    });
  });
  return Object.freeze({
    mode,
    billMinor: rounds.reduce((sum, round) => sum + round.roundMinor, 0n),
    parts: Object.freeze(parts),
  });
}

function splitByItems(
  rounds: readonly DiningTableSplitRound[],
  people: number,
  dishes: readonly DiningTableSplitDish[],
  choices: readonly DiningTableSplitDishChoice[],
): DiningTableSplit {
  if (!Number.isSafeInteger(people) || people < 2 || people > DINING_TABLE_SPLIT_MAXIMUM_PARTS)
    return fail();
  const choiceOf = new Map<string, number | null>();
  for (const choice of choices) {
    const part = choice.partNumber;
    if (
      !Number.isSafeInteger(choice.unit) ||
      choice.unit < 1 ||
      (part !== null && (!Number.isSafeInteger(part) || part < 1 || part > people))
    )
      return fail();
    const key = `${choice.orderItemReference}:${choice.unit}`;
    if (choiceOf.has(key)) return fail();
    choiceOf.set(key, part);
  }
  const seenDishes = new Set<string>();
  const known = new Set(rounds.map((round) => round.orderBatchReference));
  let units = 0;
  for (const dish of dishes) {
    if (
      seenDishes.has(dish.orderItemReference) ||
      !known.has(dish.orderBatchReference) ||
      !Number.isSafeInteger(dish.quantity) ||
      dish.quantity < 1 ||
      dish.subtotalMinor < 0n ||
      dish.taxMinor < 0n ||
      dish.totalMinor < 0n
    )
      return fail();
    seenDishes.add(dish.orderItemReference);
    units += dish.quantity;
  }
  // Every unit on the bill has exactly one choice, and no choice names anything else.
  if (units !== choiceOf.size) return fail();
  const zero = () => Array.from({ length: people }, () => ({ amount: 0n, subtotal: 0n, tax: 0n }));
  const everyone = Array.from({ length: people }, () => 1n);
  const cells: {
    part: number;
    round: number;
    amount: bigint;
    exact: { subtotal: bigint; tax: bigint };
  }[] = [];
  rounds.forEach((round, roundIndex) => {
    const parts = zero();
    const shared = { amount: 0n, subtotal: 0n, tax: 0n };
    let dishesTotal = 0n,
      dishesSubtotal = 0n,
      dishesTax = 0n;
    for (const dish of dishes) {
      if (dish.orderBatchReference !== round.orderBatchReference) continue;
      dishesTotal += dish.totalMinor;
      dishesSubtotal += dish.subtotalMinor;
      dishesTax += dish.taxMinor;
      const eachUnit = Array.from({ length: dish.quantity }, () => 1n);
      const count = BigInt(dish.quantity);
      const amounts = apportion(dish.totalMinor, eachUnit, count);
      const subtotals = apportion(dish.subtotalMinor, eachUnit, count);
      const taxes = apportion(dish.taxMinor, eachUnit, count);
      for (let unit = 1; unit <= dish.quantity; unit += 1) {
        const key = `${dish.orderItemReference}:${unit}`;
        if (!choiceOf.has(key)) return fail();
        const part = choiceOf.get(key) ?? null;
        const target = part === null ? shared : (parts[part - 1] ?? fail());
        target.amount += amounts[unit - 1] ?? 0n;
        target.subtotal += subtotals[unit - 1] ?? 0n;
        target.tax += taxes[unit - 1] ?? 0n;
      }
    }
    // The leftover cents of what is shared fall on a different part each round.
    const shareAmounts = apportion(shared.amount, everyone, BigInt(people));
    const shareSubtotals = apportion(shared.subtotal, everyone, BigInt(people));
    const shareTaxes = apportion(shared.tax, everyone, BigInt(people));
    parts.forEach((part, index) => {
      const turn = (index + roundIndex) % people;
      part.amount += shareAmounts[turn] ?? 0n;
      part.subtotal += shareSubtotals[turn] ?? 0n;
      part.tax += shareTaxes[turn] ?? 0n;
    });
    // What the dishes don't explain is only the round's tax rounding.
    const rounding = round.taxMinor - dishesTax;
    if (round.subtotalMinor !== dishesSubtotal || round.roundMinor - dishesTotal !== rounding)
      return fail();
    if (rounding !== 0n) {
      const most = parts.reduce((best, part) => (part.tax > best.tax ? part : best));
      most.amount += rounding;
      most.tax += rounding;
    }
    parts.forEach((part, index) => {
      if (part.amount < 0n || part.subtotal < 0n || part.tax < 0n) return fail();
      if (part.amount === 0n) {
        if (part.subtotal !== 0n || part.tax !== 0n) return fail();
        return;
      }
      cells.push({
        part: index,
        round: roundIndex,
        amount: part.amount,
        exact: { subtotal: part.subtotal, tax: part.tax },
      });
    });
  });
  return Object.freeze({
    ...assemble("ByItems", rounds, people, cells),
    dishChoices: Object.freeze(choices.map((choice) => Object.freeze({ ...choice }))),
  });
}

export function splitDiningTableBill(
  input:
    | {
        readonly mode: "Even";
        readonly rounds: readonly DiningTableSplitRound[];
        readonly people: number;
      }
    | {
        readonly mode: "ByRounds";
        readonly rounds: readonly DiningTableSplitRound[];
        /** The part (1, 2, …) each round goes to, by its Order batch reference. */
        readonly partOf: ReadonlyMap<string, number>;
      }
    | {
        readonly mode: "ByItems";
        readonly rounds: readonly DiningTableSplitRound[];
        readonly people: number;
        readonly dishes: readonly DiningTableSplitDish[];
        readonly choices: readonly DiningTableSplitDishChoice[];
      },
): DiningTableSplit {
  const rounds = checkedRounds(input.rounds);
  if (input.mode === "ByItems")
    return splitByItems(rounds, input.people, input.dishes, input.choices);
  const bill = rounds.reduce((sum, round) => sum + round.roundMinor, 0n);
  if (input.mode === "Even") {
    const people = input.people;
    if (!Number.isSafeInteger(people) || people < 2 || people > DINING_TABLE_SPLIT_MAXIMUM_PARTS)
      return fail();
    if (bill < BigInt(people)) return fail();
    const base = bill / BigInt(people);
    const extra = bill % BigInt(people);
    const targets = Array.from({ length: people }, (_, index) =>
      BigInt(index) < extra ? base + 1n : base,
    );
    // Fill the parts from the rounds in order.
    const cells: { part: number; round: number; amount: bigint }[] = [];
    let roundIndex = 0;
    let left = rounds[0]?.roundMinor ?? 0n;
    targets.forEach((target, part) => {
      let need = target;
      while (need > 0n) {
        if (left === 0n) {
          roundIndex += 1;
          left = rounds[roundIndex]?.roundMinor ?? fail();
        }
        const take = need < left ? need : left;
        cells.push({ part, round: roundIndex, amount: take });
        need -= take;
        left -= take;
      }
    });
    return assemble("Even", rounds, people, cells);
  }
  if (input.mode !== "ByRounds" || !(input.partOf instanceof Map)) return fail();
  if (input.partOf.size !== rounds.length) return fail();
  const numbers = rounds.map((round) => input.partOf.get(round.orderBatchReference));
  if (numbers.some((part) => part === undefined || !Number.isSafeInteger(part) || part < 1))
    return fail();
  const partCount = Math.max(...(numbers as number[]));
  // Every part up to the last has a round, and there are at least two parts.
  if (partCount < 2 || partCount > DINING_TABLE_SPLIT_MAXIMUM_PARTS) return fail();
  if (new Set(numbers).size !== partCount) return fail();
  return assemble(
    "ByRounds",
    rounds,
    partCount,
    rounds.map((round, index) => ({
      part: (numbers[index] as number) - 1,
      round: index,
      amount: round.roundMinor,
    })),
  );
}

/**
 * WP-2423 DEC-OWNER-DEFAULTS-2026-11-06 同桌结账 (pay at the end): guests at one table pay by dish
 * as they go — "only what I added", "choose dishes", or "the rest of the table". Each part is
 * appended to the table's one "ByGuests" plan with the units of the dishes it pays for; a unit is
 * in at most one part that is paid or being paid. DEC-TAX-WHOLE-RECEIPT: a unit's amount, before-tax
 * subtotal and tax are its dish's, apportioned over the dish's units by largest remainder; a part's
 * slice of a round is the sum of its units, except that the part that takes the last unit still to
 * pay of a round takes what is left of the round (round − the other parts' slices: its share of the
 * bill's tax rounding included). So each round's slices add up to the round exactly, and the parts
 * to the bill. A unit worth nothing (comped) is never paid for and never chosen.
 */
export interface DiningTableSplitUnit {
  readonly orderItemReference: string;
  /** 1 … the dish's quantity. */
  readonly unit: number;
}

export interface DiningTableGuestPartChoice {
  readonly part: DiningTableSplitPart;
  readonly units: readonly DiningTableSplitUnit[];
  /** No unit with something to pay is left outside a part once this one is added. */
  readonly completesBill: boolean;
}

/** Each unit of each dish with its amount, before-tax subtotal and tax (largest remainder). */
export function diningTableSplitUnits(dishes: readonly DiningTableSplitDish[]) {
  const units: {
    orderBatchReference: string;
    orderItemReference: string;
    unit: number;
    amountMinor: bigint;
    subtotalMinor: bigint;
    taxMinor: bigint;
  }[] = [];
  const seen = new Set<string>();
  for (const dish of dishes) {
    if (
      seen.has(dish.orderItemReference) ||
      !Number.isSafeInteger(dish.quantity) ||
      dish.quantity < 1 ||
      dish.quantity > 1000 ||
      dish.subtotalMinor < 0n ||
      dish.taxMinor < 0n ||
      dish.totalMinor < 0n
    )
      return fail();
    seen.add(dish.orderItemReference);
    const each = Array.from({ length: dish.quantity }, () => 1n);
    const count = BigInt(dish.quantity);
    const amounts = apportion(dish.totalMinor, each, count);
    const subtotals = apportion(dish.subtotalMinor, each, count);
    const taxes = apportion(dish.taxMinor, each, count);
    for (let unit = 1; unit <= dish.quantity; unit += 1)
      units.push({
        orderBatchReference: dish.orderBatchReference,
        orderItemReference: dish.orderItemReference,
        unit,
        amountMinor: amounts[unit - 1] ?? 0n,
        subtotalMinor: subtotals[unit - 1] ?? 0n,
        taxMinor: taxes[unit - 1] ?? 0n,
      });
  }
  return units;
}

export function chooseDiningTableGuestPart(input: {
  /** The bill's rounds as they stand (tax rounding in their tax), the ones owing nothing left out. */
  readonly rounds: readonly DiningTableSplitRound[];
  /** Every dish of those rounds as it stands now (after comps and discounts). */
  readonly dishes: readonly DiningTableSplitDish[];
  /** The parts of the plan that are paid or being paid (not withdrawn). */
  readonly others: readonly {
    readonly units: readonly DiningTableSplitUnit[];
    readonly slices: readonly {
      readonly orderBatchReference: string;
      readonly roundMinor: bigint;
      readonly subtotalMinor: bigint;
      readonly taxMinor: bigint;
    }[];
  }[];
  /** The units this part pays for. */
  readonly chosen: readonly DiningTableSplitUnit[];
  readonly partNumber: number;
}): DiningTableGuestPartChoice {
  const rounds = checkedRounds(input.rounds);
  if (!Number.isSafeInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > 100)
    return fail();
  const known = new Set(rounds.map((round) => round.orderBatchReference));
  const units = diningTableSplitUnits(input.dishes);
  if (units.some((unit) => !known.has(unit.orderBatchReference))) return fail();
  const key = (unit: DiningTableSplitUnit) => `${unit.orderItemReference}:${unit.unit}`;
  const taken = new Set<string>();
  for (const other of input.others)
    for (const unit of other.units) {
      if (taken.has(key(unit))) return fail();
      taken.add(key(unit));
    }
  const chosen = new Set<string>();
  for (const unit of input.chosen) {
    const k = key(unit);
    if (chosen.has(k) || taken.has(k)) return fail();
    chosen.add(k);
  }
  const unitOf = new Map(units.map((unit) => [key(unit), unit]));
  // Only units with something to pay, and that nobody pays for yet, may be chosen.
  for (const k of chosen) if ((unitOf.get(k)?.amountMinor ?? 0n) <= 0n) return fail();
  if (chosen.size === 0) return fail();
  const slices: DiningTableSplitSlice[] = [];
  for (const round of rounds) {
    const here = units.filter((unit) => unit.orderBatchReference === round.orderBatchReference);
    const mine = here.filter((unit) => chosen.has(key(unit)));
    if (mine.length === 0) continue;
    const dishTotal = here.reduce((sum, unit) => sum + unit.amountMinor, 0n);
    const dishSubtotal = here.reduce((sum, unit) => sum + unit.subtotalMinor, 0n);
    const dishTax = here.reduce((sum, unit) => sum + unit.taxMinor, 0n);
    // What the dishes don't explain is only the round's share of the bill's tax rounding.
    if (
      round.subtotalMinor !== dishSubtotal ||
      round.roundMinor - dishTotal !== round.taxMinor - dishTax
    )
      return fail();
    const left = here.filter(
      (unit) => unit.amountMinor > 0n && !taken.has(key(unit)) && !chosen.has(key(unit)),
    );
    let amount = mine.reduce((sum, unit) => sum + unit.amountMinor, 0n);
    let subtotal = mine.reduce((sum, unit) => sum + unit.subtotalMinor, 0n);
    let tax = mine.reduce((sum, unit) => sum + unit.taxMinor, 0n);
    if (left.length === 0) {
      // The last of the round: what the other parts did not take of it.
      const before = input.others.flatMap((other) =>
        other.slices.filter((slice) => slice.orderBatchReference === round.orderBatchReference),
      );
      amount = round.roundMinor - before.reduce((sum, slice) => sum + slice.roundMinor, 0n);
      subtotal = round.subtotalMinor - before.reduce((sum, slice) => sum + slice.subtotalMinor, 0n);
      tax = round.taxMinor - before.reduce((sum, slice) => sum + slice.taxMinor, 0n);
    }
    if (amount < 1n || subtotal < 0n || tax < 0n || amount > round.roundMinor) return fail();
    slices.push(
      Object.freeze({
        orderBatchReference: round.orderBatchReference,
        submissionReference: round.submissionReference,
        sequence: round.sequence,
        roundMinor: amount,
        subtotalMinor: subtotal,
        taxMinor: tax,
      }),
    );
  }
  const completesBill = units.every(
    (unit) => unit.amountMinor <= 0n || taken.has(key(unit)) || chosen.has(key(unit)),
  );
  return Object.freeze({
    part: Object.freeze({
      partNumber: input.partNumber,
      amountMinor: slices.reduce((sum, slice) => sum + slice.roundMinor, 0n),
      subtotalMinor: slices.reduce((sum, slice) => sum + slice.subtotalMinor, 0n),
      taxMinor: slices.reduce((sum, slice) => sum + slice.taxMinor, 0n),
      slices: Object.freeze(slices),
    }),
    units: Object.freeze(
      units
        .filter((unit) => chosen.has(key(unit)))
        .map((unit) =>
          Object.freeze({ orderItemReference: unit.orderItemReference, unit: unit.unit }),
        ),
    ),
    completesBill,
  });
}
