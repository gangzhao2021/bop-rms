import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuestSession, type GuestSessionService } from "@bop/identity";
import { CartError, parseOrderingReference, type CustomerCartDisplayView } from "@rms/ordering";
import { createApp } from "./app.js";
import { CustomerCartHandler, type CustomerCartPort } from "./customer-cart.js";
import {
  createCustomerCartChannelPort,
  createCustomerDiningCartComposition,
  createCustomerDiningCartPort,
} from "./customer-dining-cart-composition.js";
const id = (n: number) => `018f2319-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (seconds = 0) =>
  new Date(Date.parse("2026-09-09T12:00:00.000Z") + seconds * 1000).toISOString();
const credential = "a".repeat(43),
  csrf = "b".repeat(43);
const context = () => ({ guestCredential: credential, requestedAt: at() });
const input = () => ({ ...context(), csrfCredential: csrf, operationReference: id(10) });
function guest(pickup = false) {
  return createGuestSession({
    sessionReference: id(4),
    status: "Active",
    version: 1,
    brandReference: id(2),
    storeReference: id(3),
    publicStoreReference: id(7),
    publicTableReference: pickup ? null : id(8),
    channel: pickup ? "Pickup" : "DineIn",
    locale: "en-CA",
    qrReference: id(9),
    qrRevocationVersion: 1,
    diningState: pickup ? "ContextOnly" : "DiningBound",
    diningSessionReference: pickup ? null : id(6),
    diningParticipantReference: pickup ? null : id(5),
    createdAt: at(-120),
    lastSeenAt: at(-60),
    idleExpiresAt: at(14340),
    absoluteExpiresAt: at(86280),
    orderClosedAt: null,
    closureExpiresAt: null,
    rotatedFromGuestSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  });
}
function receipt() {
  return {
    operationReference: id(10),
    brandReference: id(2),
    storeReference: id(3),
    diningSessionReference: id(6),
    guestSessionReference: id(4),
    participantReference: id(5),
    action: "Create",
    cartReference: id(11),
    cartVersion: 1,
    occurredAt: at(),
    expiresAt: at(86400),
  };
}
function view(): CustomerCartDisplayView {
  return {
    schemaVersion: 1,
    cart: {
      cartReference: id(11),
      version: 1,
      orderType: "DineIn",
      serviceMode: "DineIn",
      context: { brandName: "Synthetic Brand", storeName: "Synthetic Store" },
      lifecycle: { status: "Active", idleExpiresAt: at(3600), absoluteExpiresAt: at(7200) },
      items: [],
      quote: null,
      warnings: [],
    },
  };
}
function fixture() {
  const select = vi.fn(async (): Promise<unknown> => receipt());
  const read = vi.fn(async (): Promise<CustomerCartDisplayView | null> => view());
  return {
    select,
    read,
    port: createCustomerDiningCartPort({ selection: { select }, query: { read } }),
  };
}
describe("Dining Cart API bridge", () => {
  it.each([
    ["Create", "Applied"],
    ["Select", "Current"],
  ])("maps %s after a current safe read", async (action, status) => {
    const f = fixture();
    f.select.mockResolvedValue({ ...receipt(), action });
    expect(await f.port.createCart(input())).toEqual({ status, view: view() });
    expect(f.select).toHaveBeenCalledWith({
      sessionCredential: credential,
      csrfCredential: csrf,
      operationReference: id(10),
    });
    expect(f.read).toHaveBeenCalledWith({ sessionCredential: credential, cartReference: id(11) });
    expect(f.select.mock.invocationCallOrder[0]).toBeLessThan(
      f.read.mock.invocationCallOrder[0] ?? 0,
    );
  });
  it("recovers the original intent after post-effect read failure", async () => {
    const f = fixture();
    f.read.mockRejectedValueOnce(new Error("synthetic unknown"));
    expect(await f.port.createCart(input())).toEqual({ status: "Unavailable" });
    expect((await f.port.createCart(input())).status).toBe("Applied");
    expect(f.select.mock.calls[0]).toEqual(f.select.mock.calls[1]);
  });
  it.each([
    null,
    { ...view(), cart: { ...view().cart, cartReference: id(99) } },
    { ...view(), cart: { ...view().cart, version: 0 } },
    { ...view(), cart: { ...view().cart, orderType: "Pickup" as const } },
  ])("denies an incompatible current view", async (value) => {
    const f = fixture();
    f.read.mockResolvedValue(value);
    expect(await f.port.createCart(input())).toEqual({ status: "Unavailable" });
  });
  it("allows a newer current Cart without rewriting the historical receipt", async () => {
    const f = fixture();
    f.read.mockResolvedValue({ ...view(), cart: { ...view().cart, version: 2 } });
    expect((await f.port.createCart(input())).status).toBe("Applied");
  });
  it.each([
    {},
    { ...input(), extra: "rejected" },
    { ...input(), csrfCredential: "bad" },
    { ...input(), requestedAt: "bad" },
  ])("rejects malformed input before the owner", async (value) => {
    const f = fixture();
    expect(await f.port.createCart(value as never)).toEqual({ status: "Unavailable" });
    expect(f.select).not.toHaveBeenCalled();
  });
  it("captures input before an awaited owner callback", async () => {
    const f = fixture();
    const value = input();
    f.select.mockImplementation(async () => {
      value.guestCredential = "c".repeat(43);
      value.operationReference = id(99);
      return receipt();
    });
    expect((await f.port.createCart(value)).status).toBe("Applied");
    expect(f.read).toHaveBeenCalledWith({ sessionCredential: credential, cartReference: id(11) });
  });
  it.each(["operationReference", "cartReference", "occurredAt"])(
    "rejects malformed receipt %s",
    async (key) => {
      const f = fixture();
      f.select.mockResolvedValue({
        ...receipt(),
        [key]: key === "operationReference" ? id(99) : "bad",
      });
      expect(await f.port.createCart(input())).toEqual({ status: "Unavailable" });
      expect(f.read).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["CART_PERMISSION_DENIED", "SessionExpired"],
    ["CART_EXPIRED", "LifecycleExpired"],
    ["CART_ABANDONED", "LifecycleAbandoned"],
    ["CART_IDEMPOTENCY_CONFLICT", "IdempotencyConflict"],
    ["CART_DEPENDENCY_UNAVAILABLE", "Unavailable"],
  ] as const)("bounds %s", async (code, status) => {
    const f = fixture();
    f.select.mockRejectedValue(new CartError(code));
    expect(await f.port.createCart(input())).toEqual({ status });
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["addItem", "updateItem", "removeItem"] as const)(
    "keeps %s unavailable",
    async (method) => {
      const f = fixture();
      expect(await f.port[method]({} as never)).toEqual({ status: "Unavailable" });
      expect(f.select).not.toHaveBeenCalled();
      expect(f.read).not.toHaveBeenCalled();
    },
  );
});
function routing(pickupMode = false) {
  const pickup = fixture(),
    dining = fixture();
  const resolve = vi.fn<GuestSessionService["resolve"]>(async () => guest(pickupMode));
  const now = vi.fn(() => at());
  const fixedScope = { brandReference: id(2), storeReference: id(3) };
  const port = createCustomerCartChannelPort({
    scope: fixedScope,
    sessions: { resolve },
    now,
    pickup: pickup.port,
    dining: dining.port,
  });
  return { pickup, dining, resolve, now, fixedScope, port };
}
describe("current Cart channel routing", () => {
  it.each([false, true])(
    "routes only the current Identity channel: Pickup=%s",
    async (pickupMode) => {
      const f = routing(pickupMode);
      await f.port.getCurrentCart(context());
      expect((pickupMode ? f.pickup : f.dining).read).toHaveBeenCalledOnce();
      expect((pickupMode ? f.dining : f.pickup).read).not.toHaveBeenCalled();
      expect(f.resolve).toHaveBeenCalledWith({
        sessionCredential: credential,
        activity: "Background",
        observedAt: at(),
      });
    },
  );
  it("does not fall back when the selected channel denies", async () => {
    const f = routing();
    f.dining.read.mockRejectedValue(new CartError("CART_PERMISSION_DENIED"));
    expect(await f.port.getCurrentCart(context())).toEqual({ status: "SessionExpired" });
    expect(f.pickup.read).not.toHaveBeenCalled();
  });
  it("denies wrong current scope before dispatch", async () => {
    const f = routing();
    f.resolve.mockResolvedValue(createGuestSession({ ...guest(), storeReference: id(99) }));
    expect(await f.port.getCurrentCart(context())).toEqual({ status: "SessionExpired" });
    expect(f.dining.read).not.toHaveBeenCalled();
  });
  it("captures configured scope and input before Identity resolves", async () => {
    const f = routing();
    f.fixedScope.storeReference = id(99);
    const value = context();
    f.resolve.mockImplementation(async () => {
      value.guestCredential = "z".repeat(43);
      return guest();
    });
    expect((await f.port.getCurrentCart(value)).status).toBe("Found");
    expect(f.dining.read).toHaveBeenCalledWith({ sessionCredential: credential });
  });
  it("denies backward clock before dispatch", async () => {
    const f = routing();
    f.now.mockReturnValueOnce(at()).mockReturnValue(at(-1));
    expect(await f.port.getCurrentCart(context())).toEqual({ status: "Unavailable" });
    expect(f.dining.read).not.toHaveBeenCalled();
  });
  it("denies a session that expires while Identity resolves", async () => {
    const f = routing();
    f.now.mockReturnValueOnce(at()).mockReturnValue(at(14340));
    expect(await f.port.getCurrentCart(context())).toEqual({ status: "SessionExpired" });
    expect(f.dining.read).not.toHaveBeenCalled();
  });
});
describe("routed Cart input capture", () => {
  it("routes creation with the original CSRF and operation", async () => {
    const f = routing();
    expect((await f.port.createCart(input())).status).toBe("Applied");
    expect(f.dining.select).toHaveBeenCalledWith({
      sessionCredential: credential,
      csrfCredential: csrf,
      operationReference: id(10),
    });
    expect(f.pickup.select).not.toHaveBeenCalled();
  });
  it("preserves named read intent", async () => {
    const f = routing();
    await f.port.getCart({ ...context(), cartReference: id(11) });
    expect(f.dining.read).toHaveBeenCalledWith({
      sessionCredential: credential,
      cartReference: id(11),
    });
  });
  it("captures nested option intent before asynchronous channel lookup", async () => {
    const value = {
      ...input(),
      cartReference: id(11),
      expectedCartVersion: 1,
      sellableReference: id(30),
      quantity: 1,
      optionSelections: [{ optionReference: id(31), quantity: 1 }],
      customerNote: null,
    };
    const addItem = vi.fn(async () => ({ status: "Unavailable" as const }));
    const pickup = { ...fixture().port, addItem };
    const port = createCustomerCartChannelPort({
      scope: { brandReference: id(2), storeReference: id(3) },
      now: () => at(),
      pickup,
      dining: fixture().port,
      sessions: {
        resolve: async () => {
          value.optionSelections[0] = { optionReference: id(99), quantity: 9 };
          return guest(true);
        },
      },
    });
    await port.addItem(value);
    expect(addItem).toHaveBeenCalledWith({
      ...value,
      optionSelections: [{ optionReference: id(31), quantity: 1 }],
    });
  });
  it("bounds a throwing downstream port without misreporting session loss", async () => {
    const port = createCustomerCartChannelPort({
      scope: { brandReference: id(2), storeReference: id(3) },
      now: () => at(),
      sessions: { resolve: async () => guest() },
      pickup: fixture().port,
      dining: {
        ...fixture().port,
        getCurrentCart: async () => {
          throw new Error("synthetic downstream failure");
        },
      },
    });
    expect(await port.getCurrentCart(context())).toEqual({ status: "Unavailable" });
  });
});
describe("request-local CSRF composition", () => {
  it("denies invalid CSRF before either Ordering transaction runner", async () => {
    const run = vi.fn(async (): Promise<never> => {
      throw new Error("owner must not run");
    });
    const authorize = vi.fn<GuestSessionService["authorize"]>(async () => {
      throw new Error("synthetic invalid CSRF");
    });
    const port = createCustomerDiningCartComposition({
      scope: { brandReference: id(2), storeReference: id(3) },
      sessions: { resolve: async () => guest(), authorize },
      participation: { resolve: async () => null },
      cartTransactions: { run },
      selectionTransactions: { run },
      now: () => at(),
      selection: {
        sourceChannel: "Qr",
        policy: {
          policyVersionReference: id(20),
          policyDigest: `sha256:${"a".repeat(64)}`,
          idleTimeoutSeconds: 3600,
          absoluteTimeoutSeconds: 7200,
          validFrom: at(-60),
          validUntil: at(86400),
        },
        generateReference: () => id(21),
        audit: () => {
          throw new Error("no audit");
        },
      },
      catalog: { describeMany: async () => [] },
      stores: {
        getPublicStore: async () => {
          throw new Error("no profile");
        },
      },
    });
    expect(await port.createCart(input())).toEqual({ status: "SessionExpired" });
    expect(authorize).toHaveBeenCalledWith({
      sessionCredential: credential,
      csrfCredential: csrf,
      observedAt: at(),
    });
    expect(run).not.toHaveBeenCalled();
  });
});
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});
async function http(port: CustomerCartPort, init: RequestInit) {
  const server = createServer(
    createApp({
      customerCart: new CustomerCartHandler({
        allowedOrigin: "https://customer.example.test",
        now: () => at(),
        port,
      }),
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no local server");
  return fetch(`http://127.0.0.1:${address.port}/api/v1/carts`, init);
}
const headers = () => ({
  cookie: `__Host-bop-guest=${credential}`,
  origin: "https://customer.example.test",
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "content-type": "application/json",
  "x-csrf-token": csrf,
  "idempotency-key": id(10),
});
describe("Dining Cart HTTP contract", () => {
  it.each([
    ["Create", 201],
    ["Select", 200],
  ] as const)("returns %s as %s with safe headers", async (action, status) => {
    const f = fixture();
    f.select.mockResolvedValue({ ...receipt(), action });
    const response = await http(f.port, { method: "POST", headers: headers(), body: "{}" });
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBe('"1"');
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual(view());
  });
  it("rejects a client-selected member before composition", async () => {
    const f = fixture();
    const response = await http(f.port, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ participantReference: id(99) }),
    });
    expect(response.status).toBe(400);
    expect(f.select).not.toHaveBeenCalled();
  });
  it("rejects a foreign Origin before composition", async () => {
    const f = fixture();
    const response = await http(f.port, {
      method: "POST",
      headers: { ...headers(), origin: "https://other.example.test" },
      body: "{}",
    });
    expect(response.status).toBe(400);
    expect(f.select).not.toHaveBeenCalled();
  });
});

