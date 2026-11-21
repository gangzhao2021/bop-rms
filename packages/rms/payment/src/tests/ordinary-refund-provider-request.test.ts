import { expect, it } from "vitest";
import { createOrdinaryRefundProviderRequest as create } from "../application/ordinary-refund-provider-request.js";
import { refundRequestId as id } from "./ordinary-refund-request.fixture.js";
function fixture() {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    requestReference: id(5),
    operationReference: id(6),
    providerOperationReference: id(7),
    paymentTransactionReference: id(8),
    paymentIntentReference: id(9),
    paymentAttemptReference: id(10),
    firstCaptureReference: id(11),
    providerAccountReference: id(12),
    executorReference: id(13),
    auditReference: id(14),
    approvalReference: null,
    claimVersion: 1,
    claimsDigest: "sha256:" + "a".repeat(64),
    allocationDigest: "sha256:" + "b".repeat(64),
    preparedAt: "2026-09-13T12:00:00.000Z",
    environment: "Test",
    currencyCode: "CAD",
    amountMinor: 6000n,
    policyVersion: "PILOT_ORDINARY_REFUND_V1",
    status: "Prepared",
  };
}
function source() {
  const op = fixture();
  return {
    tenantReference: op.tenantReference,
    brandReference: op.brandReference,
    storeReference: op.storeReference,
    orderReference: op.orderReference,
    paymentTransactionReference: op.paymentTransactionReference,
    paymentIntentReference: op.paymentIntentReference,
    paymentAttemptReference: op.paymentAttemptReference,
    firstCaptureReference: op.firstCaptureReference,
    providerAccountReference: op.providerAccountReference,
    environment: "Test",
    providerIntentReference: "pi_synthetic_refund",
    originalPaymentMethod: "OnlineCard",
  };
}
it("uses exact original payment, integer amount and stable Provider operation on repeat", () => {
  const request = create(fixture(), source());
  expect(create(fixture(), source())).toEqual(request);
  expect(request.context.operationReference).toBe(fixture().providerOperationReference);
  expect(request.idempotencyKey).toBe("ordinary-refund:" + fixture().providerOperationReference);
  expect(request.providerIntentReference).toBe("pi_synthetic_refund");
  expect(request.amount).toEqual({ currencyCode: "CAD", amountMinor: 6000n });
  expect(request.originalPaymentMethod).toBe("OnlineCard");
});
it.each([
  "tenantReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "paymentTransactionReference",
  "paymentIntentReference",
  "paymentAttemptReference",
  "firstCaptureReference",
  "providerAccountReference",
])("rejects changed original %s", (key) => {
  expect(() => create(fixture(), { ...source(), [key]: id(99) })).toThrow();
});
it.each([
  { environment: "Live" },
  { originalPaymentMethod: "TerminalCard" },
  { providerIntentReference: "" },
  { amountMinor: 1n },
  { idempotencyKey: "new-key" },
])("rejects incompatible or injected channel fields", (patch) => {
  expect(() => create(fixture(), { ...source(), ...patch })).toThrow();
});
