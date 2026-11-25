import { expect, it } from "vitest";
import { lastOwnDeclinedOf, paidByMeOf } from "./dining-table-online-payment.js";

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

// Batch 64 (v15 b63 live, M63 A): staff split evenly in 2; phone A paid part 1 ($16.01 with a $1.88
// tip). Staff's split records no guest claim of a part, and the read named a part this phone's
// only from such claims, so A read "Part 1 · paid" like every other phone, never "paid by you".
it("names the paid parts this phone paid itself, from its own captured payments, in any split", () => {
  const plan = "0198b064-0000-7000-8000-000000000070";
  const earlier = "0198b064-0000-7000-8000-000000000071";
  const [me, other] = ["phone-a", "phone-b"];
  const attempt = (
    guestSessionReference: string,
    partNumber: number | null,
    status: "Captured" | "Failed" | null,
    splitPlanReference = plan,
  ) =>
    ({
      guestSessionReference,
      part: partNumber === null ? null : { splitPlanReference, partNumber },
      outcome:
        status === null
          ? null
          : {
              status,
              capturedMinor: null,
              providerTransactionReference: null,
              occurredAt: "2026-11-25T17:23:00.000Z",
              recordedAt: "2026-11-25T17:23:00.000Z",
            },
    }) as unknown as Parameters<typeof paidByMeOf>[1][number];
  const paid = { method: "Online" };
  const parts = [
    { partNumber: 1, payment: paid },
    { partNumber: 2, payment: null },
    { partNumber: 3, payment: paid },
  ];
  // Staff's even split: part 1 paid on this phone, part 3 on another phone.
  const even = [attempt(me, 1, "Captured"), attempt(other, 3, "Captured")];
  expect(paidByMeOf(parts, even, me, plan)).toEqual([1]);
  expect(paidByMeOf(parts, even, other, plan)).toEqual([3]);
  expect(paidByMeOf(parts, even, null, plan)).toEqual([]);
  // One phone paid every paid part.
  expect(
    paidByMeOf(parts, [attempt(me, 1, "Captured"), attempt(me, 3, "Captured")], me, plan),
  ).toEqual([1, 3]);
  // Started, declined, or of an earlier split staff since replaced: not this phone's payment.
  expect(
    paidByMeOf(
      parts,
      [attempt(me, 2, null), attempt(me, 3, "Failed"), attempt(me, 1, "Captured", earlier)],
      me,
      plan,
    ),
  ).toEqual([]);
  // Paid whole (no split): no part to name.
  expect(paidByMeOf([], [attempt(me, null, "Captured")], me, null)).toEqual([]);
});
