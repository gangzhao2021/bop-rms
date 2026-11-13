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
  CheckoutSessionServiceError,
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
import { DiningCheckoutServiceError, DiningCheckoutStoreError } from "@rms/dining";
import { createApp } from "./app.js";
import { CustomerStoreClosedError } from "./customer-store-open-gate.js";
import { CustomerDiningPayLaterError } from "./customer-dining-pay-later-round.js";
import { customerRoundRefusal, customerRoundRefusalLine } from "./customer-round-refusal.js";
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
  const retry = vi
    .fn<NonNullable<CustomerPaymentIntentPort["retry"]>>()
    .mockResolvedValue({ ...result, status: "Created" });
  const resume = vi
    .fn<NonNullable<CustomerPaymentIntentPort["resume"]>>()
    .mockResolvedValue({ ...result, status: "AlreadyCreated" });
  const sendToKitchen = vi
    .fn<NonNullable<CustomerPaymentIntentPort["sendToKitchen"]>>()
    .mockResolvedValue({ status: "Sent", orderReference: id(40), totalMinor: 2260n });
  const stoppedByGuest = vi
    .fn<NonNullable<CustomerPaymentIntentPort["stoppedByGuest"]>>()
    .mockResolvedValue(false);
  const roundCancelled = vi
    .fn<NonNullable<CustomerPaymentIntentPort["roundCancelled"]>>()
    .mockResolvedValue(false);
  const server = createServer(
    createApp(
      enabled
        ? {
            customerPaymentIntent: new CustomerPaymentIntentHandler({
              port: { create, retry, resume, sendToKitchen, stoppedByGuest, roundCancelled },
              allowedOrigin: "https://customer.example",
              now: () => "2026-08-03T15:01:00.000Z",
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
  /** WP-2423 Q20: a retry request carries no tip and no selection key. */
  const { "idempotency-key": _key, ...retryHeaders } = headers;
  void _key;
  const sendRetry = (payload: unknown = { retry: true }, extra: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { ...retryHeaders, ...extra },
      body: JSON.stringify(payload),
    });
  return {
    result,
    create,
    retry,
    resume,
    sendToKitchen,
    stoppedByGuest,
    roundCancelled,
    body,
    send,
    sendRetry,
  };
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
      // WP-2423 M19: until when this payment can be finished, with the server's time.
      payBy: "2026-08-03T15:30:00.000Z",
    },
    serverNow: "2026-08-03T15:01:00.000Z",
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
it("WP-2423 Q4: says the Store stopped taking orders when payment would start after it", async () => {
  const f = await setup();
  f.create.mockRejectedValue(new CustomerStoreClosedError());
  const response = await f.send();
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    schemaVersion: 1,
    error: { code: "payment_store_closed", messageKey: "customer.payment.store_closed" },
  });
});

it.each([
  new OrderCreationError("ORDER_CREATE_STOCK_SHORT"),
  new CheckoutValidationError("CHECKOUT_STOCK_SHORT", {
    cartItemReference: "018f5400-0000-7000-8000-000000000070" as never,
    available: 0,
    sharedStock: true,
  }),
])("WP-2423: says items ran out after checkout (nothing placed or charged): %s", async (error) => {
  const f = await setup();
  f.create.mockRejectedValue(error);
  const response = await f.send();
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    schemaVersion: 1,
    error: { code: "payment_items_short", messageKey: "customer.payment.items_short" },
  });
});

it("v15 batch-5: a payment for a round its payer stopped is refused as that at once, not as an outage", async () => {
  const f = await setup();
  f.create.mockRejectedValue(new Error("SIMULATION_OUTCOME_CONFLICT"));
  // Not stopped (or the answer can't be read): still the outage it was.
  expect((await f.send()).status).toBe(503);
  f.stoppedByGuest.mockRejectedValueOnce(new Error("synthetic outage"));
  expect((await f.send()).status).toBe(503);
  f.stoppedByGuest.mockResolvedValue(true);
  const response = await f.send();
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    schemaVersion: 1,
    error: { code: "payment_round_returned", messageKey: "customer.payment.round_returned" },
  });
  expect(f.stoppedByGuest).toHaveBeenLastCalledWith({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    checkoutSessionReference: id(31),
  });
  // An answer the guest can act on is never replaced by it.
  f.create.mockRejectedValue(new OrderCreationError("ORDER_CREATE_TABLE_MOVED"));
  expect((await f.send()).status).toBe(409);
  expect(f.stoppedByGuest).toHaveBeenCalledTimes(3);
});

