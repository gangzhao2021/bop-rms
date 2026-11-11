import type { TablePayChoice, TablePaymentView } from "./table-payment-client.js";

/**
 * WP-2423 同桌结账 (DEC-OWNER-DEFAULTS-2026-11-06): which dishes this phone pays at a table that pays
 * at the end — the whole table (or what is left of it once others paid some), only what this phone
 * added, or dishes the guest chooses (also for others). The amounts are the server's own rule:
 * each unit's amount, and a choice that takes the last dishes of a round pays exactly what is left
 * of that round (its tax rounding included), so what the button says is what is charged.
 */
export type TablePayScope = "Whole" | "Mine" | "Chosen";

type Choices = NonNullable<TablePaymentView["choices"]>;

/** What the Store chose to start with, when it can be offered on this phone. */
export function initialPayScope(choices: Choices): TablePayScope {
  return choices.defaultScope === "OwnDishes" && choices.mine !== null ? "Mine" : "Whole";
}

export interface TablePaySelection {
  readonly amountMinor: string;
  /** Before tax: what a percentage tip is on. */
  readonly subtotalMinor: string;
  /** How many dishes (units). */
  readonly count: number;
  /** What the server is asked for (null: the whole table, not split). */
  readonly choice: TablePayChoice | null;
}

export function payDishCount(choices: Choices, mineOnly: boolean): number {
  return choices.dishes
    .filter((dish) => !mineOnly || dish.mine)
    .reduce((sum, dish) => sum + dish.unitMinor.length, 0);
}

/**
 * The amount and before-tax amount of the units chosen: per dish, its first `quantity` units still
 * to pay; per round, what is left of it when every unit still to pay in it is chosen.
 */
export function payTotals(
  choices: Choices,
  quantities: ReadonlyMap<string, number>,
): { amountMinor: bigint; subtotalMinor: bigint; count: number } {
  let amount = 0n,
    subtotal = 0n,
    count = 0;
  for (const round of choices.rounds) {
    const dishes = choices.dishes.filter((dish) => dish.roundNumber === round.roundNumber);
    const free = dishes.reduce((sum, dish) => sum + dish.unitMinor.length, 0);
    let taken = 0,
      roundAmount = 0n,
      roundSubtotal = 0n;
    for (const dish of dishes) {
      const quantity = Math.min(
        quantities.get(dish.orderItemReference) ?? 0,
        dish.unitMinor.length,
      );
      for (let unit = 0; unit < quantity; unit += 1) {
        roundAmount += BigInt(dish.unitMinor[unit] ?? "0");
        roundSubtotal += BigInt(dish.unitSubtotalMinor[unit] ?? "0");
      }
      taken += quantity;
    }
    if (taken === 0) continue;
    count += taken;
    if (taken === free) {
      amount += BigInt(round.restMinor);
      subtotal += BigInt(round.restSubtotalMinor);
    } else {
      amount += roundAmount;
      subtotal += roundSubtotal;
    }
  }
  return { amountMinor: amount, subtotalMinor: subtotal, count };
}

export function paySelection(
  view: TablePaymentView,
  scope: TablePayScope,
  chosen: ReadonlyMap<string, number>,
): TablePaySelection | null {
  const choices = view.choices;
  // Nothing to choose (an older server, or staff split the bill): the whole table or a part.
  if (choices === null) return null;
  const all = new Map(
    choices.dishes.map((dish) => [dish.orderItemReference, dish.unitMinor.length]),
  );
  if (scope === "Whole") {
    if (view.split === null)
      return {
        amountMinor: view.owed.totalMinor,
        subtotalMinor: view.owed.subtotalMinor,
        count: payDishCount(choices, false),
        choice: null,
      };
    const rest = payTotals(choices, all);
    return {
      amountMinor: rest.amountMinor.toString(),
      subtotalMinor: rest.subtotalMinor.toString(),
      count: rest.count,
      choice: { kind: "Rest" },
    };
  }
  if (scope === "Mine") {
    if (choices.mine === null) return null;
    const mine = payTotals(
      choices,
      new Map(
        choices.dishes
          .filter((dish) => dish.mine)
          .map((dish) => [dish.orderItemReference, dish.unitMinor.length]),
      ),
    );
    return {
      amountMinor: mine.amountMinor.toString(),
      subtotalMinor: mine.subtotalMinor.toString(),
      count: mine.count,
      choice: { kind: "Mine" },
    };
  }
  const dishes = choices.dishes
    .map((dish) => ({
      orderItemReference: dish.orderItemReference,
      quantity: Math.min(chosen.get(dish.orderItemReference) ?? 0, dish.unitMinor.length),
    }))
    .filter((dish) => dish.quantity > 0);
  if (dishes.length === 0) return null;
  const totals = payTotals(
    choices,
    new Map(dishes.map((dish) => [dish.orderItemReference, dish.quantity])),
  );
  return {
    amountMinor: totals.amountMinor.toString(),
    subtotalMinor: totals.subtotalMinor.toString(),
    count: totals.count,
    choice: { kind: "Chosen", dishes },
  };
}
