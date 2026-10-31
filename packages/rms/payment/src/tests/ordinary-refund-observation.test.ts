import { expect, it } from "vitest";
import { refundRequestId as id } from "./ordinary-refund-request.fixture.js";
import { createOrdinaryRefundDispatch } from "../application/ordinary-refund-dispatch.js";
import { createOrdinaryRefundProviderRequest } from "../application/ordinary-refund-provider-request.js";
import {
  createOrdinaryRefundObservation as create,
  encodeOrdinaryRefundObservation as encode,
  decodeOrdinaryRefundObservation as decode,
  parseOrdinaryRefundObservation as parse,
} from "../application/ordinary-refund-observation.js";
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

function observation(snapshot = false) {
  const request = createOrdinaryRefundProviderRequest(fixture(), source());
  const outcome = snapshot
    ? {
        kind: "Snapshot",
        context: request.context,
        providerIntentReference: request.providerIntentReference,
        providerTransactionReference: "txn_synthetic_refund",
        paymentMethod: "OnlineCard",
        captureMode: "Automatic",
        status: "Captured",
        requestedAmount: request.amount,
        authorizedAmount: request.amount,
        capturedAmount: request.amount,
        refundedAmount: request.amount,
        observedAt: "2026-09-13T12:00:01.000Z",
        evidenceDigest: "sha256:" + "d".repeat(64),
      }
    : {
        kind: "Failure",
        context: request.context,
        code: "Unknown",
        retryDisposition: "Unknown",
        safeReasonCode: "PROVIDER_OUTCOME_UNKNOWN",
      };
  return {
    dispatch: createOrdinaryRefundDispatch(input()),
    request,
    outcome,
    observationReference: id(80),
    auditReference: id(81),
    recordedAt: "2026-09-13T12:00:02.000Z",
  };
}
it.each([false, true])(
  "roundtrips channel evidence without asserting individual settlement (%s)",
  (snapshot) => {
    const record = create(observation(snapshot));
    expect(decode(encode(record))).toEqual(record);
    expect(record.state).toBe("NeedsReconciliation");
    expect(Object.isFrozen(record.outcome)).toBe(true);
  },
);
it.each(["Confirmed", "Released", "Failed"])(
  "cannot encode %s as a channel observation",
  (state) => {
    expect(() => parse({ ...create(observation()), state })).toThrow();
  },
);
it.each(["brandReference", "storeReference", "paymentAttemptReference", "operationReference"])(
  "rejects foreign outcome %s",
  (key) => {
    const value = observation();
    expect(() =>
      create({
        ...value,
        outcome: { ...value.outcome, context: { ...value.outcome.context, [key]: id(99) } },
      }),
    ).toThrow();
  },
);
it("rejects changed request and cross-environment results", () => {
  const value = observation();
  expect(() =>
    create({
      ...value,
      request: { ...value.request, providerIntentReference: "pi_synthetic_other" },
    }),
  ).toThrow();
  expect(() =>
    create({
      ...value,
      outcome: { ...value.outcome, context: { ...value.outcome.context, environment: "Live" } },
    }),
  ).toThrow();
});
it("rejects future, stale and foreign snapshots", () => {
  const value = observation(true);
  for (const patch of [
    { observedAt: "2026-09-13T12:00:03.000Z" },
    { observedAt: "2026-09-13T11:59:59.000Z" },
    { providerIntentReference: "pi_synthetic_other" },
  ])
    expect(() => create({ ...value, outcome: { ...value.outcome, ...patch } })).toThrow();
  expect(() => create({ ...value, recordedAt: "2026-09-13T11:00:00.000Z" })).toThrow();
});
it("rejects lossy stored money and unbounded or malformed history", () => {
  const encoded = encode(create(observation(true)));
  for (const replacement of ["6000", '"06000"', '"6e3"', '"-1"'])
    expect(() => decode(encoded.replace('"6000"', replacement))).toThrow();
  expect(() => decode(encoded.slice(0, -1))).toThrow();
  expect(() => decode(" ".repeat(32769))).toThrow();
});
