import { expect, it } from "vitest";
import { assessOrderSettlement, type OrderSettlementInput } from "../domain/order-settlement.js";
const evidence = (): OrderSettlementInput => ({
  currencyCode: "CAD",
  pricedOrderTotalMinor: 1000n,
  capturedMinor: 1200n,
  capturedOrderAllocationMinor: 1000n,
  capturedTipMinor: 200n,
  confirmedRefundMinor: 0n,
  pendingRefundMinor: 0n,
  unresolvedAttemptCount: 0,
  pendingAmendmentCount: 0,
});
it("settles exact Order allocation with tip kept separate", () => {
  expect(assessOrderSettlement(evidence())).toMatchObject({
    classification: "Settled",
    allocationDifferenceMinor: 0n,
    reasons: [],
  });
});
it("tip never covers an unpaid order balance", () => {
  expect(assessOrderSettlement({ ...evidence(), pricedOrderTotalMinor: 1200n })).toMatchObject({
    classification: "Unpaid",
    allocationDifferenceMinor: 200n,
  });
});
it.each([
  { unresolvedAttemptCount: 1 },
  { pendingAmendmentCount: 1 },
  { pendingRefundMinor: 1n },
  { confirmedRefundMinor: 1n },
  { pricedOrderTotalMinor: 900n },
])("keeps uncertain or adjusted position non-final %#", (change) => {
  expect(assessOrderSettlement({ ...evidence(), ...change }).classification).toBe("Indeterminate");
});
it("unknown attempt remains indeterminate even with a known unpaid amount", () => {
  expect(
    assessOrderSettlement({
      ...evidence(),
      pricedOrderTotalMinor: 1200n,
      unresolvedAttemptCount: 1,
    }).classification,
  ).toBe("Indeterminate");
});
it.each([
  { capturedMinor: 1199n },
  { capturedTipMinor: -1n },
  { pendingRefundMinor: 1201n },
  { confirmedRefundMinor: 1200n, pendingRefundMinor: 1n },
  { pricedOrderTotalMinor: 9223372036854775808n },
  { unresolvedAttemptCount: 0.5 },
  { pendingAmendmentCount: -1 },
])("rejects inconsistent monetary/count evidence %#", (change) =>
  expect(() => assessOrderSettlement({ ...evidence(), ...change })).toThrow(),
);
it("does not convert numbers into monetary integers", () => {
  expect(() =>
    assessOrderSettlement({
      ...evidence(),
      pricedOrderTotalMinor: 1000,
    } as unknown as OrderSettlementInput),
  ).toThrow();
});
it("rejects unknown fields and accessors without invoking them", () => {
  const extra = { ...evidence(), trusted: true };
  expect(() => assessOrderSettlement(extra)).toThrow();
  let invoked = false;
  const value = { ...evidence() };
  Object.defineProperty(value, "capturedMinor", {
    enumerable: true,
    get: () => {
      invoked = true;
      return 1200n;
    },
  });
  expect(() => assessOrderSettlement(value)).toThrow();
  expect(invoked).toBe(false);
});

it.each([
  [500n, 100n],
  [1000n, 200n],
  [0n, 100n],
])(
  "settles proven refund credits without rewriting gross capture %s/%s",
  (orderMinor, tipMinor) => {
    expect(
      assessOrderSettlement({
        ...evidence(),
        confirmedRefundMinor: orderMinor + tipMinor,
        refundAllocation: { orderMinor, tipMinor, unallocatedMinor: 0n },
      }).classification,
    ).toBe("Settled");
  },
);
it("keeps unallocated confirmed refunds non-final", () => {
  expect(
    assessOrderSettlement({
      ...evidence(),
      confirmedRefundMinor: 100n,
      refundAllocation: { orderMinor: 0n, tipMinor: 0n, unallocatedMinor: 100n },
    }).classification,
  ).toBe("Indeterminate");
});
it("a proven refund does not clear an original unpaid balance", () => {
  expect(
    assessOrderSettlement({
      ...evidence(),
      pricedOrderTotalMinor: 1100n,
      confirmedRefundMinor: 100n,
      refundAllocation: { orderMinor: 100n, tipMinor: 0n, unallocatedMinor: 0n },
    }).classification,
  ).toBe("Unpaid");
});
it.each([
  { orderMinor: 100n, tipMinor: 1n, unallocatedMinor: 0n },
  { orderMinor: -1n, tipMinor: 101n, unallocatedMinor: 0n },
  { orderMinor: 0n, tipMinor: 100n, unallocatedMinor: 0 },
])("rejects inconsistent refund allocation %#", (refundAllocation) => {
  expect(() =>
    assessOrderSettlement({
      ...evidence(),
      confirmedRefundMinor: 100n,
      refundAllocation,
    } as OrderSettlementInput),
  ).toThrow();
});
