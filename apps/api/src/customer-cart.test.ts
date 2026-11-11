import { CartError, CartReplacementPendingError } from "@rms/ordering";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import {
  CustomerCartHandler,
  type CustomerCartPort,
  type CustomerCartReplacementPort,
  type CustomerCartPortResult,
  type CustomerCartView,
} from "./customer-cart.js";
import type { CustomerCartRestorePort } from "./customer-pickup-cart-restore.js";

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
      placedOrder: null,
      ...overrides,
    },
  };
}

class FakePort implements CustomerCartPort {
  result: CustomerCartPortResult = { status: "Found", view: view() };
  calls: { name: string; input: unknown }[] = [];
  displayLocales: (string | null | undefined)[] = [];

  private called(name: string, input: unknown, displayLocale?: string | null) {
    this.calls.push({ name, input });
    this.displayLocales.push(displayLocale);
    return Promise.resolve(this.result);
  }

  createCart(input: Parameters<CustomerCartPort["createCart"]>[0], displayLocale?: string | null) {
    return this.called("create", input, displayLocale);
  }
  getCurrentCart(
    input: Parameters<CustomerCartPort["getCurrentCart"]>[0],
    displayLocale?: string | null,
  ) {
    return this.called("current", input, displayLocale);
  }
  getCart(input: Parameters<CustomerCartPort["getCart"]>[0], displayLocale?: string | null) {
    return this.called("read", input, displayLocale);
  }
  addItem(input: Parameters<CustomerCartPort["addItem"]>[0], displayLocale?: string | null) {
    return this.called("add", input, displayLocale);
  }
  updateItem(input: Parameters<CustomerCartPort["updateItem"]>[0], displayLocale?: string | null) {
    return this.called("update", input, displayLocale);
  }
  removeItem(input: Parameters<CustomerCartPort["removeItem"]>[0], displayLocale?: string | null) {
    return this.called("remove", input, displayLocale);
  }
}