// v15 b15 (order 12): Confirm on a page still open on a round staff cancelled answered 503
// "payment service unavailable" for ~30 s, then the page said the payment timed out.
it("a payment for a round staff or the System cancelled is refused as cancelled at once, not as an outage", async () => {
  const f = await setup();
  f.create.mockRejectedValue(new Error("SIMULATION_OUTCOME_CONFLICT"));
  expect((await f.send()).status).toBe(503);
  f.roundCancelled.mockRejectedValueOnce(new Error("synthetic outage"));
  expect((await f.send()).status).toBe(503);
  f.roundCancelled.mockResolvedValue(true);
  const response = await f.send();
  expect(response.status).toBe(409);
  expect(response.headers.get("retry-after")).toBeNull();
  expect(await response.json()).toEqual({
    schemaVersion: 1,
    error: { code: "payment_round_cancelled", messageKey: "customer.payment.round_cancelled" },
  });
  expect(f.roundCancelled).toHaveBeenLastCalledWith({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    checkoutSessionReference: id(31),
  });
  // Its payer stopping it is said first, as before; an answer the guest can act on stays.
  f.stoppedByGuest.mockResolvedValueOnce(true);
  expect((await (await f.send()).json()).error.code).toBe("payment_round_returned");
  f.create.mockRejectedValue(new OrderCreationError("ORDER_CREATE_TABLE_MOVED"));
  expect((await (await f.send()).json()).error.code).toBe("payment_table_moved");
  expect(f.roundCancelled).toHaveBeenCalledTimes(3);
});

it("WP-2423: says staff moved the table while the round was being sent (nothing placed or charged)", async () => {
  const f = await setup();
  f.create.mockRejectedValue(new OrderCreationError("ORDER_CREATE_TABLE_MOVED"));
  const response = await f.send();
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    schemaVersion: 1,
    error: { code: "payment_table_moved", messageKey: "customer.payment.table_moved" },
  });
});

it("WP-2423 table-move-send: a pay-later round sent after staff moved the table says so too", async () => {
  const f = await setup();
  f.sendToKitchen.mockRejectedValueOnce(new OrderCreationError("ORDER_CREATE_TABLE_MOVED"));
  const response = await f.send({ sendToKitchen: true });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    schemaVersion: 1,
    error: { code: "payment_table_moved", messageKey: "customer.payment.table_moved" },
  });
  expect(f.create).not.toHaveBeenCalled();
});

it.each([
  [new CheckoutValidationError("CHECKOUT_REQUOTE_REQUIRED"), 422],
  [new CheckoutSessionServiceError("REQUOTE_REQUIRED"), 409],
])(
  "WP-2423: says the menu moved on after checkout began (nothing placed or charged): %s",
  async (error, status) => {
    const f = await setup();
    f.create.mockRejectedValue(error);
    const response = await f.send();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      error: { code: "payment_requote_required", messageKey: "customer.payment.requote_required" },
    });
  },
);

it.each([
  [
    "a second checkout at the same Cart version",
    () =>
      new OrderCreationError("ORDER_CREATE_ALREADY_ORDERED", {
        placedOrder: { orderReference: id(71), orderNumber: "13" },
      }),
  ],
  [
    "a checkout that lost the race to another tab",
    () =>
      new CheckoutSessionServiceError("ALREADY_ORDERED", null, null, {
        orderReference: id(71),
        orderNumber: "13",
      }),
  ],
])("WP-2423 M03: refuses to pay again for dishes already ordered: %s", async (_case, error) => {
  const f = await setup();
  for (const send of [
    () => {
      f.create.mockRejectedValueOnce(error());
      return f.send();
    },
    () => {
      f.retry.mockRejectedValueOnce(error());
      return f.sendRetry({ retry: true });
    },
    () => {
      f.resume.mockRejectedValueOnce(error());
      return f.sendRetry({ resume: true });
    },
  ]) {
    const response = await send();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      error: {
        code: "payment_already_ordered",
        messageKey: "customer.payment.already_ordered",
        order: { orderReference: id(71), orderNumber: "13" },
      },
    });
  }
  f.create.mockRejectedValueOnce(new OrderCreationError("ORDER_CREATE_ALREADY_ORDERED"));
  expect(await (await f.send()).json()).toEqual({
    schemaVersion: 1,
    error: { code: "payment_already_ordered", messageKey: "customer.payment.already_ordered" },
  });
});

