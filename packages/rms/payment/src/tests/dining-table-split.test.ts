import { describe, expect, it } from "vitest";
import { planDiningTableSettlement } from "../domain/dining-table-settlement.js";
import {
  chooseDiningTableGuestPart,
  splitDiningTableBill,
  type DiningTableSplitRound,
} from "../domain/dining-table-split.js";

const ref = (n: number) => "018f9a00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
// Table 8 of the Figma sample: round 1 $48.50 + 13% = $54.81 (rounded per item), round 2 $35.50 + 13%.
const round = (n: number, total: bigint, subtotal: bigint, tax: bigint): DiningTableSplitRound => ({
  orderBatchReference: ref(n),
  submissionReference: ref(100 + n),
  sequence: n,
  roundMinor: total,
  subtotalMinor: subtotal,
  taxMinor: tax,
});
const table8 = [round(1, 5481n, 4850n, 631n), round(2, 4011n, 3550n, 461n)];
const sum = (values: readonly bigint[]) => values.reduce((total, value) => total + value, 0n);

describe("WP-2423 item 8 ④ split bill", () => {
  it("splits evenly with the leftover cents on the first parts, slices adding up per round", () => {
    const split = splitDiningTableBill({ mode: "Even", rounds: table8, people: 3 });
    expect(split.billMinor).toBe(9492n);
    expect(split.parts.map((part) => part.amountMinor)).toEqual([3164n, 3164n, 3164n]);
    const uneven = splitDiningTableBill({
      mode: "Even",
      rounds: [round(1, 10001n, 8850n, 1151n)],
      people: 3,
    });
    expect(uneven.parts.map((part) => part.amountMinor)).toEqual([3334n, 3334n, 3333n]);
    for (const [index, original] of table8.entries()) {
      const slices = split.parts.flatMap((part) =>
        part.slices.filter((slice) => slice.orderBatchReference === original.orderBatchReference),
      );
      expect(sum(slices.map((slice) => slice.roundMinor)), `round ${index + 1}`).toBe(
        original.roundMinor,
      );
      expect(sum(slices.map((slice) => slice.subtotalMinor))).toBe(original.subtotalMinor);
      expect(sum(slices.map((slice) => slice.taxMinor))).toBe(original.taxMinor);
    }
    // Part 2 spans both rounds: $23.17 of round 1 and $8.47 of round 2.
    expect(split.parts[1]?.slices.map((slice) => [slice.sequence, slice.roundMinor])).toEqual([
      [1, 2317n],
      [2, 847n],
    ]);
    expect(sum(split.parts.map((part) => part.subtotalMinor))).toBe(8400n);
    expect(sum(split.parts.map((part) => part.taxMinor))).toBe(1092n);
  });

  it("splits by rounds, whole rounds per part, every part with at least one round", () => {
    const three = [...table8, round(3, 1130n, 1000n, 130n)];
    const split = splitDiningTableBill({
      mode: "ByRounds",
      rounds: three,
      partOf: new Map([
        [ref(1), 1],
        [ref(2), 2],
        [ref(3), 1],
      ]),
    });
    expect(split.parts.map((part) => [part.partNumber, part.amountMinor])).toEqual([
      [1, 6611n],
      [2, 4011n],
    ]);
    expect(split.parts[0]?.slices.map((slice) => slice.sequence)).toEqual([1, 3]);
    // A gap in the part numbers, one part only, or a round left out are refused.
    for (const partOf of [
      new Map([
        [ref(1), 1],
        [ref(2), 3],
        [ref(3), 1],
      ]),
      new Map([
        [ref(1), 1],
        [ref(2), 1],
        [ref(3), 1],
      ]),
      new Map([
        [ref(1), 1],
        [ref(2), 2],
      ]),
    ])
      expect(() => splitDiningTableBill({ mode: "ByRounds", rounds: three, partOf })).toThrow();
  });

  it("refuses fewer than 2 or more than 20 people, and more people than cents", () => {
    for (const people of [1, 21, 2.5])
      expect(() => splitDiningTableBill({ mode: "Even", rounds: table8, people })).toThrow();
    expect(() =>
      splitDiningTableBill({ mode: "Even", rounds: [round(1, 1n, 1n, 0n)], people: 2 }),
    ).toThrow();
  });

  it("a part's slices are what its payment is split into, with tip and cash rounding per part", () => {
    const part = splitDiningTableBill({ mode: "Even", rounds: table8, people: 3 }).parts[1];
    if (part === undefined) throw new Error("part");
    const cash = planDiningTableSettlement({
      method: "Cash",
      rounds: part.slices,
      tipMinor: 0n,
      tenderedMinor: 4000n,
    });
    expect([cash.roundsMinor, cash.roundingMinor, cash.totalMinor, cash.changeMinor]).toEqual([
      3164n,
      1n,
      3165n,
      835n,
    ]);
    expect(cash.lines.map((line) => line.roundMinor)).toEqual([2317n, 847n]);
  });
});

