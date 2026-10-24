import { describe, expect, it } from "vitest";
import {
  resolvePickupCapacityCartSource,
  resolveConfiguredPickupCapacityCartSource,
  parseCartAggregate,
  parseCartQuoteAttachment,
  type CartAggregate,
  type CartQuoteAttachment,
} from "../index.js";
const id = (n: number) => `018f5400-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const at = "2026-08-02T15:00:00.000Z";
const ids = {
  cart: id(1),
  brand: id(2),
  store: id(3),
  session: id(4),
  publicStore: id(5),
  qr: id(6),
  item: id(7),
  sellable: id(8),
  productVersion: id(9),
  menuVersion: id(10),
  binding: id(11),
  optionSetVersion: id(12),
  quote: id(13),
  operation: id(14),
  fulfillment: id(15),
  currency: id(16),
};

function cart(overrides: Partial<CartAggregate> = {}): CartAggregate {
  return parseCartAggregate({
    cartReference: ids.cart,
    brandReference: ids.brand,
    storeReference: ids.store,
    orderType: "Pickup",
    sourceChannel: "Qr",
    diningSessionReference: null,
    createdByActorReference: ids.session,
    aggregateVersion: 4,
    createdAt: "2026-08-02T14:00:00.000Z",
    updatedAt: "2026-08-02T14:30:00.000Z",
    lifecycle: {
      status: "Active",
      policyVersionReference: id(40),
      policyDigest: digest("c"),
      idleTimeoutSeconds: 3600,
      absoluteTimeoutSeconds: 86400,
      idleExpiresAt: "2026-08-02T15:30:00.000Z",
      absoluteExpiresAt: "2026-08-03T14:00:00.000Z",
      terminalAt: null,
      terminalReason: null,
    },
    items: [
      {
        cartItemReference: ids.item,
        cartReference: ids.cart,
        sellableReference: ids.sellable,
        quantity: 2,
        optionSelections: [],
        customerNote: null,
        catalogSelectionEvidence: {
          menuVersionReference: ids.menuVersion,
          productVersionReference: ids.productVersion,
          catalogChannelCode: "PILOT_CHANNEL",
          catalogOrderTypeCode: "PILOT_ORDER_TYPE",
          ruleEvidence: [
            {
              bindingReference: ids.binding,
              optionSetVersionReference: ids.optionSetVersion,
            },
          ],
          validatedAt: "2026-08-02T14:30:00.000Z",
        },
        addedByActorReference: ids.session,
        addedByParticipantReference: null,
        addedAt: "2026-08-02T14:30:00.000Z",
      },
    ],
    ...overrides,
  });
}

function quote(overrides: Partial<CartQuoteAttachment> = {}): CartQuoteAttachment {
  return parseCartQuoteAttachment({
    operationReference: id(30),
    operationIntentHash: digest("a"),
    guestSessionReference: ids.session,
    cartReference: ids.cart,
    brandReference: ids.brand,
    storeReference: ids.store,
    cartVersion: 4,
    quoteReference: ids.quote,
    quoteVersion: 1,
    quoteInputDigest: digest("b"),
    currencyCode: "CAD",
    currencyMetadataVersion: 1,
    currencyMetadataVersionReference: ids.currency,
    subtotal: { amountMinor: 2000n, currencyCode: "CAD" },
    discount: { amountMinor: 0n, currencyCode: "CAD" },
    tax: { amountMinor: 260n, currencyCode: "CAD" },
    fee: { amountMinor: 0n, currencyCode: "CAD" },
    total: { amountMinor: 2260n, currencyCode: "CAD" },
    lines: [
      {
        lineReference: ids.item,
        sellableReference: ids.sellable,
        productVersionReference: ids.productVersion,
        menuVersionReference: ids.menuVersion,
        quantity: 2,
      },
    ],
    warnings: [],
    quoteCreatedAt: "2026-08-02T14:59:00.000Z",
    quoteExpiresAt: "2026-08-02T15:05:00.000Z",
    attachedAt: at,
    idempotencyExpiresAt: "2026-08-03T15:00:00.000Z",
    ...overrides,
  });
}

function input() {
  return {
    cart: cart(),
    quote: quote(),
    guestSessionReference: ids.session,
    brandReference: ids.brand,
    storeReference: ids.store,
    cartReference: ids.cart,
    cartVersion: 4,
    quoteReference: ids.quote,
    observedAt: at,
  };
}
describe("Pickup owner Cart and Quote capacity source", () => {
  it("returns exact minimal source and its earliest deadline", () => {
    const result = resolvePickupCapacityCartSource(input());
    expect(result).toMatchObject({
      cartReference: ids.cart,
      cartVersion: 4,
      quoteReference: ids.quote,
      quoteInputDigest: digest("b"),
      validUntil: "2026-08-02T15:05:00.000Z",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).not.toHaveProperty("items");
    expect(result).not.toHaveProperty("total");
  });
  it.each([
    "guestSessionReference",
    "brandReference",
    "storeReference",
    "cartReference",
    "quoteReference",
  ])("rejects mismatched %s", (key) => {
    expect(() => resolvePickupCapacityCartSource({ ...input(), [key]: id(999) })).toThrow();
  });
  it("rejects another Cart version and quote line configuration", () => {
    expect(() => resolvePickupCapacityCartSource({ ...input(), cartVersion: 5 })).toThrow();
    const q = quote();
    expect(() =>
      resolvePickupCapacityCartSource({
        ...input(),
        quote: quote({
          lines: q.lines.map((line) => ({ ...line, productVersionReference: id(999) as never })),
        }),
      }),
    ).toThrow();
  });
  it("rejects exact Quote expiry and lifecycle expiry", () => {
    expect(() =>
      resolvePickupCapacityCartSource({ ...input(), observedAt: "2026-08-02T15:05:00.000Z" }),
    ).toThrow();
    const c = cart();
    expect(() =>
      resolvePickupCapacityCartSource({
        ...input(),
        cart: cart({
          lifecycle: { ...c.lifecycle, idleExpiresAt: at } as never,
        }),
      }),
    ).toThrow();
  });
  it("rejects a Quote belonging to another Guest and future attachment", () => {
    expect(() =>
      resolvePickupCapacityCartSource({
        ...input(),
        quote: quote({ guestSessionReference: id(999) as never }),
      }),
    ).toThrow();
    expect(() =>
      resolvePickupCapacityCartSource({ ...input(), observedAt: "2026-08-02T14:59:30.000Z" }),
    ).toThrow();
  });
  it("does not read accessor-based untrusted source fields", () => {
    const value = { ...input() };
    Object.defineProperty(value, "cart", {
      enumerable: true,
      get() {
        throw new Error("must not evaluate");
      },
    });
    expect(() => resolvePickupCapacityCartSource(value)).toThrow("checkout");
  });
});

it("requires an explicit configured capacity source and retains scope/expiry guards", () => {
  const original = input(),
    configured = { ...original, quote: { ...original.quote, quoteVersion: 2 } };
  expect(resolveConfiguredPickupCapacityCartSource(configured)).toEqual(
    resolvePickupCapacityCartSource(original),
  );
  expect(() => resolvePickupCapacityCartSource(configured)).toThrow();
  expect(() => resolveConfiguredPickupCapacityCartSource(original)).toThrow();
  expect(() =>
    resolveConfiguredPickupCapacityCartSource({ ...configured, storeReference: id(999) }),
  ).toThrow();
  expect(() =>
    resolveConfiguredPickupCapacityCartSource({
      ...configured,
      observedAt: configured.quote.quoteExpiresAt,
    }),
  ).toThrow();
});