it("WP-2423 abandoned payment: returns to the open payment for {resume:true} only", async () => {
  const f = await setup();
  const response = await f.sendRetry({ resume: true });
  expect(response.status).toBe(200);
  expect(((await response.json()) as { payment: unknown }).payment).toMatchObject({
    paymentIntentReference: refs.intent,
    creationStatus: "AlreadyCreated",
  });
  expect(f.resume).toHaveBeenCalledWith({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    checkoutSessionReference: id(31),
  });
  expect(f.create).not.toHaveBeenCalled();
  expect(f.retry).not.toHaveBeenCalled();
  f.resume.mockClear();
  for (const [payload, extra] of [
    [{ resume: false }, {}],
    [{ resume: true, tip: f.body.tip }, {}],
    [{ resume: true, retry: true }, {}],
    [{ resume: true }, { "idempotency-key": id(30) }],
  ] as const)
    expect((await f.sendRetry(payload, extra)).status).toBe(400);
  expect(f.resume).not.toHaveBeenCalled();
});
it("WP-2423 Q20: opens another card on the existing payment for {retry:true} only", async () => {
  const f = await setup();
  const response = await f.sendRetry();
  expect(response.status).toBe(201);
  expect(((await response.json()) as { payment: unknown }).payment).toMatchObject({
    paymentIntentReference: refs.intent,
    creationStatus: "Created",
    total: { amountMinor: "2200", currency: "CAD" },
  });
  expect(f.retry).toHaveBeenCalledWith({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    checkoutSessionReference: id(31),
  });
  expect(f.create).not.toHaveBeenCalled();
  f.retry.mockClear();
  for (const [payload, extra] of [
    [{ retry: false }, {}],
    [{ retry: true, tip: f.body.tip }, {}],
    [{ retry: "true" }, {}],
    [{ retry: true }, { "idempotency-key": id(30) }],
    [{ retry: true }, { origin: "https://foreign.example" }],
  ] as const)
    expect((await f.sendRetry(payload, extra)).status).toBe(400);
  expect(f.retry).not.toHaveBeenCalled();
});
it.each([
  ["PAYMENT_INTENT_RETRY_LIMIT_REACHED", 409, "payment_retry_limit"],
  ["PAYMENT_INTENT_RETRY_NOT_ALLOWED", 409, "payment_retry_pending"],
  ["PAYMENT_INTENT_ALREADY_PAID", 409, "payment_already_paid"],
  ["PAYMENT_INTENT_PREPARATION_EXPIRED", 422, "payment_window_ended"],
  ["PAYMENT_INTENT_PERMISSION_DENIED", 404, "payment_not_found"],
] as const)(
  "WP-2423 Q20: tells the customer why %s stops another card",
  async (code, status, named) => {
    const f = await setup();
    f.retry.mockRejectedValue(new PaymentIntentCreationError(code));
    const response = await f.sendRetry();
    expect(response.status).toBe(status);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(named);
  },
);