describe("opt-in Dining Cart item API", () => {
  function configured(action: "addItem" | "updateItem" | "removeItem") {
    const itemReceipt = {
      status: "Applied" as const,
      cartReference: parseOrderingReference(id(11)),
      cartItemReference: parseOrderingReference(id(12)),
      aggregateVersion: 2,
    };
    const items = {
      add: vi.fn(async () => itemReceipt),
      update: vi.fn(async () => itemReceipt),
      remove: vi.fn(async () => itemReceipt),
    };
    const current: CustomerCartDisplayView = {
      ...view(),
      cart: {
        ...view().cart,
        version: 2,
        items:
          action === "removeItem"
            ? []
            : [
                {
                  cartItemReference: id(12),
                  sellableReference: id(13),
                  displayName: "Synthetic dish",
                  quantity: 2,
                  configuration: [],
                  customerNote: null,
                  lineEstimate: { status: "Unavailable", reasonCode: "LINE_ESTIMATE_UNAVAILABLE" },
                  warnings: [],
                },
              ],
      },
    };
    const read = vi.fn(async (): Promise<CustomerCartDisplayView | null> => current);
    const port = createCustomerDiningCartPort({
      query: { read },
      selection: { select: async () => receipt() },
      items,
    });
    const common = { ...input(), cartReference: id(11), expectedCartVersion: 1 };
    const request =
      action === "removeItem"
        ? { ...common, cartItemReference: id(12) }
        : {
            ...common,
            ...(action === "addItem"
              ? { sellableReference: id(13) }
              : { cartItemReference: id(12) }),
            quantity: 2,
            optionSelections: [],
            customerNote: null,
          };
    return { items, read, current, port, request, itemReceipt };
  }
  it.each(["addItem", "updateItem", "removeItem"] as const)(
    "maps %s and publishes only a current Dining view",
    async (action) => {
      const f = configured(action);
      expect(await f.port[action](f.request as never)).toEqual({
        status: "Applied",
        view: f.current,
      });
      const method = action === "addItem" ? "add" : action === "updateItem" ? "update" : "remove";
      expect(f.items[method]).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionCredential: credential,
          csrfCredential: csrf,
          cartReference: id(11),
          expectedAggregateVersion: 1,
          operationReference: id(10),
        }),
      );
      expect(f.read).toHaveBeenCalledWith({ sessionCredential: credential, cartReference: id(11) });
    },
  );
  it.each(["addItem", "updateItem", "removeItem"] as const)(
    "rejects wrong-channel post-%s views",
    async (action) => {
      const f = configured(action);
      f.read.mockResolvedValue({
        ...f.current,
        cart: { ...f.current.cart, orderType: "Pickup", serviceMode: "Pickup" },
      });
      expect(await f.port[action](f.request as never)).toEqual({ status: "Unavailable" });
    },
  );
  it("captures removal identifiers before awaiting the command", async () => {
    const f = configured("removeItem");
    f.items.remove.mockImplementation(async () => {
      f.request.cartReference = id(90);
      f.request.guestCredential = "z".repeat(43);
      return f.itemReceipt;
    });
    expect((await f.port.removeItem(f.request as never)).status).toBe("Applied");
    expect(f.read).toHaveBeenCalledWith({ sessionCredential: credential, cartReference: id(11) });
  });
  it("preserves selection when items are enabled", async () => {
    const f = configured("addItem");
    expect((await f.port.createCart(input())).status).toBe("Applied");
  });
  it("retains unknown outcomes after a failed current read", async () => {
    const f = configured("updateItem");
    f.read.mockRejectedValueOnce(new Error("synthetic query failure"));
    expect(await f.port.updateItem(f.request as never)).toEqual({ status: "Unavailable" });
    expect((await f.port.updateItem(f.request as never)).status).toBe("Applied");
    expect(f.items.update).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["CART_PERMISSION_DENIED", "SessionExpired"],
    ["CART_IDEMPOTENCY_CONFLICT", "IdempotencyConflict"],
  ] as const)("maps bounded %s without reading private data", async (code, status) => {
    const f = configured("removeItem");
    f.items.remove.mockRejectedValue(new CartError(code));
    expect(await f.port.removeItem(f.request as never)).toEqual({ status });
    expect(f.read).not.toHaveBeenCalled();
  });
  it("maps version conflict through a current authorized view", async () => {
    const f = configured("addItem");
    f.items.add.mockRejectedValue(new CartError("CART_VERSION_CONFLICT"));
    expect(await f.port.addItem(f.request as never)).toEqual({
      status: "VersionConflict",
      currentVersion: 2,
    });
  });
});