describe("WP-2423 by-dish split", () => {
  const dish = (n: number, batch: number, quantity: number, subtotal: bigint, tax: bigint) => ({
    orderBatchReference: ref(batch),
    orderItemReference: ref(1000 + n),
    quantity,
    subtotalMinor: subtotal,
    taxMinor: tax,
    totalMinor: subtotal + tax,
  });
  const choice = (n: number, unit: number, partNumber: number | null) => ({
    orderItemReference: ref(1000 + n),
    unit,
    partNumber,
  });
  // Beer taxed differently from food, a line of two dumplings, and one dish everyone shares.
  const dishes = [dish(1, 1, 1, 800n, 120n), dish(2, 1, 2, 1000n, 51n), dish(3, 2, 1, 2000n, 100n)];
  const rounds = [round(1, 1971n, 1800n, 171n), round(2, 2100n, 2000n, 100n)];

  it("charges each part its own dishes at their own tax and shares the rest evenly", () => {
    const split = splitDiningTableBill({
      mode: "ByItems",
      rounds,
      people: 2,
      dishes,
      choices: [choice(1, 1, 1), choice(2, 1, 2), choice(2, 2, 2), choice(3, 1, null)],
    });
    expect(split.mode).toBe("ByItems");
    expect(split.parts.map((part) => [part.amountMinor, part.taxMinor])).toEqual([
      [920n + 1050n, 120n + 50n],
      [1051n + 1050n, 51n + 50n],
    ]);
    expect(sum(split.parts.map((part) => part.amountMinor))).toBe(split.billMinor);
    expect(split.dishChoices).toHaveLength(4);
  });

  it("splits the units of a line, the odd cent on the first unit", () => {
    const split = splitDiningTableBill({
      mode: "ByItems",
      rounds: [round(1, 1051n, 1000n, 51n)],
      people: 2,
      dishes: [dish(2, 1, 2, 1000n, 51n)],
      choices: [choice(2, 1, 1), choice(2, 2, 2)],
    });
    expect(split.parts.map((part) => [part.amountMinor, part.taxMinor])).toEqual([
      [526n, 26n],
      [525n, 25n],
    ]);
  });

  it("gives a round's tax rounding to the part with most of its tax, adding up exactly", () => {
    for (const rounding of [1n, -1n]) {
      const split = splitDiningTableBill({
        mode: "ByItems",
        rounds: [round(1, 1971n + rounding, 1800n, 171n + rounding)],
        people: 2,
        dishes: dishes.slice(0, 2),
        choices: [choice(1, 1, 1), choice(2, 1, 2), choice(2, 2, 2)],
      });
      expect(split.parts[0]?.taxMinor).toBe(120n + rounding);
      expect(split.parts[1]?.taxMinor).toBe(51n);
      expect(sum(split.parts.map((part) => part.amountMinor))).toBe(1971n + rounding);
    }
  });

  it("refuses a dish left out, chosen twice or not on the bill, a part with nothing, and a dish the round doesn't explain", () => {
    const good = [choice(1, 1, 1), choice(2, 1, 2), choice(2, 2, 2), choice(3, 1, null)];
    const attempt =
      (changes: { choices?: typeof good; people?: number; rounds?: typeof rounds }) => () =>
        splitDiningTableBill({
          mode: "ByItems",
          rounds: changes.rounds ?? rounds,
          people: changes.people ?? 2,
          dishes,
          choices: changes.choices ?? good,
        });
    expect(attempt({})).not.toThrow();
    expect(attempt({ choices: good.slice(1) })).toThrow();
    expect(attempt({ choices: [...good, choice(1, 1, 2)] })).toThrow();
    expect(attempt({ choices: [...good.slice(1), choice(9, 1, 1)] })).toThrow();
    expect(attempt({ choices: [...good.slice(1), choice(1, 1, 3)] })).toThrow();
    // Nothing shared and nothing chosen for part 2.
    expect(
      attempt({ choices: [choice(1, 1, 1), choice(2, 1, 1), choice(2, 2, 1), choice(3, 1, 1)] }),
    ).toThrow();
    expect(attempt({ people: 21 })).toThrow();
    // The round says more than its dishes before tax: the bill changed.
    expect(attempt({ rounds: [round(1, 2071n, 1900n, 171n), rounds[1] as never] })).toThrow();
  });

  it("is paid as ordinary round slices", () => {
    const split = splitDiningTableBill({
      mode: "ByItems",
      rounds,
      people: 2,
      dishes,
      choices: [choice(1, 1, 1), choice(2, 1, 2), choice(2, 2, 2), choice(3, 1, null)],
    });
    for (const original of rounds) {
      const slices = split.parts.flatMap((part) =>
        part.slices.filter((slice) => slice.orderBatchReference === original.orderBatchReference),
      );
      expect(sum(slices.map((slice) => slice.roundMinor))).toBe(original.roundMinor);
      expect(sum(slices.map((slice) => slice.subtotalMinor))).toBe(original.subtotalMinor);
      expect(sum(slices.map((slice) => slice.taxMinor))).toBe(original.taxMinor);
    }
  });
});