it("DEC-DINE-IN-PAY-LATER: sends a pay-later table's round to the kitchen with no tip or payment", async () => {
  const { send, sendToKitchen, create } = await setup();
  const sent = await send({ sendToKitchen: true });
  expect(sent.status).toBe(201);
  expect(await sent.json()).toEqual({
    schemaVersion: 1,
    round: {
      checkoutSessionReference: id(31),
      orderReference: id(40),
      status: "Sent",
      total: { amountMinor: "2260", currency: "CAD" },
    },
  });
  expect(sendToKitchen).toHaveBeenCalledWith({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    checkoutSessionReference: id(31),
    selectionReference: id(30),
  });
  expect(create).not.toHaveBeenCalled();
  // Sent again with the same key: the same round, never a second one.
  sendToKitchen.mockResolvedValueOnce({
    status: "AlreadySent",
    orderReference: id(40),
    totalMinor: 2260n,
  });
  expect((await send({ sendToKitchen: true })).status).toBe(200);
  // No key, a tip alongside, or anything but true is refused before the service.
  const calls = sendToKitchen.mock.calls.length;
  expect((await send({ sendToKitchen: true }, { "idempotency-key": "x" })).status).toBe(400);
  expect(
    (await send({ sendToKitchen: true, tip: { amountMinor: "0", currency: "CAD" } })).status,
  ).toBe(400);
  expect((await send({ sendToKitchen: "yes" })).status).toBe(400);
  expect(sendToKitchen.mock.calls.length).toBe(calls);
  // A table that pays as it orders is told so (the guest pays the round instead).
  sendToKitchen.mockRejectedValueOnce(new CustomerDiningPayLaterError("PayFirst"));
  const payFirst = await send({ sendToKitchen: true });
  expect(payFirst.status).toBe(409);
  expect(((await payFirst.json()) as { error: { code: string } }).error.code).toBe(
    "payment_pay_first_table",
  );
  // Paying a round at a table that pays at the end is refused with its own reason.
  create.mockRejectedValueOnce(new CustomerDiningPayLaterError("PayLater"));
  const payLater = await send();
  expect(payLater.status).toBe(409);
  expect(((await payLater.json()) as { error: { code: string } }).error.code).toBe(
    "payment_pay_later_table",
  );
  sendToKitchen.mockRejectedValueOnce(new CustomerStoreClosedError());
  expect((await send({ sendToKitchen: true })).status).toBe(409);
});

it("WP-2423 item 8 ⑤: a round that waits for staff is answered 202 Held with why, and nothing else", async () => {
  const { send, sendToKitchen } = await setup();
  sendToKitchen.mockResolvedValueOnce({
    status: "Held",
    waitingReason: "FirstOrder",
    orderReference: id(40),
    totalMinor: 2260n,
  });
  const held = await send({ sendToKitchen: true });
  expect(held.status).toBe(202);
  expect(await held.json()).toEqual({
    schemaVersion: 1,
    round: {
      checkoutSessionReference: id(31),
      orderReference: id(40),
      status: "Held",
      waitingReason: "FirstOrder",
      total: { amountMinor: "2260", currency: "CAD" },
    },
  });
  // Held without its reason (or a reason on a sent round) is an inconsistent answer.
  sendToKitchen.mockResolvedValueOnce({
    status: "Held",
    orderReference: id(40),
    totalMinor: 2260n,
  });
  expect((await send({ sendToKitchen: true })).status).toBe(503);
});

it.each([
  [new OrderCreationError("ORDER_CREATE_TABLE_MOVED"), "TABLE_MOVED"],
  [new OrderCreationError("ORDER_CREATE_STOCK_SHORT"), "ITEMS_SHORT"],
  [new CheckoutSessionServiceError("ITEM_SHORT"), "ITEMS_SHORT"],
  [new CheckoutSessionServiceError("REQUOTE_REQUIRED"), "REQUOTE_REQUIRED"],
  [new CheckoutSessionServiceError("STORE_CLOSED"), "STORE_CLOSED"],
  [new CustomerStoreClosedError(), "STORE_CLOSED"],
  [new PaymentTipSelectionError("PAYMENT_TIP_TURNED_OFF"), "TIPS_TURNED_OFF"],
  [new CustomerDiningPayLaterError("PayLater"), "PAY_LATER_TABLE"],
  [new CustomerDiningPayLaterError("PayFirst"), "PAY_FIRST_TABLE"],
] as const)(
  "WP-2423 expected refusals: %s is told to the guest in plain words and logged as information",
  async (error, refusal) => {
    const f = await setup();
    f.create.mockRejectedValue(error);
    const response = await f.send();
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "payment_" + refusal.toLowerCase(),
    );
    expect(customerRoundRefusal(error)).toBe(refusal);
    expect(JSON.parse(customerRoundRefusalLine("CUSTOMER_ROUND_REFUSED", error) ?? "null")).toEqual(
      { level: 30, time: expect.any(String), event: "CUSTOMER_ROUND_REFUSED", code: refusal },
    );
  },
);
it("WP-2423 expected refusals: a refused next card is information; anything else stays a failure", async () => {
  for (const [code, refusal] of [
    ["PAYMENT_INTENT_RETRY_LIMIT_REACHED", "RETRY_LIMIT"],
    ["PAYMENT_INTENT_RETRY_NOT_ALLOWED", "RETRY_PENDING"],
    ["PAYMENT_INTENT_ALREADY_PAID", "ALREADY_PAID"],
    ["PAYMENT_INTENT_PREPARATION_EXPIRED", "WINDOW_ENDED"],
  ] as const) {
    const f = await setup();
    f.retry.mockRejectedValue(new PaymentIntentCreationError(code));
    const response = await f.sendRetry();
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "payment_" + refusal.toLowerCase(),
    );
    expect(customerRoundRefusal(new PaymentIntentCreationError(code))).toBe(refusal);
  }
  // Shape, not class identity: a second copy of the owner module refuses the same way.
  expect(
    customerRoundRefusal({ name: "OrderCreationError", code: "ORDER_CREATE_TABLE_MOVED" }),
  ).toBe("TABLE_MOVED");
  for (const error of [
    new OrderCreationError("ORDER_CREATE_PERMISSION_DENIED"),
    new CheckoutSessionServiceError("DEPENDENCY_UNAVAILABLE"),
    new PaymentIntentCreationError("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE"),
    new PaymentTipSelectionError("PAYMENT_TIP_UNAVAILABLE"),
    new CustomerDiningPayLaterError("Unavailable"),
    new Error("ORDER_CREATE_TABLE_MOVED"),
    { name: "toString", code: "x" },
    null,
    "TABLE_MOVED",
  ]) {
    expect(customerRoundRefusal(error)).toBeNull();
    expect(customerRoundRefusalLine("CUSTOMER_ROUND_REFUSED", error)).toBeNull();
  }
});

