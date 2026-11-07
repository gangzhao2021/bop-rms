import { expect, it } from "vitest";
import {
  parseOrdinaryRefundOperation as parse,
  encodeOrdinaryRefundOperation as encode,
  decodeOrdinaryRefundOperation as decode,
} from "../application/ordinary-refund-operation.js";
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
it("preserves the exact operation and original-payment identity through durable encoding", () => {
  const parsed = parse(fixture());
  expect(decode(encode(parsed))).toEqual(parsed);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(encode(parsed)).toContain('"amountMinor":"6000"');
});
it.each([
  { amountMinor: 6000 },
  { amountMinor: 0n },
  { amountMinor: 9223372036854775808n },
  { claimVersion: 0 },
  { claimVersion: 1.1 },
  { environment: "Unknown" },
  { currencyCode: "USD" },
  { status: "Confirmed" },
  { policyVersion: "OTHER" },
  { providerOperationReference: "" },
  { claimsDigest: "bad" },
  { extra: true },
])("rejects invalid or non-preparation operation fields", (patch) => {
  expect(() => parse({ ...fixture(), ...patch })).toThrow();
});
it("rejects lossy amount encodings and accepts a bound approval reference", () => {
  const encoded = encode(fixture());
  for (const amount of ["6000", '"06000"', '"6e3"', '"-1"']) {
    expect(() => decode(encoded.replace('"6000"', amount))).toThrow();
  }
  expect(parse({ ...fixture(), approvalReference: id(15) }).approvalReference).toBe(id(15));
});
