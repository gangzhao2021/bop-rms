import { expect, it } from "vitest";
import { tonightTableStanding } from "./merchant-tonight-summary.js";

const base = {
  writtenOff: false,
  owedMinor: 0n,
  unpaidRounds: 0,
  tableMoneyTaken: false,
  keptPaidRounds: 0,
  ordered: true,
};

it("M40: only a table whose money was really taken and kept reads as paid", () => {
  // Pay-at-end table settled, or a split part paid with nothing left owing.
  expect(tonightTableStanding({ ...base, tableMoneyTaken: true })).toBe("Paid");
  // Pay-first table with a paid round still kept.
  expect(tonightTableStanding({ ...base, keptPaidRounds: 1 })).toBe("Paid");
  // Pay-first table whose only paid round was refunded with "Can't make it · refund".
  expect(tonightTableStanding({ ...base, keptPaidRounds: 0 })).toBe("NothingToCollect");
  // Seated, never ordered.
  expect(tonightTableStanding({ ...base, ordered: false })).toBe("NothingOrdered");
  // Walkout.
  expect(tonightTableStanding({ ...base, writtenOff: true, tableMoneyTaken: true })).toBe(
    "WrittenOff",
  );
  // A pay-first round nobody paid yet, even after an earlier paid one.
  expect(tonightTableStanding({ ...base, keptPaidRounds: 1, unpaidRounds: 1 })).toBe("RoundUnpaid");
  // A bill still owing, even after one part was paid.
  expect(tonightTableStanding({ ...base, owedMinor: 2346n, tableMoneyTaken: true })).toBe("Owes");
});
