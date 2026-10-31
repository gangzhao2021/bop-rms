import { expect, it, vi } from "vitest";
import { createStripeOnlineClientHandoff } from "../infrastructure/stripe/stripe-online-client-handoff.js";
import { createRetrieveIntentRequest } from "../application/payment-provider-adapter.js";
const scope = {
  brandReference: "0198a001-0000-7000-8000-000000000001",
  storeReference: "0198a001-0000-7000-8000-000000000002",
  environment: "Test" as const,
};
const request = createRetrieveIntentRequest({
  operation: "RetrieveIntent",
  purpose: "RetrievePaymentIntent",
  context: {
    ...scope,
    provider: "Stripe",
    paymentAttemptReference: "0198a001-0000-7000-8000-000000000003",
    operationReference: "0198a001-0000-7000-8000-000000000004",
  } as never,
  providerIntentReference: "pi_SYNTHETIC000001" as never,
});
const expected = { amountMinor: 1250n, currencyCode: "CAD" as never };
const raw = {
  object: "payment_intent",
  id: request.providerIntentReference,
  currency: "cad",
  livemode: false,
  capture_method: "automatic",
  payment_method_types: ["card"],
  amount: 1250,
  amount_received: 0,
  amount_capturable: 0,
  status: "requires_payment_method",
  latest_charge: null,
  client_secret: "pi_SYNTHETIC000001_secret_SYNTHETICONLY",
};
function setup(payload: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(payload));
  return {
    fetch,
    handoff: createStripeOnlineClientHandoff({
      ...scope,
      apiVersion: "2024-06-20",
      secretKey: "sk_test_SYNTHETICONLY",
      connectedAccount: null,
      now: () => "2026-09-11T21:00:00.000Z",
      fetch,
    }),
  };
}
it("retrieves original customer-action intent and separates ephemeral credential from snapshot", async () => {
  const f = setup(raw);
  const result = await f.handoff.retrieve(request, expected);
  expect(result.clientSecret).toBe(raw.client_secret);
  expect(result.snapshot).not.toHaveProperty("clientSecret");
  expect(f.fetch.mock.calls[0]?.[1]?.method).toBe("GET");
  expect(Object.keys(result).sort()).toEqual(["clientSecret", "snapshot"]);
});
it.each([{ amount: 1251 }, { status: "processing" }, { status: "canceled" }])(
  "withholds credential when no longer payable %j",
  async (change) => {
    await expect(
      setup({ ...raw, ...change }).handoff.retrieve(request, expected),
    ).rejects.toMatchObject({ code: "NOT_READY" });
  },
);
it.each([
  null,
  "pi_OTHER000001_secret_SYNTHETICONLY",
  "pi_SYNTHETIC000001_secret_",
  "contains\nnewline",
])("rejects absent or foreign credentials", async (client_secret) => {
  await expect(
    setup({ ...raw, client_secret }).handoff.retrieve(request, expected),
  ).rejects.toMatchObject({ code: "UNAVAILABLE", message: "customer payment handoff unavailable" });
});
