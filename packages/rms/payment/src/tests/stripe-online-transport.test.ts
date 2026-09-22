import { expect, it, vi } from "vitest";
import { createStripeOnlineTransport } from "../infrastructure/stripe/stripe-online-transport.js";
import {
  createCreateIntentRequest,
  createRefundPaymentRequest,
} from "../application/payment-provider-adapter.js";
import type { CreateIntentRequest } from "../contracts/payment-provider-adapter.js";

const scope = {
  brandReference: "0198a001-0000-7000-8000-000000000001",
  storeReference: "0198a001-0000-7000-8000-000000000002",
  environment: "Test" as const,
};
const config = {
  ...scope,
  apiVersion: "2024-06-20",
  secretKey: "sk_test_SYNTHETICONLY",
  connectedAccount: null,
};
const request = () =>
  createCreateIntentRequest({
    operation: "CreateIntent",
    purpose: "CreatePaymentIntent",
    context: {
      ...scope,
      provider: "Stripe",
      paymentAttemptReference: "0198a001-0000-7000-8000-000000000003",
      operationReference: "0198a001-0000-7000-8000-000000000004",
    } as CreateIntentRequest["context"],
    paymentMethod: "OnlineCard",
    captureMode: "Automatic",
    amount: { amountMinor: 1250n, currencyCode: "CAD" as never },
    idempotencyKey: "SYNTHETIC:CREATE:0001" as never,
  });
it("sends the original intent with explicit account/version and disabled redirects", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ object: "payment_intent" }));
  const transport = createStripeOnlineTransport({
    ...config,
    connectedAccount: "acct_SYNTHETIC",
    fetch,
  });
  expect(await transport.send(request())).toEqual({
    status: 200,
    payload: { object: "payment_intent" },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(url).toBe("https://api.stripe.com/v1/payment_intents");
  expect(init?.redirect).toBe("error");
  expect(init?.headers).toMatchObject({
    "Stripe-Account": "acct_SYNTHETIC",
    "Stripe-Version": config.apiVersion,
    "Idempotency-Key": "SYNTHETIC:CREATE:0001",
  });
  expect(init?.signal).toBeInstanceOf(AbortSignal);
});
it("rejects cross-store requests before network access and mismatched key environments", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const transport = createStripeOnlineTransport({ ...config, fetch });
  const input = request();
  await expect(
    transport.send({
      ...input,
      context: {
        ...input.context,
        storeReference: "0198a001-0000-7000-8000-000000000009" as never,
      },
    }),
  ).rejects.toMatchObject({ code: "SCOPE_MISMATCH" });
  expect(fetch).not.toHaveBeenCalled();
  expect(() => createStripeOnlineTransport({ ...config, environment: "Live", fetch })).toThrow();
});
it("does not retry or retain raw provider failures", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ error: { message: "sensitive" } }, { status: 429 }));
  const transport = createStripeOnlineTransport({ ...config, fetch });
  expect(await transport.send(request())).toEqual({ status: 429, payload: null });
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockRejectedValue(new Error("sensitive network error"));
  await expect(transport.send(request())).rejects.toMatchObject({
    code: "RESPONSE_UNAVAILABLE",
    message: "payment provider transport unavailable",
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("rejects malformed or oversized responses without exposing payloads", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const transport = createStripeOnlineTransport({ ...config, fetch });
  for (const response of [
    new Response("not json", { headers: { "content-type": "application/json" } }),
    new Response("x".repeat(1_048_577), { headers: { "content-type": "application/json" } }),
    new Response("<html>unexpected</html>", { headers: { "content-type": "text/html" } }),
  ]) {
    fetch.mockResolvedValueOnce(response);
    await expect(transport.send(request())).rejects.toMatchObject({ code: "RESPONSE_UNAVAILABLE" });
  }
});

const refund = () => {
  const original = request();
  return createRefundPaymentRequest({
    operation: "RefundPayment",
    purpose: "RefundPayment",
    context: original.context,
    amount: original.amount,
    providerIntentReference: "pi_syntheticRefund" as never,
    originalPaymentMethod: "OnlineCard",
    idempotencyKey: ("ordinary-refund:" + original.context.operationReference) as never,
  });
};
it("sends a refund only to the fixed endpoint with original key and scoped account", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ object: "refund" }));
  const transport = createStripeOnlineTransport({
    ...config,
    connectedAccount: "acct_SYNTHETIC",
    fetch,
  });
  expect(await transport.refund(refund())).toEqual({ status: 200, payload: { object: "refund" } });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(url).toBe("https://api.stripe.com/v1/refunds");
  expect(init?.method).toBe("POST");
  expect(init?.redirect).toBe("error");
  expect(init?.headers).toMatchObject({
    "Stripe-Account": "acct_SYNTHETIC",
    "Stripe-Version": config.apiVersion,
    "Idempotency-Key": refund().idempotencyKey,
  });
  expect(new URLSearchParams(String(init?.body)).get("amount")).toBe("1250");
});
it("queries a refund page without a mutation body or idempotency header", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ object: "list", data: [], has_more: false }));
  const transport = createStripeOnlineTransport({ ...config, fetch });
  await transport.listRefunds(refund(), "re_syntheticCursor");
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(String(url)).toBe(
    "https://api.stripe.com/v1/refunds?payment_intent=pi_syntheticRefund&limit=100&starting_after=re_syntheticCursor",
  );
  expect(init?.method).toBe("GET");
  expect(init?.body).toBeUndefined();
  expect(init?.headers).not.toHaveProperty("Idempotency-Key");
  expect(init?.redirect).toBe("error");
});
it("rejects foreign refund scope and invalid cursor before network access", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const transport = createStripeOnlineTransport({ ...config, fetch });
  const value = refund();
  const foreign = {
    ...value,
    context: { ...value.context, storeReference: "0198a001-0000-7000-8000-000000000009" as never },
  };
  await expect(transport.refund(foreign)).rejects.toMatchObject({ code: "SCOPE_MISMATCH" });
  await expect(transport.listRefunds(foreign)).rejects.toMatchObject({ code: "SCOPE_MISMATCH" });
  await expect(transport.listRefunds(value, "re_bad/escape")).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it("does not retry failed refunds or expose unbounded response data", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ error: "synthetic private detail" }, { status: 503 }));
  const transport = createStripeOnlineTransport({ ...config, fetch });
  expect(await transport.refund(refund())).toEqual({ status: 503, payload: null });
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockRejectedValueOnce(new Error("synthetic private error"));
  await expect(transport.refund(refund())).rejects.toMatchObject({
    code: "RESPONSE_UNAVAILABLE",
    message: "payment provider transport unavailable",
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockResolvedValueOnce(
    new Response("x".repeat(1_048_577), { headers: { "content-type": "application/json" } }),
  );
  await expect(transport.listRefunds(refund())).rejects.toMatchObject({
    code: "RESPONSE_UNAVAILABLE",
  });
  expect(fetch).toHaveBeenCalledTimes(3);
});