/**
 * WP-2423 staff-wording-and-expected-refusals (review of 2ea4f62d): the other ordinary moments of
 * service the handler already answers as a refusal (409/422, never 503) are information too:
 * another guest at the table is paying, a dish came off the menu, the checkout window lapsed.
 */
it.each([
  [new CheckoutSessionServiceError("CHECKOUT_IN_PROGRESS"), 409, "CHECKOUT_IN_PROGRESS"],
  [new CheckoutSessionServiceError("ITEM_UNAVAILABLE"), 409, "ITEM_UNAVAILABLE"],
  [new CheckoutValidationError("CHECKOUT_ITEM_UNAVAILABLE"), 422, "ITEM_UNAVAILABLE"],
  [new CheckoutValidationError("CHECKOUT_QUOTE_EXPIRED"), 422, "CHECKOUT_EXPIRED"],
  [new OrderCreationError("ORDER_CREATE_VALIDATION_EXPIRED"), 422, "CHECKOUT_EXPIRED"],
] as const)(
  "WP-2423 expected refusals: %s is answered as a refusal and logged as information",
  async (error, status, refusal) => {
    const f = await setup();
    f.create.mockRejectedValue(error);
    expect((await f.send()).status).toBe(status);
    expect(customerRoundRefusal(error)).toBe(refusal);
    expect(JSON.parse(customerRoundRefusalLine("CUSTOMER_ROUND_REFUSED", error) ?? "null")).toEqual(
      { level: 30, time: expect.any(String), event: "CUSTOMER_ROUND_REFUSED", code: refusal },
    );
  },
);
it.each([
  new DiningCheckoutStoreError("DINING_CHECKOUT_STORE_TABLE_MOVED"),
  new DiningCheckoutServiceError("DINING_CHECKOUT_TABLE_MOVED"),
  { name: "DiningCheckoutStoreError", code: "DINING_CHECKOUT_STORE_TABLE_MOVED" },
  { name: "DiningCheckoutServiceError", code: "DINING_CHECKOUT_TABLE_MOVED" },
])(
  "WP-2423 expected refusals: Dining's own table-moved refusal %s says the table moved, as information",
  async (error) => {
    const f = await setup();
    f.create.mockRejectedValue(error);
    const response = await f.send();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      error: { code: "payment_table_moved", messageKey: "customer.payment.table_moved" },
    });
    expect(customerRoundRefusal(error)).toBe("TABLE_MOVED");
  },
);
it("WP-2423 expected refusals: an order not ready for payment is an integrity failure, not a refusal", () => {
  for (const error of [
    new PaymentIntentCreationError("PAYMENT_INTENT_ORDER_NOT_READY"),
    new DiningCheckoutStoreError("DINING_CHECKOUT_STORE_UNAVAILABLE"),
    new DiningCheckoutServiceError("DINING_CHECKOUT_DEPENDENCY_UNAVAILABLE"),
  ])
    expect(customerRoundRefusal(error)).toBeNull();
});
