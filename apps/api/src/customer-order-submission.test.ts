import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { CartError, OrderCreationError, CheckoutValidationError } from "@rms/ordering";
import { createApp } from "./app.js";
import {
  CustomerOrderSubmissionHandler,
  type CustomerOrderSubmissionPort,
} from "./customer-order-submission.js";
import { orderSubmissionFixture } from "../test-support/dining-order-submission-fixture.js";
function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as Record<string, unknown>;
}
const fixture = orderSubmissionFixture();
const original = await fixture.orderService().create(fixture.orderInput);
const origin = "https://customer.example";
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
async function setup(quoteVersion: 1 | 2 = 1, enabled = true) {
  const create = vi.fn<CustomerOrderSubmissionPort["create"]>().mockResolvedValue(original);
  const server = createServer(
    createApp({
      ...(enabled
        ? {
            customerOrderSubmission: new CustomerOrderSubmissionHandler({
              port: { quoteVersion, create },
              allowedOrigin: origin,
            }),
          }
        : {}),
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api/v1/orders";
  const body = {
    cartReference: fixture.orderInput.cartReference,
    cartVersion: fixture.orderInput.expectedCartVersion,
    quoteReference: fixture.orderInput.quoteReference,
  };
  const headers: Record<string, string> = {
    origin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "idempotency-key": fixture.orderInput.submissionReference,
    "x-csrf-token": fixture.orderInput.csrfCredential,
    cookie: "__Host-bop-guest=" + fixture.orderInput.sessionCredential,
  };
  const send = async (payload: unknown = body, overrides: Record<string, string> = {}) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, ...overrides },
      body: JSON.stringify(payload),
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    return { status: response.status, body: await response.json() };
  };
  return { create, send, body };
}
it("returns only the original customer order summary and distinguishes replay", async () => {
  const f = await setup();
  const first = await f.send();
  expect(first.status).toBe(201);
  expect(Object.keys(readRecord(readRecord(first.body).order)).sort()).toEqual(
    [
      "orderReference",
      "orderNumber",
      "submissionReference",
      "cartReference",
      "cartVersion",
      "quoteReference",
      "quoteVersion",
      "orderType",
      "phase",
      "paymentStatus",
      "total",
    ].sort(),
  );
  expect(readRecord(readRecord(first.body).order).paymentStatus).toBe("NotReported");
  expect(readRecord(readRecord(first.body).order).phase).toBe("Submitted");
  expect(JSON.stringify(first.body)).not.toContain(original.record.guestSessionReference);
  expect(readRecord(readRecord(readRecord(first.body).order).total).amountMinor).toBe(
    original.record.items.reduce((n, item) => n + item.pricing.total.amountMinor, 0n).toString(),
  );
  f.create.mockResolvedValue({ status: "AlreadyCreated", record: original.record });
  const replay = await f.send();
  expect(replay.status).toBe(200);
  expect(replay.body).toEqual(first.body);
});
it.each(["extra", "origin", "csrf", "cookie", "key"] as const)(
  "rejects malformed %s before the owner call",
  async (kind) => {
    const f = await setup();
    const result = await f.send(
      kind === "extra" ? { ...f.body, total: "1" } : f.body,
      kind === "origin"
        ? { origin: "https://foreign.example" }
        : kind === "csrf"
          ? { "x-csrf-token": "" }
          : kind === "cookie"
            ? {
                cookie:
                  "__Host-bop-guest=" + "g".repeat(43) + "; __Host-bop-guest=" + "h".repeat(43),
              }
            : kind === "key"
              ? { "idempotency-key": "invalid" }
              : {},
    );
    expect(result.status).toBe(400);
    expect(f.create).not.toHaveBeenCalled();
  },
);
it("retains the same submission after an uncertain response", async () => {
  const f = await setup();
  f.create
    .mockRejectedValueOnce(new Error("synthetic lost commit acknowledgement"))
    .mockResolvedValueOnce({ status: "AlreadyCreated", record: original.record });
  expect((await f.send()).status).toBe(503);
  expect((await f.send()).status).toBe(200);
  expect(f.create.mock.calls[1]).toEqual(f.create.mock.calls[0]);
});
it.each([
  [new OrderCreationError("ORDER_CREATE_PERMISSION_DENIED"), 404],
  [new OrderCreationError("ORDER_CREATE_IDEMPOTENCY_CONFLICT"), 409],
  [new CheckoutValidationError("CHECKOUT_REQUOTE_REQUIRED"), 422],
  [new CheckoutValidationError("CHECKOUT_CART_VERSION_CONFLICT"), 409],
  [new CheckoutValidationError("CHECKOUT_QUOTE_EXPIRED"), 422],
  [new CheckoutValidationError("CHECKOUT_QUOTE_MISSING"), 422],
  [new CheckoutValidationError("CHECKOUT_SELECTION_INVALID"), 422],
  [new CheckoutValidationError("CHECKOUT_INPUT_INVALID"), 400],
  [new CheckoutValidationError("CHECKOUT_CART_UNAVAILABLE"), 404],
  [new CheckoutValidationError("CHECKOUT_CART_EMPTY"), 409],
  [new CheckoutValidationError("CHECKOUT_CART_NOT_ACTIVE"), 409],
  [new CartError("CART_INPUT_INVALID"), 400],
  [new CartError("CART_UNAVAILABLE"), 404],
  [new CartError("CART_QUOTE_EXPIRED"), 422],
  [new CartError("CART_QUOTE_INVALID"), 422],
  [new CartError("CART_SELECTION_INVALID"), 422],
  [new CartError("CART_EXPIRED"), 409],
  [new CartError("CART_ABANDONED"), 409],
  [new CheckoutValidationError("CHECKOUT_DEPENDENCY_UNAVAILABLE"), 503],
  [new CheckoutValidationError("CHECKOUT_CAPACITY_UNAVAILABLE"), 503],
] as const)("maps current owner refusal safely", async (error, status) => {
  const f = await setup();
  f.create.mockRejectedValue(error);
  const result = await f.send();
  expect(result.status).toBe(status);
  expect(Object.keys(readRecord(readRecord(result.body).error)).sort()).toEqual([
    "code",
    "messageKey",
  ]);
});
it("rejects a foreign submission result instead of publishing it", async () => {
  const f = await setup();
  expect(
    (await f.send(f.body, { "idempotency-key": "01909999-0000-7000-8000-000000000999" })).status,
  ).toBe(503);
});
it("does not silently treat a v1 record as configured", async () => {
  const f = await setup(2);
  expect((await f.send()).status).toBe(503);
});
it("keeps unconfigured runtime unavailable", async () => {
  const f = await setup(1, false);
  expect((await f.send()).status).toBe(503);
  expect(f.create).not.toHaveBeenCalled();
});
