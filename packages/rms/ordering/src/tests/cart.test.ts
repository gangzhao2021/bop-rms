import { describe, expect, it } from "vitest";
import { CartError, parseCartAggregate } from "../domain/cart.js";

const id = (n: number) => `018f5000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T14:00:00.000Z";

function pickup() {
  return {
    cartReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderType: "Pickup",
    sourceChannel: "Qr",
    diningSessionReference: null,
    createdByActorReference: id(4),
    aggregateVersion: 1,
    createdAt: at,
    updatedAt: at,
    lifecycle: {
      status: "Active",
      policyVersionReference: id(11),
      policyDigest: `sha256:${"a".repeat(64)}`,
      idleTimeoutSeconds: 3600,
      absoluteTimeoutSeconds: 86400,
      idleExpiresAt: "2026-08-02T15:00:00.000Z",
      absoluteExpiresAt: "2026-08-03T14:00:00.000Z",
      terminalAt: null,
      terminalReason: null,
    },
    items: [
      {
        cartItemReference: id(5),
        cartReference: id(1),
        sellableReference: id(6),
        quantity: 2,
        optionSelections: [{ optionReference: id(7), quantity: 1 }],
        customerNote: null,
        catalogSelectionEvidence: null,
        addedByActorReference: id(4),
        addedByParticipantReference: null,
        addedAt: at,
      },
    ],
  };
}

describe("Cart aggregate minimum model", () => {
  it("parses and freezes a Store-scoped Pickup Cart without price facts", () => {
    const cart = parseCartAggregate(pickup());
    expect(cart).toMatchObject({
      orderType: "Pickup",
      aggregateVersion: 1,
      lifecycle: { status: "Active" },
    });
    expect(Object.isFrozen(cart)).toBe(true);
    expect(Object.isFrozen(cart.items)).toBe(true);
    expect(Object.keys(cart.items[0] ?? {})).not.toContain("price");
  });

  it("requires one Dining Session and Participant attribution for Dine-in", () => {
    const input = pickup();
    expect(() => parseCartAggregate({ ...input, orderType: "DineIn" })).toThrow(CartError);
    expect(() =>
      parseCartAggregate({
        ...input,
        orderType: "DineIn",
        diningSessionReference: id(8),
      }),
    ).toThrow(CartError);
    expect(
      parseCartAggregate({
        ...input,
        orderType: "DineIn",
        diningSessionReference: id(8),
        items: [{ ...input.items[0], addedByParticipantReference: id(9) }],
      }).diningSessionReference,
    ).toBe(id(8));
  });

  it("rejects duplicate Item and Option identities or a foreign Cart Item", () => {
    const input = pickup();
    expect(() => parseCartAggregate({ ...input, items: [...input.items, input.items[0]] })).toThrow(
      CartError,
    );
    expect(() =>
      parseCartAggregate({
        ...input,
        items: [{ ...input.items[0], cartReference: id(10) }],
      }),
    ).toThrow(CartError);
    expect(() =>
      parseCartAggregate({
        ...input,
        items: [
          {
            ...input.items[0],
            optionSelections: [
              { optionReference: id(7), quantity: 1 },
              { optionReference: id(7), quantity: 2 },
            ],
          },
        ],
      }),
    ).toThrow(CartError);
  });

  it("rejects binary/non-integer quantity, invalid time ordering and non-closed input", () => {
    const input = pickup();
    for (const invalidQuantity of [0, 1.5, Number.NaN, 1000])
      expect(() =>
        parseCartAggregate({
          ...input,
          items: [{ ...input.items[0], quantity: invalidQuantity }],
        }),
      ).toThrow(CartError);
    expect(() => parseCartAggregate({ ...input, updatedAt: "2026-08-02T13:59:59.999Z" })).toThrow(
      CartError,
    );
    expect(() => parseCartAggregate({ ...input, clientPrice: 999 })).toThrow(CartError);
  });

  it("fails closed for accessor-bearing structures", () => {
    const input = pickup();
    const hostile = Object.defineProperty({ ...input }, "items", {
      enumerable: true,
      get: () => input.items,
    });
    expect(() => parseCartAggregate(hostile)).toThrow(CartError);
  });
});

describe("WP-2270 Cart revision storage boundary", () => {
  it.each([1, 999, 1000, 2_147_483_647])(
    "accepts revision %s independently of quantity",
    (version) => {
      const input = pickup();
      input.aggregateVersion = version;
      expect(parseCartAggregate(input).aggregateVersion).toBe(version);
      expect(parseCartAggregate(input).items[0]?.quantity).toBe(2);
    },
  );
  it.each([0, -1, 1.5, NaN, Infinity, "1000", null, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid or out-of-storage revision %s",
    (version) => {
      expect(() => parseCartAggregate({ ...pickup(), aggregateVersion: version })).toThrow(
        CartError,
      );
    },
  );
  it.each(["item", "option"])("preserves %s quantity bounds above revision999", (kind) => {
    const input = pickup();
    const item = input.items[0];
    if (!item) throw new Error("fixture item missing");
    for (const quantity of [999, 1000]) {
      const candidate = {
        ...input,
        aggregateVersion: 1000,
        items: [
          {
            ...item,
            ...(kind === "item"
              ? { quantity }
              : { optionSelections: [{ optionReference: id(7), quantity }] }),
          },
        ],
      };
      if (quantity === 999) expect(parseCartAggregate(candidate).aggregateVersion).toBe(1000);
      else expect(() => parseCartAggregate(candidate)).toThrow(CartError);
    }
  });
});
