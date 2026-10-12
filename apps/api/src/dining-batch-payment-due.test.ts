import { expect, it } from "vitest";
import {
  resolveCustomerBatchPayments,
  resolveMerchantBatchPaymentDue,
} from "./dining-batch-payment-due.js";

const id = (n: number) => `0190ee31-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const deadline = "2026-10-11T23:06:00.000Z";

it("WP-2423: tells staff a dine-in round's payment failed and when it is cancelled", () => {
  const input = {
    orderType: "DineIn" as const,
    open: true,
    batch: { orderBatchReference: id(2), acceptanceStatus: "NotAccepted" },
    paidBatches: new Set([id(1)]),
    deadlines: new Map([
      [id(1), deadline],
      [id(2), deadline],
    ]),
    outcomes: new Map([
      [id(1), "Succeeded" as const],
      [id(2), "Failed" as const],
    ]),
  };
  expect(resolveMerchantBatchPaymentDue(input)).toEqual({ status: "Failed", cancelsAt: deadline });
  // No terminal outcome yet: the guest has not paid.
  expect(resolveMerchantBatchPaymentDue({ ...input, outcomes: new Map() })).toEqual({
    status: "Awaiting",
    cancelsAt: null,
  });
  // Paid at the Provider but not yet recorded by Ordering: nothing due.
  expect(
    resolveMerchantBatchPaymentDue({ ...input, outcomes: new Map([[id(2), "Succeeded"]]) }),
  ).toBeNull();
  for (const other of [
    { orderType: "Pickup" as const },
    { open: false },
    { batch: { orderBatchReference: id(2), acceptanceStatus: "Accepted" } },
    { batch: { orderBatchReference: id(2), acceptanceStatus: "Cancelled" } },
    { paidBatches: new Set([id(2)]) },
    // Not a Dining-owned checkout: no payment window applies.
    { deadlines: new Map<string, string>() },
  ])
    expect(resolveMerchantBatchPaymentDue({ ...input, ...other })).toBeNull();
});

it("WP-2423: gives the customer each Dining-owned round's payment and drops the cancel time once cancelled", () => {
  const deadlines = new Map([
    [id(1), deadline],
    [id(2), deadline],
    [id(3), deadline],
  ]);
  const outcomes = new Map([
    [id(1), "Succeeded" as const],
    [id(2), "Failed" as const],
  ]);
  expect(
    resolveCustomerBatchPayments({
      batchReferences: [id(1), id(2), id(3), id(4)],
      deadlines,
      outcomes,
      cancelled: new Set(),
    }),
  ).toEqual([
    { orderBatchReference: id(1), status: "Succeeded", cancelsAt: null },
    { orderBatchReference: id(2), status: "Failed", cancelsAt: deadline },
    { orderBatchReference: id(3), status: "Awaiting", cancelsAt: null },
  ]);
  expect(
    resolveCustomerBatchPayments({
      batchReferences: [id(2)],
      deadlines,
      outcomes,
      cancelled: new Set([id(2)]),
    }),
  ).toEqual([{ orderBatchReference: id(2), status: "Failed", cancelsAt: null }]);
});
