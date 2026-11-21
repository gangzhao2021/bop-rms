import { expect, it } from "vitest";
import { diningTableBillRoundNumbers } from "./merchant-dining-table-checkout.js";

// b40 review (v15 b39 live, a merged table): the order reads number a merged bill's rounds as
// checkout does, and a round waiting for staff OK never shares a number with a bill round.
const id = (n: number) => "0190a430-0000-7000-8000-" + n.toString(16).padStart(12, "0");

it("numbers the bill's rounds as the bill does and waiting rounds after them, in held order", () => {
  expect(
    diningTableBillRoundNumbers({
      rounds: [
        { roundNumber: 1, orderBatchReference: id(51) },
        { roundNumber: 2, orderBatchReference: id(52) },
        { roundNumber: 3, orderBatchReference: id(62) },
        { roundNumber: 4, orderBatchReference: id(61) },
      ] as never,
      waitingRounds: [
        { orderBatchReference: id(72), heldAt: "2026-11-21T06:40:00.000Z" },
        { orderBatchReference: id(71), heldAt: "2026-11-21T06:35:00.000Z" },
      ] as never,
    }),
  ).toEqual([
    { orderBatchReference: id(51), roundNumber: 1 },
    { orderBatchReference: id(52), roundNumber: 2 },
    { orderBatchReference: id(62), roundNumber: 3 },
    { orderBatchReference: id(61), roundNumber: 4 },
    { orderBatchReference: id(71), roundNumber: 5 },
    { orderBatchReference: id(72), roundNumber: 6 },
  ]);
});