let port: FakePort;
let replacement: CustomerCartReplacementPort | undefined;
let restore: CustomerCartRestorePort | undefined;

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
  const handler = new CustomerCartHandler({
    allowedOrigin: origin,
    now: () => at,
    port,
    ...(replacement === undefined ? {} : { replacement }),
    ...(restore === undefined ? {} : { restore }),
  });
  const server = createServer(createApp({ customerCart: handler }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing server address");
  return fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

beforeEach(() => {
  port = new FakePort();
  replacement = undefined;
  restore = undefined;
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

  it("Owner 2026-10-23: passes the guest's chosen language for item names on reads and edits", async () => {
    await request("/bff/customer/cart?locale=zh-Hans-CA", { headers: headers() });
    await request(`/api/v1/carts/${id(1)}?locale=zh-Hans-CA`, { headers: headers() });
    await request(`/api/v1/carts/${id(1)}/items/${id(2)}?locale=zh-Hans-CA`, {
      method: "DELETE",
      headers: headers({ "if-match": '"3"' }),
    });
    await request("/bff/customer/cart", { headers: headers() });
    expect(port.calls.map((call) => call.name)).toEqual(["current", "read", "remove", "current"]);
    expect(port.displayLocales).toEqual(["zh-Hans-CA", "zh-Hans-CA", "zh-Hans-CA", undefined]);
    port.calls = [];
    for (const path of [
      "/bff/customer/cart?locale=zh_CN",
      "/bff/customer/cart?locale=a&locale=b",
    ]) {
      const response = await request(path, { headers: headers() });
      expect(response.status, path).toBe(400);
    }
    expect(port.calls).toEqual([]);
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
    // Coordinator 2026-10-30: a phone that scanned a table but wasn't seated there yet.
    [{ status: "NotSeated" }, 409, "cart_dining_not_seated"],
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
    // WP-2423: briefly unavailable (table Cart expiry still being recorded) with a retry hint.
    [{ status: "RetryLater", retryAfterSeconds: 5 }, 503, "cart_service_unavailable"],
    [{ status: "OrderProcessing", retryAfterSeconds: 10 }, 409, "cart_order_processing"],
    [{ status: "OrderProcessing", retryAfterSeconds: null }, 409, "cart_order_processing"],
    // DEC-DINING-ANY-PARTICIPANT-SUBMIT: another guest is paying; wait until their hold ends.
    [
      { status: "CheckoutInProgress", heldUntil: "2026-08-02T20:04:30.000Z" },
      409,
      "cart_checkout_in_progress",
    ],
  ] as const)("maps safe application outcome %o", async (result, status, errorCode) => {
    port.result = result;
    const response = await request("/bff/customer/cart", { headers: headers() });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code: errorCode } });
    if (status === 429) expect(response.headers.get("retry-after")).toBe("7");
    if (status === 503) expect(response.headers.get("retry-after")).toBe("5");
    if (errorCode === "cart_checkout_in_progress")
      expect(response.headers.get("retry-after")).toBe("270");
    if (errorCode === "cart_order_processing")
      expect(response.headers.get("retry-after")).toBe(
        "retryAfterSeconds" in result && result.retryAfterSeconds !== null ? "10" : null,
      );
  });

  it("WP-2423: tells the guest how many of an item the stock can make (ITEM_SHORT)", async () => {
    port.result = { status: "SelectionInvalid", issueCodes: ["ITEM_SHORT"], available: 2 };
    const response = await request("/bff/customer/cart", { headers: headers() });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "cart_selection_invalid", issueCodes: ["ITEM_SHORT"], available: 2 },
    });
    port.result = { status: "SelectionInvalid", issueCodes: ["ITEM_SHORT"], available: -1 };
    expect((await request("/bff/customer/cart", { headers: headers() })).status).toBe(503);
  });

  it("WP-2423 same-table-ordering: a table Cart passes on its recent rounds; a pickup Cart can't", async () => {
    const recentRounds = [
      {
        roundNumber: 2,
        sentAt: "2026-08-02T20:00:00.000Z",
        sentByThisPhone: false,
        cartItemReferences: [id(2)],
        paymentState: "AwaitingPayment" as const,
      },
    ];
    port.result = {
      status: "Found",
      view: view({ orderType: "DineIn", serviceMode: "DineIn", placedOrder: null, recentRounds }),
    };
    const response = await request("/bff/customer/cart", { headers: headers() });
    expect(response.status).toBe(200);
    expect(((await response.json()) as CustomerCartView).cart.recentRounds).toEqual(recentRounds);
    // M38: who cancelled a round is passed on, so guests read "staff" only when staff did it.
    for (const paymentState of [
      "Cancelled",
      "StaffDeclined",
      "StaffCancelled",
      "PaidNotMade",
    ] as const) {
      const rounds = [{ ...recentRounds[0], paymentState }];
      port.result = {
        status: "Found",
        view: view({
          orderType: "DineIn",
          serviceMode: "DineIn",
          placedOrder: null,
          recentRounds: rounds as never,
        }),
      };
      const passed = await request("/bff/customer/cart", { headers: headers() });
      expect(passed.status).toBe(200);
      expect(((await passed.json()) as CustomerCartView).cart.recentRounds).toEqual(rounds);
    }
    for (const overrides of [
      { recentRounds },
      {
        orderType: "DineIn" as const,
        recentRounds: [{ ...recentRounds[0], cartItemReferences: ["not-a-reference"] }],
      },
      // M38: a round with no known payment state is never passed on (as if paid).
      {
        orderType: "DineIn" as const,
        recentRounds: [{ ...recentRounds[0], paymentState: "Settled" }],
      },
    ]) {
      port.result = { status: "Found", view: view(overrides as never) };
      expect((await request("/bff/customer/cart", { headers: headers() })).status).toBe(503);
    }
    port.result = { status: "Found", view: view() };
    const plain = await request("/bff/customer/cart", { headers: headers() });
    expect((await plain.json()) as CustomerCartView).not.toHaveProperty("cart.recentRounds");
    // v15 batch-5: a staff round, and whether this phone's dishes are in it, are passed on; a
    // half-said one is not.
    const staff = [{ ...recentRounds[0], enteredByStaff: true, withThisPhoneDishes: false }];
    port.result = {
      status: "Found",
      view: view({
        orderType: "DineIn",
        serviceMode: "DineIn",
        placedOrder: null,
        recentRounds: staff,
      }),
    };
    const described = await request("/bff/customer/cart", { headers: headers() });
    expect(((await described.json()) as CustomerCartView).cart.recentRounds).toEqual(staff);
    port.result = {
      status: "Found",
      view: view({
        orderType: "DineIn",
        serviceMode: "DineIn",
        placedOrder: null,
        recentRounds: [{ ...recentRounds[0], enteredByStaff: true }] as never,
      }),
    };
    expect((await request("/bff/customer/cart", { headers: headers() })).status).toBe(503);
  });

  it("WP-2423 shared-table-checkout (c): a table Cart passes on the dishes staff removed; a pickup Cart can't", async () => {
    const staffRemoved = [
      {
        removedAt: "2026-08-02T20:00:00.000Z",
        quantity: 1,
        names: { "en-CA": "Mapo tofu", "zh-Hans-CA": "麻婆豆腐" },
      },
    ];
    port.result = {
      status: "Found",
      view: view({ orderType: "DineIn", serviceMode: "DineIn", placedOrder: null, staffRemoved }),
    };
    const response = await request("/bff/customer/cart", { headers: headers() });
    expect(response.status).toBe(200);
    expect(((await response.json()) as CustomerCartView).cart.staffRemoved).toEqual(staffRemoved);
    for (const overrides of [
      { staffRemoved },
      { orderType: "DineIn" as const, staffRemoved: [{ ...staffRemoved[0], quantity: 0 }] },
      {
        orderType: "DineIn" as const,
        staffRemoved: [{ ...staffRemoved[0], names: { "<b>": "x" } }],
      },
    ]) {
      port.result = { status: "Found", view: view(overrides as never) };
      expect((await request("/bff/customer/cart", { headers: headers() })).status).toBe(503);
    }
  });

  it("WP-2423 shared-table-checkout (a): a table Cart passes on who is paying for chosen dishes and what waits; a pickup Cart can't", async () => {
    const tablePay = {
      defaultChoice: "OwnDishes" as const,
      payer: {
        thisPhone: false,
        choice: "Mine" as const,
        expiresAt: "2026-08-02T20:05:00.000Z",
        reserved: true,
      },
      waiting: [
        {
          waitingLineReference: id(31),
          quantity: 2,
          names: { "en-CA": "Mapo tofu", "zh-Hans-CA": "麻婆豆腐" },
          withOptions: true,
          mine: true,
        },
      ],
      returnable: false,
    };
    port.result = {
      status: "Found",
      view: view({ orderType: "DineIn", serviceMode: "DineIn", placedOrder: null, tablePay }),
    };
    const response = await request("/bff/customer/cart", { headers: headers() });
    expect(response.status).toBe(200);
    expect(((await response.json()) as CustomerCartView).cart.tablePay).toEqual(tablePay);
    for (const overrides of [
      { tablePay },
      { orderType: "DineIn" as const, tablePay: { ...tablePay, defaultChoice: "Everyone" } },
      {
        orderType: "DineIn" as const,
        tablePay: { ...tablePay, payer: { ...tablePay.payer, participant: id(7) } },
      },
      {
        orderType: "DineIn" as const,
        tablePay: { ...tablePay, waiting: [{ ...tablePay.waiting[0], quantity: 0 }] },
      },
    ]) {
      port.result = { status: "Found", view: view(overrides as never) };
      expect((await request("/bff/customer/cart", { headers: headers() })).status).toBe(503);
    }
  });

  it("WP-2423 M03: an emptied pickup Cart names the guest's Order its dishes went to", async () => {
    const placedOrder = { orderReference: id(9), orderNumber: "13", notMade: false };
    port.result = {
      status: "Found",
      view: view({ version: 4, items: [], quote: null, placedOrder }),
    };
    const response = await request("/bff/customer/cart", { headers: headers() });
    expect(response.status).toBe(200);
    expect(((await response.json()) as CustomerCartView).cart.placedOrder).toEqual(placedOrder);
    // Review: an Order that closed unpaid, and a Cart still holding dishes already in an Order
    // (filled before pickup Carts were emptied on ordering), are named too.
    for (const overrides of [
      { items: [], quote: null, placedOrder: { ...placedOrder, notMade: true } },
      { placedOrder },
    ]) {
      port.result = { status: "Found", view: view(overrides) };
      const named = await request("/bff/customer/cart", { headers: headers() });
      expect(named.status).toBe(200);
      expect(((await named.json()) as CustomerCartView).cart.placedOrder).toEqual(
        overrides.placedOrder,
      );
    }
    // A table's Cart never claims an Order; a malformed one is refused.
    for (const overrides of [
      { orderType: "DineIn" as const, items: [], quote: null, placedOrder },
      { items: [], quote: null, placedOrder: { ...placedOrder, orderNumber: "13A" } },
      { items: [], quote: null, placedOrder: { orderReference: id(9), orderNumber: "13" } },
    ]) {
      port.result = { status: "Found", view: view(overrides as never) };
      expect((await request("/bff/customer/cart", { headers: headers() })).status).toBe(503);
    }
    port.result = { status: "Found", view: view() };
    const plain = await request("/bff/customer/cart", { headers: headers() });
    expect(((await plain.json()) as CustomerCartView).cart.placedOrder).toBeNull();
  });

  it("WP-2423 M03: puts an unmade Order's dishes back and says how many could not go back", async () => {
    const calls: unknown[] = [];
    let answer: Awaited<ReturnType<CustomerCartRestorePort["restore"]>> = {
      status: "Restored",
      view: view({ version: 5 }),
      added: 1,
      alreadyPutBack: 0,
      unavailable: 1,
    };
    restore = {
      restore: async (input, ...locale) => {
        calls.push([input, ...locale]);
        return answer;
      },
    };
    const send = (init: RequestInit = {}) =>
      request("/bff/customer/cart/restore-order?locale=zh-Hans-CA", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ orderReference: id(7) }),
        ...init,
      });
    const response = await send();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { restored: unknown; cart: { version: number } };
    expect(body.restored).toEqual({ added: 1, alreadyPutBack: 0, unavailable: 1 });
    expect(body.cart.version).toBe(5);
    expect(calls).toEqual([
      [
        {
          guestCredential: guest,
          csrfCredential: csrf,
          operationReference: id(20),
          requestedAt: at,
          orderReference: id(7),
        },
        "zh-Hans-CA",
      ],
    ]);
    answer = { status: "NotRestorable" };
    const refused = await send();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "cart_restore_not_available" } });
    // No CSRF, another site, or extra fields: refused before the port.
    calls.length = 0;
    for (const init of [
      { headers: headers({ "x-csrf-token": "" }) },
      { headers: headers({ origin: "https://other.example.test" }) },
      { body: JSON.stringify({ orderReference: id(7), cartReference: id(1) }) },
    ])
      expect((await send(init)).status).toBeGreaterThanOrEqual(400);
    expect(calls).toEqual([]);
  });

  it("WP-2423: answers a guest without an active Cart with an explicit empty Cart", async () => {
    port.result = { status: "NotFound" };
    const response = await request("/bff/customer/cart", { headers: headers() });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ schemaVersion: 1, cart: null });
    // A named Cart that doesn't exist is still not found.
    const named = await request(`/api/v1/carts/${id(1)}`, { headers: headers() });
    expect(named.status).toBe(404);
    expect(await named.json()).toMatchObject({ error: { code: "cart_not_found" } });
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

