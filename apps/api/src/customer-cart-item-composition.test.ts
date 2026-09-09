import { describe, expect, it, vi } from "vitest";
import { CartError, type CustomerCartDisplayView, type PickupCartItemResult } from "@rms/ordering";
import { createCustomerCartItemPort } from "./customer-cart-item-composition.js";
const credential = "a".repeat(43);
const reference = "018f5500-0000-7000-8000-000000000001";
const context = { guestCredential: credential, requestedAt: "2026-09-08T12:00:00.000Z" };
const view: CustomerCartDisplayView = {
  schemaVersion: 1,
  cart: {
    cartReference: reference,
    version: 1,
    orderType: "Pickup",
    serviceMode: "Pickup",
    context: { brandName: "Synthetic Brand", storeName: "Synthetic Store" },
    lifecycle: {
      status: "Active",
      idleExpiresAt: "2026-09-08T13:00:00.000Z",
      absoluteExpiresAt: "2026-09-09T12:00:00.000Z",
    },
    items: [],
    quote: null,
    warnings: [],
  },
};

const input = {
  ...context,
  cartReference: reference,
  cartItemReference: reference.slice(0, -1) + "2",
  csrfCredential: "b".repeat(43),
  operationReference: reference.slice(0, -1) + "3",
  expectedCartVersion: 1,
  quantity: 2,
  optionSelections: [],
  customerNote: null,
};
const receipt = {
  status: "Applied",
  cartReference: reference,
  cartItemReference: input.cartItemReference,
  aggregateVersion: 2,
} as PickupCartItemResult;
const item = {
  cartItemReference: input.cartItemReference,
  sellableReference: reference.slice(0, -1) + "4",
  displayName: "Synthetic item",
  quantity: 2,
  configuration: [],
  customerNote: null,
  lineEstimate: { status: "Unavailable", reasonCode: "LINE_ESTIMATE_UNAVAILABLE" },
  warnings: [],
} as const;
const current: CustomerCartDisplayView = {
  ...view,
  cart: { ...view.cart, version: 2, items: [item] },
};
const common = {
  ...context,
  csrfCredential: input.csrfCredential,
  operationReference: input.operationReference,
  cartReference: reference,
  expectedCartVersion: 1,
  quantity: 2,
  optionSelections: [],
  customerNote: null,
};
const addInput = { ...common, sellableReference: item.sellableReference };
function setup() {
  const read = vi.fn(async (): Promise<CustomerCartDisplayView | null> => current);
  const add = vi.fn(async () => receipt);
  const update = vi.fn(async () => receipt);
  return {
    read,
    add,
    update,
    port: createCustomerCartItemPort({ query: { read }, items: { add, update } }),
  };
}

