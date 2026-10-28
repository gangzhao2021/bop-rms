import { describe, expect, it } from "vitest";
import { planDiningTableSettlement } from "../domain/dining-table-settlement.js";
import { splitDiningTableBill, type DiningTableSplitRound } from "../domain/dining-table-split.js";

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