describe("WP-2402 explicit Dining Cart replacement transport", () => {
  const path = `/api/v1/carts/${id(1)}/replacement`;
  const receipt = {
    operationReference: id(20),
    previousCartReference: id(1),
    cartReference: id(30),
    occurredAt: at,
    expiresAt: "2026-08-03T20:00:00.000Z",
  };
  const mutation = (extra: Record<string, string> = {}, body = "{}") => ({
    method: "POST",
    headers: headers({ "if-match": '"3"', ...extra }),
    body,
  });
  it("projects a stable historical receipt and preserves retry identity", async () => {
    const calls: unknown[] = [];
    replacement = {
      replace: async (input) => {
        calls.push(input);
        return receipt;
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(path, mutation());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ schemaVersion: 1, ...receipt });
      expect(response.headers.get("location")).toBe(`/api/v1/carts/${id(30)}`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("etag")).toBeNull();
    }
    expect(calls).toEqual(
      Array.from({ length: 2 }, () => ({
        sessionCredential: guest,
        csrfCredential: csrf,
        operationReference: id(20),
        previousCartReference: id(1),
        expectedCartVersion: 3,
      })),
    );
    expect(port.calls).toEqual([]);
  });
  it.each([
    [{ origin: "https://foreign.example.test" }, "{}", 400],
    [{ "x-csrf-token": "bad" }, "{}", 400],
    [{ cookie: "" }, "{}", 401],
    [{ "if-match": 'W/"3"' }, "{}", 400],
    [{ "idempotency-key": "bad" }, "{}", 400],
    [{}, '{"participantReference":"injected"}', 400],
  ] as const)(
    "rejects invalid admission before invoking replacement %j",
    async (extra, body, status) => {
      let called = false;
      replacement = {
        replace: async () => {
          called = true;
          return receipt;
        },
      };
      const response = await request(path, mutation(extra, body));
      expect(response.status).toBe(status);
      expect(called).toBe(false);
    },
  );
  it("keeps unconfigured replacement unavailable", async () => {
    expect((await request(path, mutation())).status).toBe(503);
  });
  it.each([
    ["CART_REPLACEMENT_FORBIDDEN", 403],
    ["CART_PERMISSION_DENIED", 401],
    ["CART_VERSION_CONFLICT", 409],
    ["CART_IDEMPOTENCY_CONFLICT", 409],
    ["CART_LIFECYCLE_UNAVAILABLE", 409],
    ["CART_DEPENDENCY_UNAVAILABLE", 503],
  ] as const)("bounds owner error %s", async (code, status) => {
    replacement = {
      replace: async () => {
        throw new CartError(code);
      },
    };
    const response = await request(path, mutation());
    expect(response.status).toBe(status);
    expect(JSON.stringify(await response.json())).not.toContain(guest);
  });
  it("WP-2423: a replacement held back by the table's last checkout asks to retry shortly", async () => {
    replacement = {
      replace: async () => {
        throw new CartReplacementPendingError(new Date(Date.parse(at) + 90_500).toISOString());
      },
    };
    const response = await request(path, mutation());
    expect(response.status).toBe(409);
    // The actual remaining time of the bounded wait, rounded up.
    expect(response.headers.get("retry-after")).toBe("91");
    expect(await response.json()).toMatchObject({ error: { code: "cart_order_processing" } });
    // A wait with no known end promises no time.
    replacement = {
      replace: async () => {
        throw new CartReplacementPendingError(null);
      },
    };
    const unbounded = await request(path, mutation());
    expect(unbounded.status).toBe(409);
    expect(unbounded.headers.get("retry-after")).toBeNull();
    await unbounded.text();
  });
  it.each([
    { ...receipt, guestSessionReference: id(40) },
    { ...receipt, operationReference: id(99) },
    { ...receipt, previousCartReference: id(99) },
    { ...receipt, cartReference: id(1) },
    { ...receipt, expiresAt: at },
  ])("rejects malformed receipt without leaking it", async (result) => {
    replacement = { replace: async () => result };
    const response = await request(path, mutation());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain(id(40));
  });
});
