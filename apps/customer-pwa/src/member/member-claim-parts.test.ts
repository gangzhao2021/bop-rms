import { expect, it } from "vitest";
import { memberClaimParts } from "./MemberJoinPanel.js";

// Batch 63 (design review D62B-08, F06): the same phone paid Part 1 and Part 2 of an even split
// (both "certain"), and was still asked "Which part did you pay? Part 1 · 187 / Part 2 · 187",
// so it could claim only half of the 375 points it paid for.
it("offers every part this phone paid, together; asks only a phone that paid nothing", () => {
  const part = (partNumber: number, certain: boolean) => ({ partNumber, points: 187, certain });
  expect(memberClaimParts([part(1, true), part(2, true)])).toEqual({
    parts: [part(1, true), part(2, true)],
    allOwn: true,
  });
  // A phone that paid one part on its card is offered that part only (v15 batch 8).
  expect(memberClaimParts([part(1, true), part(2, false)])).toEqual({
    parts: [part(1, true)],
    allOwn: true,
  });
  // A phone that paid nothing here chooses among the parts paid at the counter.
  expect(memberClaimParts([part(1, false), part(2, false)])).toEqual({
    parts: [part(1, false), part(2, false)],
    allOwn: false,
  });
});
