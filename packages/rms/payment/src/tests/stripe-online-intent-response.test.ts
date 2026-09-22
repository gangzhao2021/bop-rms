import { expect, it } from "vitest";
import { normalizeStripeOnlineIntentResponse as normalize } from "../infrastructure/stripe/stripe-online-intent-response.js";
import { createCreateIntentRequest } from "../application/payment-provider-adapter.js";
const request = createCreateIntentRequest({
  operation: "CreateIntent",
  purpose: "CreatePaymentIntent",
  context: {
    provider: "Stripe",
    environment: "Test",
    brandReference: "0198a001-0000-7000-8000-000000000001" as never,
    storeReference: "0198a001-0000-7000-8000-000000000002" as never,
    paymentAttemptReference: "0198a001-0000-7000-8000-000000000003" as never,
    operationReference: "0198a001-0000-7000-8000-000000000004" as never,
  },
  paymentMethod: "OnlineCard",
  captureMode: "Automatic",
  amount: { amountMinor: 1250n, currencyCode: "CAD" as never },
  idempotencyKey: "SYNTHETIC:CREATE:0001" as never,
});
const at = "2026-09-11T21:00:00.000Z";
const pending = {
  object: "payment_intent",
  id: "pi_SYNTHETIC000001",
  currency: "cad",
  livemode: false,
  capture_method: "automatic",
  payment_method_types: ["card"],
  amount: 1250,
  amount_received: 0,
  amount_capturable: 0,
  status: "requires_payment_method",
  latest_charge: null,
};
const charge = {
  object: "charge",
  id: "ch_SYNTHETIC000001",
  payment_intent: pending.id,
  currency: "cad",
  livemode: false,
  amount: 1250,
  amount_captured: 1250,
  amount_refunded: 200,
  paid: true,
  captured: true,
  status: "succeeded",
  payment_method_details: { type: "card" },
};
it("keeps creation awaiting customer action and omits sensitive fields from evidence", () => {
  const result = normalize(
    request,
    { ...pending, client_secret: "SYNTHETIC", receipt_email: "SYNTHETIC" },
    at,
  );
  expect(result.status).toBe("RequiresCustomerAction");
  expect(result.capturedAmount.amountMinor).toBe(0n);
  expect(result).toEqual(normalize(request, pending, at));
});
it("uses expanded charge to verify captured and refunded amounts", () => {
  const result = normalize(
    request,
    { ...pending, status: "succeeded", amount_received: 1250, latest_charge: charge },
    at,
  );
  expect(result.status).toBe("Captured");
  expect(result.refundedAmount.amountMinor).toBe(200n);
});
it.each([
  { livemode: true },
  { currency: "usd" },
  { amount: 1251 },
  { amount: 12.5 },
  { status: "requires_capture" },
  { status: "succeeded" },
  { amount_received: 1 },
  { latest_charge: "ch_SYNTHETIC000001" },
])("rejects mismatched or incomplete facts %j", (change) => {
  expect(() => normalize(request, { ...pending, ...change }, at)).toThrow();
});
it("rejects a charge belonging to another intent and over-refunds", () => {
  for (const change of [{ payment_intent: "pi_OTHER000001" }, { amount_refunded: 1251 }]) {
    expect(() =>
      normalize(
        request,
        {
          ...pending,
          status: "succeeded",
          amount_received: 1250,
          latest_charge: { ...charge, ...change },
        },
        at,
      ),
    ).toThrow();
  }
});
