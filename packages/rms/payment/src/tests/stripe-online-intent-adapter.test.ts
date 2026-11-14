import { createPaymentIntentCreationService } from "../application/payment-intent-creation-service.js";
import { harness, command, refs, at } from "./payment-intent-creation.fixture.js";
import { expect, it, vi } from "vitest";
import { createStripeOnlineIntentAdapter } from "../infrastructure/stripe/stripe-online-intent-adapter.js";
import {
  createCreateIntentRequest,
  createRetrieveIntentRequest,
} from "../application/payment-provider-adapter.js";
const scope = {
  brandReference: "0198a001-0000-7000-8000-000000000001",
  storeReference: "0198a001-0000-7000-8000-000000000002",
  environment: "Test" as const,
};
const context = {
  ...scope,
  provider: "Stripe" as const,
  paymentAttemptReference: "0198a001-0000-7000-8000-000000000003",
  operationReference: "0198a001-0000-7000-8000-000000000004",
};
const request = createCreateIntentRequest({
  operation: "CreateIntent",
  purpose: "CreatePaymentIntent",
  context: context as never,
  paymentMethod: "OnlineCard",
  captureMode: "Automatic",
  amount: { amountMinor: 1250n, currencyCode: "CAD" as never },
  idempotencyKey: "SYNTHETIC:CREATE:0001" as never,
});
const raw = {
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
  client_secret: "SYNTHETIC",
};
function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const adapter = createStripeOnlineIntentAdapter({
    ...scope,
    secretKey: "sk_test_SYNTHETICONLY",
    apiVersion: "2024-06-20",
    connectedAccount: null,
    now: () => "2026-09-11T21:00:00.000Z",
    fetch,
  });
  return { fetch, adapter };
}
it("composes request, transport and normalization without exposing client credentials", async () => {
  const { fetch, adapter } = setup();
  fetch.mockResolvedValueOnce(Response.json(raw));
  const result = await adapter.createIntent(request);
  expect(result.kind).toBe("Snapshot");
  expect(result).not.toHaveProperty("client_secret");
  if (result.kind !== "Snapshot") throw new Error("expected snapshot");
  expect(result.status).toBe("RequiresCustomerAction");
  expect(result.capturedAmount.amountMinor).toBe(0n);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("retrieves the original intent and rejects an unrelated response", async () => {
  const { fetch, adapter } = setup();
  const retrieve = createRetrieveIntentRequest({
    operation: "RetrieveIntent",
    purpose: "RetrievePaymentIntent",
    context: request.context,
    providerIntentReference: raw.id as never,
  });
  fetch.mockResolvedValueOnce(Response.json(raw));
  expect((await adapter.retrieveIntent(retrieve)).kind).toBe("Snapshot");
  expect(fetch.mock.calls[0]?.[0]).toContain("/pi_SYNTHETIC000001?expand");
  fetch.mockResolvedValueOnce(Response.json({ ...raw, id: "pi_OTHER000001" }));
  expect(await adapter.retrieveIntent(retrieve)).toMatchObject({
    kind: "Failure",
    code: "Unknown",
    retryDisposition: "Unknown",
  });
});
it("preserves uncertainty for HTTP, network and invalid payment results without retries", async () => {
  const { fetch, adapter } = setup();
  fetch.mockResolvedValueOnce(Response.json({}, { status: 500 }));
  fetch.mockRejectedValueOnce(new Error("sensitive"));
  fetch.mockResolvedValueOnce(Response.json({ ...raw, amount: 1 }));
  for (let i = 0; i < 3; i++) {
    expect(await adapter.createIntent(request)).toMatchObject({
      kind: "Failure",
      code: "Unknown",
      retryDisposition: "Unknown",
      safeReasonCode: "STRIPE_RESULT_UNRESOLVED",
    });
  }
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each([false, true])(
  "integrates actual creation service and recovers without another request (ambiguous=%s)",
  async (ambiguous) => {
    const fixture = harness();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      expect(fixture.calls).toContain("claim");
      const parameters = new URLSearchParams(String(init?.body));
      expect(parameters.get("amount")).toBe(
        fixture.stored()?.intent.preparation.total.amountMinor.toString(),
      );
      expect(
        fixture.ports.references.hash(new Headers(init?.headers).get("idempotency-key") ?? ""),
      ).toBe(fixture.stored()?.attempt.providerIdempotencyDigest);
      if (ambiguous) throw new Error("synthetic lost Provider response");
      return Response.json({ ...raw, amount: Number(parameters.get("amount")) });
    });
    const stripe = createStripeOnlineIntentAdapter({
      brandReference: refs.brand,
      storeReference: refs.store,
      environment: "Test",
      secretKey: "sk_test_SYNTHETICONLY",
      apiVersion: "2024-06-20",
      connectedAccount: null,
      now: () => at,
      fetch,
    });
    const service = createPaymentIntentCreationService({
      ...fixture.ports,
      provider: { ...fixture.ports.provider, ...stripe },
    });
    const result = await service.create(command());
    expect(result.status).toBe("Created");
    expect(result.record.providerOutcome?.kind).toBe(ambiguous ? "Failure" : "Snapshot");
    expect(fixture.calls).toContain("record-observation");
    const replay = await service.create(command());
    expect(replay.status).toBe("AlreadyCreated");
    expect(replay.record).toEqual(result.record);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.record).not.toHaveProperty("client_secret");
  },
);
it("WP-2423 abandoned payment: cancels an unconfirmed intent idempotently and normalizes the answer", async () => {
  const { fetch, adapter } = setup();
  fetch.mockResolvedValueOnce(
    Response.json({ ...raw, status: "canceled", cancellation_reason: "abandoned" }),
  );
  const cancelled = await adapter.cancelIntent({
    operation: "CancelIntent",
    purpose: "CancelPaymentIntent",
    context: context as never,
    idempotencyKey: "cancel-abandoned:0198a001-0000-7000-8000-000000000003" as never,
    providerIntentReference: "pi_SYNTHETIC000001" as never,
  });
  expect(cancelled).toMatchObject({ kind: "Snapshot", status: "Cancelled" });
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(url).toBe("https://api.stripe.com/v1/payment_intents/pi_SYNTHETIC000001/cancel");
  expect(init?.method).toBe("POST");
  expect(String(init?.body)).toContain("cancellation_reason=abandoned");
  expect((init?.headers as Record<string, string>)["Idempotency-Key"]).toBe(
    "cancel-abandoned:0198a001-0000-7000-8000-000000000003",
  );
  // Stripe refuses to cancel a succeeded intent: the answer stays unresolved (retrieve it).
  fetch.mockResolvedValueOnce(new Response("{}", { status: 400 }));
  expect(
    (
      await adapter.cancelIntent({
        operation: "CancelIntent",
        purpose: "CancelPaymentIntent",
        context: context as never,
        idempotencyKey: "cancel-abandoned:0198a001-0000-7000-8000-000000000003" as never,
        providerIntentReference: "pi_SYNTHETIC000001" as never,
      })
    ).kind,
  ).toBe("Failure");
  // An answer for another intent is never accepted as this one's cancellation.
  fetch.mockResolvedValueOnce(
    Response.json({ ...raw, id: "pi_SYNTHETICOTHER", status: "canceled" }),
  );
  expect(
    (
      await adapter.cancelIntent({
        operation: "CancelIntent",
        purpose: "CancelPaymentIntent",
        context: context as never,
        idempotencyKey: "cancel-abandoned:0198a001-0000-7000-8000-000000000003" as never,
        providerIntentReference: "pi_SYNTHETIC000001" as never,
      })
    ).kind,
  ).toBe("Failure");
});
