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
    expect(cart).toMatchObject({ orderType: "Pickup", aggregateVersion: 1 });
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
