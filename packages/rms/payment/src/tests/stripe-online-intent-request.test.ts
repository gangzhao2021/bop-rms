import { expect, it } from "vitest";
import { encodeStripeOnlineIntentRequest } from "../infrastructure/stripe/stripe-online-intent-request.js";
import {
  createCreateIntentRequest,
  createRetrieveIntentRequest,
} from "../application/payment-provider-adapter.js";
import type { CreateIntentRequest } from "../contracts/payment-provider-adapter.js";

const context = {
  provider: "Stripe",
  environment: "Test",
  brandReference: "0198a001-0000-7000-8000-000000000001",
  storeReference: "0198a001-0000-7000-8000-000000000002",
  paymentAttemptReference: "0198a001-0000-7000-8000-000000000003",
  operationReference: "0198a001-0000-7000-8000-000000000004",
} as const;
function request(amount = 1250n) {
  return createCreateIntentRequest({
    operation: "CreateIntent",
    purpose: "CreatePaymentIntent",
    context: context as CreateIntentRequest["context"],
    paymentMethod: "OnlineCard",
    captureMode: "Automatic",
    amount: { amountMinor: amount, currencyCode: "CAD" as never },
    idempotencyKey: "SYNTHETIC:CREATE:0001" as never,
  });
}
it("encodes exact amount and stable idempotency without owner IDs or customer data", () => {
  const result = encodeStripeOnlineIntentRequest(request());
  expect(result.method).toBe("POST");
  expect(result.path).toBe("/v1/payment_intents");
  expect(result.idempotencyKey).toBe("SYNTHETIC:CREATE:0001");
  expect(Object.fromEntries(new URLSearchParams(result.body ?? undefined))).toEqual({
    amount: "1250",
    currency: "cad",
    capture_method: "automatic",
    confirmation_method: "automatic",
    "payment_method_types[]": "card",
    confirm: "false",
    "expand[]": "latest_charge",
  });
  expect(encodeStripeOnlineIntentRequest(request())).toEqual(result);
});
it("rejects amounts outside Stripe range and terminal methods", () => {
  expect(() => encodeStripeOnlineIntentRequest(request(100000000n))).toThrow();
  expect(() =>
    encodeStripeOnlineIntentRequest({
      ...request(),
      paymentMethod: "TerminalCard",
      captureMode: "ManualPreferred",
    }),
  ).toThrow();
  expect(() => encodeStripeOnlineIntentRequest(request(0n))).toThrow();
  expect(
    new URLSearchParams(encodeStripeOnlineIntentRequest(request(99999999n)).body ?? undefined).get(
      "amount",
    ),
  ).toBe("99999999");
});
it("retrieves only a valid intent path without mutation idempotency or body", () => {
  const input = createRetrieveIntentRequest({
    operation: "RetrieveIntent",
    purpose: "RetrievePaymentIntent",
    context: context as CreateIntentRequest["context"],
    providerIntentReference: "pi_SYNTHETIC000001" as never,
  });
  expect(encodeStripeOnlineIntentRequest(input)).toEqual({
    method: "GET",
    path: "/v1/payment_intents/pi_SYNTHETIC000001?expand%5B%5D=latest_charge",
    body: null,
    idempotencyKey: null,
  });
  expect(() =>
    encodeStripeOnlineIntentRequest({
      ...input,
      providerIntentReference: "ch_SYNTHETIC000001" as never,
    }),
  ).toThrow();
});
