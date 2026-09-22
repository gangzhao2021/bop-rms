import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import {
  createPaymentIntentCreationService,
  PaymentIntentCreationError,
  PaymentTipSelectionError,
} from "@rms/payment";
import {
  CartError,
  CheckoutValidationError,
  OrderCreationError,
  parseCheckoutSession,
} from "@rms/ordering";
import {
  at,
  id,
  refs,
  harness,
  command,
  preparation,
} from "../../../packages/rms/payment/src/tests/payment-intent-creation.fixture.js";
import { createApp } from "./app.js";
import {
  CustomerPaymentIntentHandler,
  type CustomerPaymentIntentPort,
} from "./customer-payment-intent.js";
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
async function setup(enabled = true) {
  const original = await createPaymentIntentCreationService(
    harness({ prepared: preparation({ committedAt: at }) }).ports,
  ).create(command({ tipSelectionReference: id(30) }));
  const binding = {
    brandReference: refs.brand,
    storeReference: refs.store,
    cartReference: refs.cart,
    cartVersion: 3,
    quoteReference: refs.quote,
    orderType: "Pickup",
    sourceChannel: "Qr",
  };
  const session = parseCheckoutSession({
    schemaVersion: 1,
    checkoutSessionReference: id(31),
    createOperationReference: id(32),
    submissionReference: refs.submission,
    paymentOperationReference: refs.operation,
    createdAt: at,
    validation: {
      ...binding,
      validationReference: id(33),
      validationIntentHash: "sha256:" + "a".repeat(64),
      guestSessionReference: refs.session,
      quoteVersion: 1,
      quoteInputDigest: "sha256:" + "b".repeat(64),
      catalogLines: [
        {
          cartItemReference: id(34),
          sellableReference: id(35),
          menuVersionReference: id(36),
          productVersionReference: id(37),
          validatedAt: at,
        },
      ],
      fulfillment: {
        ...binding,
        status: "Accepted",
        evidenceReference: refs.capacity,
        evidenceVersion: 1,
        evidenceDigest: "sha256:" + "c".repeat(64),
        checkedAt: at,
        validUntil: "2026-08-03T15:05:00.000Z",
      },
      validatedAt: at,
      validUntil: "2026-08-03T15:05:00.000Z",
    },
  });

  const result = { ...original, session };
  const create = vi.fn<CustomerPaymentIntentPort["create"]>().mockResolvedValue(result);
  const server = createServer(
    createApp(
      enabled
        ? {
            customerPaymentIntent: new CustomerPaymentIntentHandler({
              port: { create },
              allowedOrigin: "https://customer.example",
            }),
          }
        : {},
    ),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url =
    "http://127.0.0.1:" +
    (server.address() as AddressInfo).port +
    "/api/v1/checkout-sessions/" +
    id(31) +
    "/payment-intents";
  const headers = {
    origin: "https://customer.example",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "idempotency-key": id(30),
    "x-csrf-token": "c".repeat(43),
    cookie: "__Host-bop-guest=" + "s".repeat(43),
  };
  const body = { tip: { amountMinor: "200", currency: "CAD" } };
  const send = (payload: unknown = body, overrides: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { ...headers, ...overrides },
      body: JSON.stringify(payload),
    });
  return { result, create, body, send };
}
it.each([
  ["Created", 201],
  ["AlreadyCreated", 200],
  ["Processing", 202],
] as const)("projects %s without implying payment success", async (status, expectedStatus) => {
  const f = await setup();
  f.create.mockResolvedValue({ ...f.result, status });
  const response = await f.send();
  expect(response.status).toBe(expectedStatus);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await response.json()).toEqual({
    schemaVersion: 1,
    payment: {
      checkoutSessionReference: id(31),
      paymentIntentReference: refs.intent,
      orderReference: refs.order,
      creationStatus: status,
      total: { amountMinor: "2200", currency: "CAD" },
    },
  });
  expect(f.create).toHaveBeenCalledWith({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    checkoutSessionReference: id(31),
    selectionReference: id(30),
    tip: { amountMinor: 200n, currencyCode: "CAD" },
  });
});
it("rejects inexact money and unknown owner inputs before service invocation", async () => {
  const f = await setup();
  for (const amountMinor of [200, "-1", "1.5", "01", "9223372036854775808"]) {
    expect((await f.send({ tip: { amountMinor, currency: "CAD" } })).status).toBe(400);
  }
  expect((await f.send({ ...f.body, paymentOperationReference: id(40) })).status).toBe(400);
  expect((await f.send({ tip: { amountMinor: "200", currency: "USD" } })).status).toBe(400);
  expect(f.create).not.toHaveBeenCalled();
});
it("rejects cross-origin, absent CSRF, duplicate Guest cookie and invalid key", async () => {
  const f = await setup();
  for (const headers of [
    { origin: "https://foreign.example" },
    { "x-csrf-token": "" },
    { "idempotency-key": "invalid" },
    { cookie: "__Host-bop-guest=" + "s".repeat(43) + "; __Host-bop-guest=" + "s".repeat(43) },
  ]) {
    expect((await f.send(f.body, headers)).status).toBe(400);
  }
  expect(f.create).not.toHaveBeenCalled();
});
it.each([
  ["PAYMENT_INTENT_PERMISSION_DENIED", 404],
  ["PAYMENT_INTENT_IDEMPOTENCY_CONFLICT", 409],
  ["PAYMENT_INTENT_PREPARATION_EXPIRED", 422],
  ["PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE", 503],
] as const)("maps %s safely", async (code, status) => {
  const f = await setup();
  f.create.mockRejectedValue(new PaymentIntentCreationError(code));
  const response = await f.send();
  expect(response.status).toBe(status);
  expect(await response.text()).not.toContain("paymentOperationReference");
});
it("rejects mismatched owner session and unsupported status", async () => {
  const f = await setup();
  f.create.mockResolvedValue({
    ...f.result,
    session: { ...f.result.session, checkoutSessionReference: id(40) },
  });
  expect((await f.send()).status).toBe(503);
  f.create.mockResolvedValue({ ...f.result, status: "Paid" });
  expect((await f.send()).status).toBe(503);
});
it("fails closed before runtime configuration", async () => {
  const f = await setup(false);
  expect((await f.send()).status).toBe(503);
});

it.each([
  [new OrderCreationError("ORDER_CREATE_PERMISSION_DENIED"), 404],
  [new OrderCreationError("ORDER_CREATE_VALIDATION_EXPIRED"), 422],
  [new CheckoutValidationError("CHECKOUT_ITEM_UNAVAILABLE"), 422],
  [new CartError("CART_VERSION_CONFLICT"), 409],
  [new PaymentTipSelectionError("PAYMENT_TIP_CONFLICT"), 409],
  [new PaymentTipSelectionError("PAYMENT_TIP_INVALID"), 400],
  [new PaymentTipSelectionError("PAYMENT_TIP_UNAVAILABLE"), 503],
] as const)("maps preparation error %s to actionable HTTP status", async (error, status) => {
  const f = await setup();
  f.create.mockRejectedValue(error);
  const response = await f.send();
  expect(response.status).toBe(status);
  expect(response.headers.get("retry-after")).toBe(status === 503 ? "5" : null);
  expect(await response.text()).not.toContain(error.code);
});
