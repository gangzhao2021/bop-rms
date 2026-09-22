import { expect, it } from "vitest";
import { refundRequestId as id } from "./ordinary-refund-request.fixture.js";
import { createOrdinaryRefundProviderRequest } from "../application/ordinary-refund-provider-request.js";
import { createOrdinaryRefundDispatch } from "../application/ordinary-refund-dispatch.js";
import {
  encodeStripeOrdinaryRefundRequest as encode,
  encodeStripeOrdinaryRefundLookup as lookup,
  stripeOrdinaryRefundBinding as binding,
} from "../infrastructure/stripe/stripe-ordinary-refund-request.js";
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
    providerIntentReference: "pi_syntheticRefund",
    originalPaymentMethod: "OnlineCard",
  };
}

const request = () => createOrdinaryRefundProviderRequest(fixture(), source());
it("encodes exact original amount/key and the committed request digest", () => {
  const value = request();
  const encoded = encode(value);
  const body = new URLSearchParams(encoded.body ?? "");
  expect(encoded.method).toBe("POST");
  expect(encoded.path).toBe("/v1/refunds");
  expect(encoded.idempotencyKey).toBe(value.idempotencyKey);
  expect(Object.fromEntries(body)).toEqual({
    payment_intent: value.providerIntentReference,
    amount: "6000",
    "metadata[bop_refund_binding]": binding(value),
  });
  const operation = fixture();
  expect(binding(value)).toBe(
    createOrdinaryRefundDispatch({
      operation,
      providerBinding: source(),
      approvalReference: null,
      claimVersion: operation.claimVersion,
      claimsDigest: operation.claimsDigest,
      startedAt: operation.preparedAt,
      dispatchReference: id(70),
      auditReference: id(71),
    }).providerRequestDigest,
  );
});
it("encodes bounded read-only pages scoped to original PaymentIntent", () => {
  for (const cursor of [null, "re_syntheticCursor"]) {
    const encoded = lookup(request(), cursor);
    expect(encoded.method).toBe("GET");
    expect(encoded.body).toBeNull();
    expect(encoded.idempotencyKey).toBeNull();
    const url = new URL(encoded.path, "https://api.stripe.com");
    expect(url.pathname).toBe("/v1/refunds");
    expect(url.searchParams.get("payment_intent")).toBe(request().providerIntentReference);
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("starting_after")).toBe(cursor);
  }
});
it.each(["", "re_bad/escape", "pi_syntheticRefund", "re_bad?next=1"])(
  "rejects invalid cursor %s",
  (cursor) => {
    expect(() => lookup(request(), cursor)).toThrow();
  },
);
it("rejects another operation key or invalid Provider reference", () => {
  const value = request();
  expect(() =>
    encode({ ...value, idempotencyKey: ("ordinary-refund:" + id(99)) as never }),
  ).toThrow();
  expect(() => encode({ ...value, providerIntentReference: "pi_bad/path" as never })).toThrow();
});
it("keeps different amounts and payment identities distinct", () => {
  expect(binding(request())).not.toBe(
    binding(createOrdinaryRefundProviderRequest({ ...fixture(), amountMinor: 5000n }, source())),
  );
  expect(binding(request())).not.toBe(
    binding(
      createOrdinaryRefundProviderRequest(fixture(), {
        ...source(),
        providerIntentReference: "pi_otherIntent",
      }),
    ),
  );
});
