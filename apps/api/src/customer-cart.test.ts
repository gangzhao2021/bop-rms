import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import {
  CustomerCartHandler,
  type CustomerCartPort,
  type CustomerCartPortResult,
  type CustomerCartView,
} from "./customer-cart.js";

const id = (n: number) => `018f5300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const guest = "g".repeat(43);
const csrf = "c".repeat(43);
const origin = "https://customer.example.test";
const at = "2026-08-02T20:00:00.000Z";
const servers: Server[] = [];

function view(overrides: Partial<CustomerCartView["cart"]> = {}): CustomerCartView {
  return {
    schemaVersion: 1,
    cart: {
      cartReference: id(1),
      version: 3,
      orderType: "Pickup",
      serviceMode: "Pickup",
      context: { brandName: "Synthetic Brand", storeName: "Synthetic Store" },
      lifecycle: {
        status: "Active",
        idleExpiresAt: "2026-08-02T21:00:00.000Z",
        absoluteExpiresAt: "2026-08-03T20:00:00.000Z",
      },
      items: [
        {
          cartItemReference: id(2),
          sellableReference: id(3),
          displayName: "Synthetic tea",
          quantity: 2,
          configuration: [{ optionReference: id(4), displayName: "Synthetic size", quantity: 1 }],
          customerNote: null,
          lineEstimate: {
            status: "Available",
            total: { amountMinor: "1000", currency: "CAD" },
          },
          warnings: [],
        },
      ],
      quote: {
        quoteReference: id(5),
        quoteVersion: 1,
        cartVersion: 3,
        subtotal: { amountMinor: "1000", currency: "CAD" },
        discount: { amountMinor: "0", currency: "CAD" },
        tax: { amountMinor: "130", currency: "CAD" },
        fee: { amountMinor: "0", currency: "CAD" },
        total: { amountMinor: "1130", currency: "CAD" },
        expiresAt: "2026-08-02T20:05:00.000Z",
        warnings: [],
        blockingReasons: [],
      },
      warnings: [],
      ...overrides,
    },
  };
}

class FakePort implements CustomerCartPort {
  result: CustomerCartPortResult = { status: "Found", view: view() };
  calls: { name: string; input: unknown }[] = [];

  private called(name: string, input: unknown) {
    this.calls.push({ name, input });
    return Promise.resolve(this.result);
  }

  createCart(input: Parameters<CustomerCartPort["createCart"]>[0]) {
    return this.called("create", input);
  }
  getCurrentCart(input: Parameters<CustomerCartPort["getCurrentCart"]>[0]) {
    return this.called("current", input);
  }
  getCart(input: Parameters<CustomerCartPort["getCart"]>[0]) {
    return this.called("read", input);
  }
  addItem(input: Parameters<CustomerCartPort["addItem"]>[0]) {
    return this.called("add", input);
  }
  updateItem(input: Parameters<CustomerCartPort["updateItem"]>[0]) {
    return this.called("update", input);
  }
  removeItem(input: Parameters<CustomerCartPort["removeItem"]>[0]) {
    return this.called("remove", input);
  }
}

let port: FakePort;

function headers(extra: Record<string, string> = {}) {
  return {
    cookie: `other=value; __Host-bop-guest=${guest}`,
    origin,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "content-type": "application/json",
    "x-csrf-token": csrf,
    "idempotency-key": id(20),
    ...extra,
  };
}

async function request(path: string, init?: RequestInit) {
  const handler = new CustomerCartHandler({ allowedOrigin: origin, now: () => at, port });
  const server = createServer(createApp({ customerCart: handler }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing server address");
  return fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

beforeEach(() => {
  port = new FakePort();
});

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
  );
});

describe("WP-1205 Customer Cart HTTP contract", () => {
  it("reads the session-bound current Cart without exposing credential material", async () => {
    const response = await request("/bff/customer/cart", { headers: headers() });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBe('"3"');
    expect(response.headers.get("location")).toBe(`/api/v1/carts/${id(1)}`);
    const payload = JSON.stringify(await response.json());
    expect(payload).toContain("Synthetic tea");
    expect(payload).not.toContain(guest);
    expect(payload).not.toContain(csrf);
    expect(port.calls[0]).toEqual({
      name: "current",
      input: { guestCredential: guest, requestedAt: at },
    });
  });

  it("creates or resumes one Cart from Cookie, CSRF and Idempotency context only", async () => {
    port.result = { status: "Applied", view: view({ version: 1, items: [], quote: null }) };
    const response = await request("/api/v1/carts", {
      method: "POST",
      headers: headers(),
      body: "{}",
    });
    expect(response.status).toBe(201);
    expect(port.calls[0]).toEqual({
      name: "create",
      input: {
        guestCredential: guest,
        csrfCredential: csrf,
        operationReference: id(20),
        requestedAt: at,
      },
    });
  });

  it("maps strict add, update and remove requests without accepting money or scope", async () => {
    const add = await request(`/api/v1/carts/${id(1)}/items`, {
      method: "POST",
      headers: headers({ "if-match": '"3"' }),
      body: JSON.stringify({
        sellableReference: id(3),
        quantity: 2,
        optionSelections: [{ optionReference: id(4), quantity: 1 }],
        customerNote: "  No cutlery  ",
      }),
    });
    expect(add.status).toBe(200);
    expect(port.calls[0]).toMatchObject({
      name: "add",
      input: {
        cartReference: id(1),
        expectedCartVersion: 3,
        sellableReference: id(3),
        customerNote: "No cutlery",
      },
    });

    const update = await request(`/api/v1/carts/${id(1)}/items/${id(2)}`, {
      method: "PATCH",
      headers: headers({ "if-match": '"3"', "idempotency-key": id(21) }),
      body: JSON.stringify({ quantity: 1, optionSelections: [], customerNote: null }),
    });
    expect(update.status).toBe(200);
    expect(port.calls[1]).toMatchObject({
      name: "update",
      input: { cartItemReference: id(2), operationReference: id(21), quantity: 1 },
    });

    const remove = await request(`/api/v1/carts/${id(1)}/items/${id(2)}`, {
      method: "DELETE",
      headers: headers({ "if-match": '"3"', "idempotency-key": id(22) }),
    });
    expect(remove.status).toBe(200);
    expect(port.calls[2]).toMatchObject({
      name: "remove",
      input: { cartItemReference: id(2), operationReference: id(22) },
    });

    const injectedMoney = await request(`/api/v1/carts/${id(1)}/items`, {
      method: "POST",
      headers: headers({ "if-match": '"3"' }),
      body: JSON.stringify({
        sellableReference: id(3),
        quantity: 1,
        optionSelections: [],
        customerNote: null,
        amountMinor: "1",
      }),
    });
    expect(injectedMoney.status).toBe(400);
    expect(port.calls).toHaveLength(3);
  });

  it("fails before the port for cross-origin, missing CSRF, duplicate Cookie and weak concurrency", async () => {
    for (const [badHeaders, expectedStatus] of [
      [headers({ origin: "https://evil.example.test", "if-match": '"3"' }), 400],
      [headers({ "x-csrf-token": "short", "if-match": '"3"' }), 400],
      [
        headers({
          cookie: `__Host-bop-guest=${guest}; __Host-bop-guest=${guest}`,
          "if-match": '"3"',
        }),
        401,
      ],
      [headers({ "if-match": "3" }), 400],
    ] as const) {
      const response = await request(`/api/v1/carts/${id(1)}/items`, {
        method: "POST",
        headers: badHeaders,
        body: JSON.stringify({
          sellableReference: id(3),
          quantity: 1,
          optionSelections: [],
          customerNote: null,
        }),
      });
      expect(response.status).toBe(expectedStatus);
    }
    expect(port.calls).toHaveLength(0);
  });

  it("maps a missing or malformed Guest Cookie to the uniform session-expired contract", async () => {
    for (const cookie of [undefined, "__Host-bop-guest=short"]) {
      const requestHeaders = headers();
      if (cookie === undefined) delete (requestHeaders as { cookie?: string }).cookie;
      else (requestHeaders as { cookie?: string }).cookie = cookie;
      const response = await request("/bff/customer/cart", { headers: requestHeaders });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "cart_session_expired" } });
    }
    expect(port.calls).toHaveLength(0);
  });

  it.each([
    [{ status: "SessionExpired" }, 401, "cart_session_expired"],
    [{ status: "NotFound" }, 404, "cart_not_found"],
    [{ status: "IdempotencyConflict" }, 409, "cart_idempotency_conflict"],
    [{ status: "LifecycleExpired" }, 409, "cart_expired"],
    [{ status: "LifecycleAbandoned" }, 409, "cart_abandoned"],
    [{ status: "VersionConflict", currentVersion: 4 }, 409, "cart_version_conflict"],
    [
      { status: "SelectionInvalid", issueCodes: ["OPTION_REQUIRED"] },
      422,
      "cart_selection_invalid",
    ],
    [{ status: "RateLimited", retryAfterSeconds: 7 }, 429, "cart_rate_limited"],
  ] as const)("maps safe application outcome %o", async (result, status, errorCode) => {
    port.result = result;
    const response = await request("/bff/customer/cart", { headers: headers() });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code: errorCode } });
    if (status === 429) expect(response.headers.get("retry-after")).toBe("7");
  });

  it("maps a thrown or malformed dependency result to safe unavailable", async () => {
    port.result = { status: "Found", view: { schemaVersion: 1, cart: {} } as CustomerCartView };
    const malformed = await request("/bff/customer/cart", { headers: headers() });
    expect(malformed.status).toBe(503);
    expect(JSON.stringify(await malformed.json())).not.toContain("stack");

    port.getCurrentCart = async () => {
      throw new Error("private dependency detail");
    };
    const thrown = await request("/bff/customer/cart", { headers: headers() });
    expect(thrown.status).toBe(503);
    expect(JSON.stringify(await thrown.json())).not.toContain("private dependency detail");
  });
});
