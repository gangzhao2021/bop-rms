import { expect, it, vi } from "vitest";
import { refundRequestId as id } from "./ordinary-refund-request.fixture.js";
import { createOrdinaryRefundProviderRequest } from "../application/ordinary-refund-provider-request.js";
import { stripeOrdinaryRefundBinding as binding } from "../infrastructure/stripe/stripe-ordinary-refund-request.js";
import { createStripeOrdinaryRefundAdapter } from "../infrastructure/stripe/stripe-ordinary-refund-adapter.js";
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

const at = "2026-09-13T12:00:02.000Z";
function payload() {
  return {
    object: "refund",
    id: "re_syntheticRefund",
    payment_intent: request().providerIntentReference,
    amount: 6000,
    currency: "cad",
    created: Date.parse("2026-09-13T12:00:01.000Z") / 1000,
    status: "succeeded",
    metadata: { bop_refund_binding: binding(request()) },
  };
}

const page = (data: unknown[], has_more = false) => ({
  object: "list",
  url: "/v1/refunds",
  data,
  has_more,
});
function adapter(fetch: typeof globalThis.fetch, maxLookupPages = 10) {
  return createStripeOrdinaryRefundAdapter({
    brandReference: fixture().brandReference,
    storeReference: fixture().storeReference,
    environment: "Test",
    apiVersion: "2024-06-20",
    secretKey: "sk_test_SYNTHETICONLY",
    connectedAccount: null,
    now: () => at,
    fetch,
    maxLookupPages,
  });
}
it("creates and returns an exact individual normalized refund without raw fields", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ ...payload(), description: "synthetic private detail" }));
  const result = await adapter(fetch).refundPayment(request());
  expect(result.kind).toBe("RefundObservation");
  expect(result).toHaveProperty("providerRefundReference", "re_syntheticRefund");
  expect(result).not.toHaveProperty("description");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
});
it("reads all pages and matches only the original request binding", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json(page([{ ...payload(), id: "re_otherRefund", metadata: {} }], true)),
    )
    .mockResolvedValueOnce(Response.json(page([payload()])));
  const result = await adapter(fetch).lookupRefund(request());
  expect(result.kind).toBe("RefundObservation");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(String(fetch.mock.calls[1]?.[0])).toContain("starting_after=re_otherRefund");
  expect(fetch.mock.calls.every((call) => call[1]?.method === "GET")).toBe(true);
});
it.each([
  page([]),
  page([payload(), { ...payload(), id: "re_secondMatch" }]),
  page([{ ...payload(), amount: 6001 }]),
  page([{ ...payload(), payment_intent: "pi_foreignIntent" }]),
  page([payload(), payload()]),
  page([], true),
  { ...page([]), has_more: "false" },
])("retains uncertainty for missing, ambiguous or invalid results", async (raw) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(raw));
  expect((await adapter(fetch).lookupRefund(request())).kind).toBe("Unresolved");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("does not accept a first-page match when later pages fail or contain another match", async () => {
  for (const second of [
    Response.json({ error: "synthetic private detail" }, { status: 503 }),
    Response.json(page([{ ...payload(), id: "re_secondMatch" }])),
  ]) {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(page([payload()], true)))
      .mockResolvedValueOnce(second);
    expect((await adapter(fetch).lookupRefund(request())).kind).toBe("Unresolved");
    expect(fetch).toHaveBeenCalledTimes(2);
  }
});
it("bounds pagination and rejects repeated page identities", async () => {
  const limited = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json(page([payload()], true)));
  expect((await adapter(limited, 1).lookupRefund(request())).kind).toBe("Unresolved");
  expect(limited).toHaveBeenCalledTimes(1);
  const repeated = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => Response.json(page([payload()], true)));
  expect((await adapter(repeated).lookupRefund(request())).kind).toBe("Unresolved");
  expect(repeated).toHaveBeenCalledTimes(2);
});
it("sanitizes failed creation without retry and rejects scope before network", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValue(new Error("synthetic private error"));
  expect(await adapter(fetch).refundPayment(request())).toEqual({
    kind: "Unresolved",
    context: request().context,
    reasonCode: "STRIPE_REFUND_UNRESOLVED",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  const denied = vi.fn<typeof globalThis.fetch>();
  const original = request();
  expect(
    (
      await adapter(denied).lookupRefund({
        ...original,
        context: { ...original.context, storeReference: id(99) as never },
      })
    ).kind,
  ).toBe("Unresolved");
  expect(denied).not.toHaveBeenCalled();
});
