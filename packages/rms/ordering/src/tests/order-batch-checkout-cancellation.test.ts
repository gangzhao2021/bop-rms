import { expect, it } from "vitest";
import {
  createOrderBatchCheckoutCancellation,
  parseOrderBatchCheckoutCancellation,
} from "../domain/order-batch-checkout-cancellation.js";
const id = (n: number) => `0190ee34-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function fixture() {
  const identity = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    orderBatchReference: id(5),
    submissionReference: id(6),
    paymentOperationReference: id(7),
  };
  const expiry = {
    ...identity,
    commitmentReference: id(8),
    recordReference: id(9),
    previousRecordReference: null,
    version: 1,
    paymentRequestedAt: "2026-09-21T00:00:00.000Z",
    capacityExpiresAt: "2026-09-21T00:30:00.000Z",
    observedAt: "2026-09-21T00:31:00.000Z",
    evidenceDigest: "sha256:" + "a".repeat(64),
    status: "PaymentFailed",
    paymentEvidence: {
      paymentIntentReference: id(10),
      paymentAttemptReference: id(11),
      paymentEventReference: id(12),
      outcome: "Failed",
      occurredAt: "2026-09-21T00:10:00.000Z",
    },
  };
  const record = {
    ...identity,
    cancellationReference: id(13),
    operationReference: id(14),
    expiryRecordReference: id(9),
    expiryEvidenceDigest: expiry.evidenceDigest,
    expectedOrderVersion: 7,
    cancelledOrderVersion: 8,
    expectedSourceCheckpoint: id(15),
    workflowVersionReference: id(16),
    transitionReference: id(17),
    orderItemReferences: [id(18)],
    cancelledAt: expiry.observedAt,
    phase: "Cancelled",
    reasonCode: "CHECKOUT_DEADLINE_REACHED",
  };
  const items = [
    {
      orderBatchReference: id(19),
      orderItemReference: id(20),
      phase: "Ready" as const,
      everAccepted: true,
      everStarted: true,
    },
    {
      orderBatchReference: id(5),
      orderItemReference: id(18),
      phase: "Submitted" as const,
      everAccepted: false,
      everStarted: false,
    },
  ] as const;
  return { record, expiry, items };
}
it("cancels only failed unpaid target and preserves older Ready progress", () => {
  const f = fixture(),
    result = createOrderBatchCheckoutCancellation(f);
  expect(result.items[0]).toEqual(f.items[0]);
  expect(result.items[1]?.phase).toBe("Cancelled");
  expect(result.progress.phase).toBe("Ready");
  expect(f.items[1]?.phase).toBe("Submitted");
  expect(Object.isFrozen(result.record.orderItemReferences)).toBe(true);
});
it.each(["AwaitingPaymentResolution", "PaidBeforeDeadline", "LatePayment"])(
  "refuses %s financial evidence",
  (status) => {
    const f = fixture();
    const paymentEvidence =
      status === "AwaitingPaymentResolution"
        ? null
        : {
            ...f.expiry.paymentEvidence,
            outcome: "Succeeded",
            occurredAt:
              status === "LatePayment"
                ? f.expiry.capacityExpiresAt
                : f.expiry.paymentEvidence.occurredAt,
          };
    expect(() =>
      createOrderBatchCheckoutCancellation({
        ...f,
        expiry: { ...f.expiry, status, paymentEvidence },
      }),
    ).toThrow();
  },
);
it.each(["Accepted", "InProgress", "Ready", "Fulfilled", "Cancelled", "Rejected"] as const)(
  "refuses target %s without changing other items",
  (phase) => {
    const f = fixture();
    expect(() =>
      createOrderBatchCheckoutCancellation({
        ...f,
        items: [f.items[0], { ...f.items[1], phase, everAccepted: true, everStarted: true }],
      }),
    ).toThrow();
  },
);
it.each(["storeReference", "orderBatchReference", "expiryRecordReference"] as const)(
  "rejects rebound %s",
  (key) => {
    const f = fixture();
    expect(() =>
      createOrderBatchCheckoutCancellation({ ...f, record: { ...f.record, [key]: id(99) } }),
    ).toThrow();
  },
);
it("requires complete exact target item membership and observed time", () => {
  const f = fixture();
  expect(() =>
    createOrderBatchCheckoutCancellation({
      ...f,
      record: { ...f.record, orderItemReferences: [id(99)] },
    }),
  ).toThrow();
  expect(() =>
    createOrderBatchCheckoutCancellation({
      ...f,
      record: { ...f.record, cancelledAt: "2026-09-21T00:30:00.000Z" },
    }),
  ).toThrow();
});
it("rejects invalid revision and duplicate membership", () => {
  const f = fixture();
  expect(() =>
    parseOrderBatchCheckoutCancellation({ ...f.record, cancelledOrderVersion: 9 }),
  ).toThrow();
  expect(() =>
    parseOrderBatchCheckoutCancellation({ ...f.record, orderItemReferences: [id(18), id(18)] }),
  ).toThrow();
});