describe("WP-2423 同桌结账: guests pay by dish as they go", () => {
  // Round 1: dumplings ×3 ($9.00 + 13% = $10.17 → $3.39 each) and tea ×1 ($2.50 + $0.33);
  // round 2: noodles ×1 ($12.00 + $1.56). The bill's tax rounding gave round 1 one cent more.
  const dumplings = {
    orderBatchReference: ref(1),
    orderItemReference: ref(11),
    quantity: 3,
    subtotalMinor: 900n,
    taxMinor: 117n,
    totalMinor: 1017n,
  };
  const tea = {
    orderBatchReference: ref(1),
    orderItemReference: ref(12),
    quantity: 1,
    subtotalMinor: 250n,
    taxMinor: 33n,
    totalMinor: 283n,
  };
  const noodles = {
    orderBatchReference: ref(2),
    orderItemReference: ref(21),
    quantity: 1,
    subtotalMinor: 1200n,
    taxMinor: 156n,
    totalMinor: 1356n,
  };
  const rounds = [round(1, 1301n, 1150n, 151n), round(2, 1356n, 1200n, 156n)];
  const dishes = [dumplings, tea, noodles];
  const unit = (item: number, n: number) => ({ orderItemReference: ref(item), unit: n });
  const as = (choice: ReturnType<typeof chooseDiningTableGuestPart>) => ({
    units: choice.units,
    slices: choice.part.slices,
  });

  it("a part pays its units; the part taking a round's last unit takes the rest of the round", () => {
    // Phone A: one dumpling and the noodles.
    const a = chooseDiningTableGuestPart({
      rounds,
      dishes,
      others: [],
      chosen: [unit(11, 1), unit(21, 1)],
      partNumber: 1,
    });
    expect(a.part.slices.map((slice) => [slice.sequence, slice.roundMinor])).toEqual([
      [1, 339n],
      [2, 1356n],
    ]);
    expect(a.completesBill).toBe(false);
    // Phone B: the other two dumplings.
    const b = chooseDiningTableGuestPart({
      rounds,
      dishes,
      others: [a].map(as),
      chosen: [unit(11, 2), unit(11, 3)],
      partNumber: 2,
    });
    expect(b.part.amountMinor).toBe(678n);
    expect(b.completesBill).toBe(false);
    // The rest (the tea) is the last of round 1: its price and the cent of tax rounding.
    const rest = chooseDiningTableGuestPart({
      rounds,
      dishes,
      others: [a, b].map(as),
      chosen: [unit(12, 1)],
      partNumber: 3,
    });
    expect(rest.part.amountMinor).toBe(284n);
    expect(rest.part.taxMinor).toBe(151n - 39n - 78n);
    expect(rest.completesBill).toBe(true);
    // Every round's slices add up to the round to the cent; the parts to the bill.
    for (const original of rounds) {
      const slices = [a, b, rest].flatMap((part) =>
        part.part.slices.filter((s) => s.orderBatchReference === original.orderBatchReference),
      );
      expect(sum(slices.map((s) => s.roundMinor))).toBe(original.roundMinor);
      expect(sum(slices.map((s) => s.subtotalMinor))).toBe(original.subtotalMinor);
      expect(sum(slices.map((s) => s.taxMinor))).toBe(original.taxMinor);
    }
    expect(sum([a, b, rest].map((part) => part.part.amountMinor))).toBe(2657n);
  });

  it("a dish already in a part, nothing chosen, a comped dish or one not on the bill: refused", () => {
    const a = chooseDiningTableGuestPart({
      rounds,
      dishes,
      others: [],
      chosen: [unit(21, 1)],
      partNumber: 1,
    });
    const again = (chosen: { orderItemReference: string; unit: number }[], list = dishes) =>
      chooseDiningTableGuestPart({
        rounds,
        dishes: list,
        others: [a].map(as),
        chosen,
        partNumber: 2,
      });
    expect(() => again([unit(21, 1)])).toThrow();
    expect(() => again([])).toThrow();
    expect(() => again([unit(99, 1)])).toThrow();
    expect(() => again([unit(11, 4)])).toThrow();
    // Tea comped: worth nothing, never chosen; the dumplings are then the last of round 1.
    const comped = [
      dumplings,
      { ...tea, subtotalMinor: 0n, taxMinor: 0n, totalMinor: 0n },
      noodles,
    ];
    const compedRounds = [round(1, 1018n, 900n, 118n), round(2, 1356n, 1200n, 156n)];
    expect(() =>
      chooseDiningTableGuestPart({
        rounds: compedRounds,
        dishes: comped,
        others: [a].map(as),
        chosen: [unit(12, 1)],
        partNumber: 2,
      }),
    ).toThrow();
    const last = chooseDiningTableGuestPart({
      rounds: compedRounds,
      dishes: comped,
      others: [a].map(as),
      chosen: [unit(11, 1), unit(11, 2), unit(11, 3)],
      partNumber: 2,
    });
    expect(last.part.amountMinor).toBe(1018n);
    expect(last.completesBill).toBe(true);
  });
});