describe("Pickup add/update HTTP composition", () => {
  it.each(["Applied", "AlreadyApplied"] as const)(
    "reads an authorized current view after %s",
    async (status) => {
      const f = setup();
      f.add.mockResolvedValue({ ...receipt, status });
      expect(await f.port.addItem(addInput)).toEqual({ status: "Applied", view: current });
      expect(await f.port.updateItem(input)).toEqual({ status: "Applied", view: current });
      expect(f.add).toHaveBeenCalledWith({
        sessionCredential: credential,
        csrfCredential: input.csrfCredential,
        operationReference: input.operationReference,
        cartReference: reference,
        expectedAggregateVersion: 1,
        sellableReference: item.sellableReference,
        quantity: 2,
        optionSelections: [],
        customerNote: null,
      });
    },
  );
  it("accepts a later view after a historically successful item was removed", async () => {
    const f = setup();
    f.read.mockResolvedValue({ ...view, cart: { ...view.cart, version: 3 } });
    expect(await f.port.addItem(addInput)).toMatchObject({
      status: "Applied",
      view: { cart: { version: 3, items: [] } },
    });
  });
  it.each([
    null,
    view,
    { ...current, cart: { ...current.cart, items: [] } },
    { ...current, cart: { ...current.cart, cartReference: input.cartItemReference } },
    { ...current, cart: { ...current.cart, items: [{ ...item, quantity: 9 }] } },
  ])("preserves uncertainty for failed/inconsistent readback", async (value) => {
    const f = setup();
    f.read.mockResolvedValue(value);
    expect(await f.port.addItem(addInput)).toEqual({ status: "Unavailable" });
  });
  it("preserves uncertainty for post-write permission loss", async () => {
    const f = setup();
    f.read.mockRejectedValue(new CartError("CART_PERMISSION_DENIED"));
    expect(await f.port.updateItem(input)).toEqual({ status: "Unavailable" });
  });
  it.each([
    { aggregateVersion: 1 },
    { aggregateVersion: 3 },
    { status: "Other" },
    { cartReference: input.cartItemReference },
    { cartItemReference: "invalid" },
    { extra: true },
  ])("closes receipts before readback", async (change) => {
    const f = setup();
    f.add.mockResolvedValue({ ...receipt, ...change } as never);
    expect(await f.port.addItem(addInput)).toEqual({ status: "Unavailable" });
    expect(f.read).not.toHaveBeenCalled();
  });
  it("owns receipts before awaiting display reads", async () => {
    const f = setup();
    const mutable = { ...receipt };
    f.add.mockResolvedValue(mutable);
    f.read.mockImplementation(async () => {
      mutable.cartReference = input.cartItemReference as never;
      mutable.aggregateVersion = 100;
      return current;
    });
    expect(await f.port.addItem(addInput)).toEqual({ status: "Applied", view: current });
  });
  it("owns request values before awaiting the command", async () => {
    const f = setup();
    const mutable = { ...addInput };
    const pending = f.port.addItem(mutable);
    mutable.quantity = 99;
    mutable.cartReference = input.cartItemReference;
    expect(await pending).toEqual({ status: "Applied", view: current });
    expect(f.read).toHaveBeenCalledWith({
      sessionCredential: credential,
      cartReference: reference,
    });
  });
  it("rejects request getters without evaluation", async () => {
    const f = setup();
    const getter = vi.fn(() => 2);
    const value = { ...addInput };
    Object.defineProperty(value, "quantity", { enumerable: true, get: getter });
    expect(await f.port.addItem(value)).toEqual({ status: "Unavailable" });
    expect(getter).not.toHaveBeenCalled();
    expect(f.add).not.toHaveBeenCalled();
  });
  it.each([
    ["CART_PERMISSION_DENIED", "SessionExpired"],
    ["CART_UNAVAILABLE", "NotFound"],
    ["CART_ITEM_NOT_FOUND", "NotFound"],
    ["CART_IDEMPOTENCY_CONFLICT", "IdempotencyConflict"],
    ["CART_EXPIRED", "LifecycleExpired"],
    ["CART_ABANDONED", "LifecycleAbandoned"],
    ["CART_DEPENDENCY_UNAVAILABLE", "Unavailable"],
  ] as const)("maps %s", async (code, status) => {
    const f = setup();
    f.add.mockRejectedValue(new CartError(code));
    expect(await f.port.addItem(addInput)).toEqual({ status });
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each([
    ["CART_SELECTION_INVALID", "CATALOG_SELECTION_REJECTED"],
    ["CART_INPUT_INVALID", "CART_INPUT_INVALID"],
    ["CART_ITEM_LIMIT_REACHED", "CART_ITEM_LIMIT_REACHED"],
  ] as const)("bounds selection error %s", async (code, issue) => {
    const f = setup();
    f.update.mockRejectedValue(new CartError(code));
    expect(await f.port.updateItem(input)).toEqual({
      status: "SelectionInvalid",
      issueCodes: [issue],
    });
  });
  it("reports version conflict only with a current authorized view", async () => {
    const f = setup();
    f.add.mockRejectedValue(new CartError("CART_VERSION_CONFLICT"));
    expect(await f.port.addItem(addInput)).toEqual({
      status: "VersionConflict",
      currentVersion: 2,
    });
    f.read.mockResolvedValue(null);
    expect(await f.port.addItem(addInput)).toEqual({ status: "Unavailable" });
  });
  it("preserves configured removal and reads", async () => {
    const f = setup();
    const removeItem = vi.fn(async () => ({ status: "NotFound" as const }));
    const fallback = { ...f.port, removeItem };
    const port = createCustomerCartItemPort({
      query: { read: f.read },
      items: { add: f.add, update: f.update },
      fallback,
    });
    expect(port.removeItem).toBe(removeItem);
    expect(port.getCart).toBe(fallback.getCart);
    expect(await port.removeItem({} as never)).toEqual({ status: "NotFound" });
  });
  it("leaves unconfigured creation and removal unavailable", async () => {
    const f = setup();
    expect(await f.port.createCart({} as never)).toEqual({ status: "Unavailable" });
    expect(await f.port.removeItem({} as never)).toEqual({ status: "Unavailable" });
  });
});
