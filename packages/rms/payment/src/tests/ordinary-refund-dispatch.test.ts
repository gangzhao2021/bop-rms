import { expect, it } from "vitest";
import { refundRequestId as id } from "./ordinary-refund-request.fixture.js";
import {
  createOrdinaryRefundDispatch as create,
  encodeOrdinaryRefundDispatch as encode,
  decodeOrdinaryRefundDispatch as decode,
  parseOrdinaryRefundDispatch as parse,
} from "../application/ordinary-refund-dispatch.js";
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
function input() {
  const operation = fixture();
  return {
    operation,
    providerBinding: source(),
    approvalReference: null,
    claimVersion: operation.claimVersion,
    claimsDigest: operation.claimsDigest,
    startedAt: operation.preparedAt,
    dispatchReference: id(70),
    auditReference: id(71),
  };
}
it("binds immutable original operation/request and roundtrips a conservative started record", () => {
  const record = create(input());
  expect(decode(encode(record))).toEqual(record);
  expect(Object.isFrozen(record)).toBe(true);
  expect(record.status).toBe("DispatchStarted");
  expect(record.operationReference).toBe(fixture().operationReference);
  expect(record.providerOperationReference).toBe(fixture().providerOperationReference);
  expect(record.providerRequestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
});
it("can bind refreshed approval without changing original operation or channel identity", () => {
  const original = create(input());
  const refreshed = create({
    ...input(),
    approvalReference: id(72),
    claimVersion: 2,
    claimsDigest: "sha256:" + "c".repeat(64),
  });
  expect(refreshed.operationDigest).toBe(original.operationDigest);
  expect(refreshed.providerRequestDigest).toBe(original.providerRequestDigest);
  expect(refreshed.providerOperationReference).toBe(original.providerOperationReference);
  expect(refreshed.approvalReference).toBe(id(72));
});
it.each([
  { claimVersion: 0 },
  { claimVersion: 1.5 },
  { claimsDigest: "sha256:" + "f".repeat(64) },
  { startedAt: "2026-09-13T11:59:59.999Z" },
  { dispatchReference: "bad" },
  { extra: true },
])("rejects invalid dispatch preparation", (patch) => {
  expect(() => create({ ...input(), ...patch })).toThrow();
});
it.each(["Confirmed", "Released", "Unknown"])(
  "does not encode %s as first-dispatch history",
  (status) => {
    expect(() => parse({ ...create(input()), status })).toThrow();
  },
);
it("binds changed channel request contents to a different digest", () => {
  const first = create(input());
  const changed = create({
    ...input(),
    providerBinding: { ...source(), providerIntentReference: "pi_synthetic_other" },
  });
  expect(changed.providerRequestDigest).not.toBe(first.providerRequestDigest);
  expect(() => decode(encode(first).slice(0, -1))).toThrow();
});
