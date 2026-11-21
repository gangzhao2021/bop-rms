import { expect, it } from "vitest";
import { lastOwnDeclinedOf } from "./dining-table-online-payment.js";

const me = "019a0000-0000-7000-8000-000000000001";
const other = "019a0000-0000-7000-8000-000000000002";
const [planOne, planTwo] = [
  "019a0000-0000-7000-8000-000000000010",
  "019a0000-0000-7000-8000-000000000011",
];
const attempt = (
  status: "Succeeded" | "Failed" | null,
  createdAt: string,
  part: { splitPlanReference: string; partNumber: number } | null,
  guest = me,
) =>
  ({
    outcome: status === null ? null : { status },
    guestSessionReference: guest,
    createdAt,
    part,
  }) as unknown as Parameters<typeof lastOwnDeclinedOf>[0][number];

it("M92: a declined part is said only on the split it was tried on", () => {
  const declined = [
    attempt("Failed", "2026-11-06T23:00:00.000Z", { splitPlanReference: planOne, partNumber: 2 }),
  ];
  expect(lastOwnDeclinedOf(declined, me, planOne)).toEqual({ partNumber: 2 });
  // Staff split again: the new plan's part 2 was never tried, so nothing was declined there.
  expect(lastOwnDeclinedOf(declined, me, planTwo)).toBeNull();
  // Back to one payment for the table: the old part is gone.
  expect(lastOwnDeclinedOf(declined, me, null)).toBeNull();
});

it("M92: a declined whole-table payment, only this guest's, only the latest one", () => {
  const whole = attempt("Failed", "2026-11-06T23:00:00.000Z", null);
  expect(lastOwnDeclinedOf([whole], me, null)).toEqual({ partNumber: null });
  expect(lastOwnDeclinedOf([whole], other, null)).toBeNull();
  expect(lastOwnDeclinedOf([whole], null, null)).toBeNull();
  const paidAfter = attempt("Succeeded", "2026-11-06T23:05:00.000Z", null);
  expect(lastOwnDeclinedOf([whole, paidAfter], me, null)).toBeNull();
  // An attempt still open is not finished, so the decline before it is the latest finished one.
  expect(
    lastOwnDeclinedOf([whole, attempt(null, "2026-11-06T23:06:00.000Z", null)], me, null),
  ).toEqual({
    partNumber: null,
  });
});
