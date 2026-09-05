import { describe, expect, it } from "vitest";
import { parseCartAggregate, CartError, type CartAggregate } from "../domain/cart.js";
import {
  createEmptyCustomerCartView,
  parseCustomerCartDisplay,
  type CustomerCartDisplayRequest,
} from "../application/customer-cart-view.js";
const id = (n: number) => `018f5100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  cart: id(1),
  brand: id(2),
  store: id(3),
  session: id(4),
  publicStore: id(5),
  qr: id(6),
  sellable: id(7),
  option: id(8),
  item: id(9),
  operation: id(10),
  secondOperation: id(11),
  thirdOperation: id(12),
  audit: id(13),
  correlation: id(14),
  diningSession: id(15),
  participant: id(16),
  otherParticipant: id(17),
  otherSession: id(18),
  menuVersion: id(19),
  productVersion: id(20),
  binding: id(21),
  optionSetVersion: id(22),
};
const createdAt = "2026-08-02T14:00:00.000Z";
const requestedAt = "2026-08-02T14:01:00.000Z";

function cart(overrides: Partial<CartAggregate> = {}): CartAggregate {
  return parseCartAggregate({
    cartReference: ids.cart,
    brandReference: ids.brand,
    storeReference: ids.store,
    orderType: "Pickup",
    sourceChannel: "Qr",
    diningSessionReference: null,
    createdByActorReference: ids.session,
    aggregateVersion: 1,
    createdAt,
    updatedAt: createdAt,
    lifecycle: {
      status: "Active",
      policyVersionReference: id(40),
      policyDigest: `sha256:${"a".repeat(64)}`,
      idleTimeoutSeconds: 3600,
      absoluteTimeoutSeconds: 86400,
      idleExpiresAt: "2026-08-02T15:00:00.000Z",
      absoluteExpiresAt: "2026-08-03T14:00:00.000Z",
      terminalAt: null,
      terminalReason: null,
    },
    items: [],
    ...overrides,
  });
}

const request: CustomerCartDisplayRequest = {
  purpose: "CustomerCart",
  brandReference: ids.brand,
  storeReference: ids.store,
  publicStoreReference: ids.publicStore,
  locale: "en-CA",
  orderType: "Pickup",
  evaluatedAt: requestedAt,
};
const source = () => ({
  ...request,
  brandName: "Synthetic Brand",
  storeName: "Synthetic Store",
  serviceMode: "Pickup",
});
describe("Ordering-owned safe empty Cart view", () => {
  it("emits only the existing public wire fields", () => {
    const view = createEmptyCustomerCartView(cart(), parseCustomerCartDisplay(source(), request));
    expect(view.cart.items).toEqual([]);
    expect(view.cart.quote).toBeNull();
    expect(Object.keys(view.cart).sort()).toEqual(
      [
        "cartReference",
        "version",
        "orderType",
        "serviceMode",
        "context",
        "lifecycle",
        "items",
        "quote",
        "warnings",
      ].sort(),
    );
    expect(JSON.stringify(view)).not.toContain("policyDigest");
    expect(Object.isFrozen(view.cart.context)).toBe(true);
  });
  it.each([
    "purpose",
    "brandReference",
    "storeReference",
    "publicStoreReference",
    "locale",
    "orderType",
    "evaluatedAt",
    "serviceMode",
  ])("rejects mismatched %s", (key) => {
    expect(() => parseCustomerCartDisplay({ ...source(), [key]: "mismatch" }, request)).toThrow(
      CartError,
    );
  });
  it("rejects extra fields/accessors and invalid labels", () => {
    expect(() =>
      parseCustomerCartDisplay({ ...source(), credential: "synthetic" }, request),
    ).toThrow(CartError);
    expect(() =>
      parseCustomerCartDisplay(
        {
          ...source(),
          get brandName() {
            throw new Error("must not execute");
          },
        },
        request,
      ),
    ).toThrow(CartError);
    expect(() => parseCustomerCartDisplay({ ...source(), storeName: "\n" }, request)).toThrow(
      CartError,
    );
  });
  it("rejects non-pristine or foreign Cart state", () => {
    const display = parseCustomerCartDisplay(source(), request);
    expect(() => createEmptyCustomerCartView(cart({ aggregateVersion: 2 }), display)).toThrow(
      CartError,
    );
    expect(() =>
      createEmptyCustomerCartView(cart({ storeReference: id(400) as never }), display),
    ).toThrow(CartError);
  });
});
