import { describe, expect, it } from "vitest";
import { createOrderAggregate, OrderError, parseOrderAggregate } from "../domain/order.js";

const id = (n: number) => `018f5400-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const at = "2026-08-02T15:00:00.000Z";

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    validationReference: id(1),
    validationIntentHash: digest("a"),
    guestSessionReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    cartReference: id(5),
    cartVersion: 7,
    quoteReference: id(6),
    quoteVersion: 1,
    quoteInputDigest: digest("b"),
    orderType: "Pickup",
    sourceChannel: "Qr",
    catalogLines: [
      {
        cartItemReference: id(7),
        sellableReference: id(8),
        menuVersionReference: id(9),
        productVersionReference: id(10),
        validatedAt: at,
      },
      {
        cartItemReference: id(11),
        sellableReference: id(12),
        menuVersionReference: id(9),
        productVersionReference: id(13),
        validatedAt: at,
      },
    ],
    fulfillment: {
      status: "Accepted",
      brandReference: id(3),
      storeReference: id(4),
      cartReference: id(5),
      cartVersion: 7,
      quoteReference: id(6),
      orderType: "Pickup",
      sourceChannel: "Qr",
      evidenceReference: id(14),
      evidenceVersion: 1,
      evidenceDigest: digest("c"),
      checkedAt: at,
      validUntil: "2026-08-02T15:05:00.000Z",
    },
    validatedAt: at,
    validUntil: "2026-08-02T15:05:00.000Z",
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    orderReference: id(20),
    orderBatchReference: id(21),
    submissionReference: id(22),
    diningSessionReference: null,
    createdByActorReference: id(23),
    submittedByActorReference: id(24),
    submittedAt: "2026-08-02T15:01:00.000Z",
    checkoutValidationEvidence: evidence(),
    items: [
      { orderItemReference: id(25), cartItemReference: id(7) },
      { orderItemReference: id(26), cartItemReference: id(11) },
    ],
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: string) {
  expect(action).toThrowError(OrderError);
  try {
    action();
  } catch (error) {
    expect((error as OrderError).code).toBe(code);
  }
}

describe("WP-1221 Order Aggregate minimum model", () => {
  it("creates one immutable submitted/open aggregate and preserves source actors", () => {
    const order = createOrderAggregate(input());

    expect(order).toMatchObject({
      orderReference: id(20),
      brandReference: id(3),
      storeReference: id(4),
      orderType: "Pickup",
      sourceChannel: "Qr",
      createdByActorReference: id(23),
      submittedByActorReference: id(24),
      aggregateVersion: 1,
      canonicalPhase: "Submitted",
      closureStatus: "Open",
      paymentStatus: "NotReported",
    });
    expect(order.batches).toHaveLength(1);
    expect(order.batches[0]).toMatchObject({
      sourceCartReference: id(5),
      sourceCartVersion: 7,
      checkoutValidationReference: id(1),
      quoteReference: id(6),
    });
    expect(order.batches[0].items.map((item) => item.cartItemReference)).toEqual([id(7), id(11)]);
    expect(Object.isFrozen(order)).toBe(true);
    expect(Object.isFrozen(order.batches)).toBe(true);
    expect(Object.isFrozen(order.batches[0].items)).toBe(true);
  });

  it("contains only item identity and defers transaction snapshots", () => {
    const [item] = createOrderAggregate(input()).batches[0].items;
    if (item === undefined) throw new Error("expected Order Item identity");
    expect(Object.keys(item)).toEqual([
      "orderItemReference",
      "orderBatchReference",
      "cartItemReference",
    ]);
    expect(item).not.toHaveProperty("price");
    expect(item).not.toHaveProperty("tax");
    expect(item).not.toHaveProperty("options");
    expect(item).not.toHaveProperty("sellableSnapshot");
  });

  it("accepts DineIn only with an explicit Dining Session", () => {
    const dineInEvidence = evidence({
      orderType: "DineIn",
      fulfillment: { ...evidence().fulfillment, orderType: "DineIn" },
    });
    expect(
      createOrderAggregate(
        input({ checkoutValidationEvidence: dineInEvidence, diningSessionReference: id(30) }),
      ).diningSessionReference,
    ).toBe(id(30));
    expectCode(
      () => createOrderAggregate(input({ checkoutValidationEvidence: dineInEvidence })),
      "ORDER_INPUT_INVALID",
    );
    expectCode(
      () => createOrderAggregate(input({ diningSessionReference: id(30) })),
      "ORDER_INPUT_INVALID",
    );
  });

  it("rejects validation at its exact expiry instant", () => {
    expectCode(
      () => createOrderAggregate(input({ submittedAt: "2026-08-02T15:05:00.000Z" })),
      "ORDER_VALIDATION_EXPIRED",
    );
  });

  it("rejects creation before validation occurred", () => {
    expectCode(
      () => createOrderAggregate(input({ submittedAt: "2026-08-02T14:59:59.999Z" })),
      "ORDER_INPUT_INVALID",
    );
  });

  it("requires an exact one-to-one mapping of validated Cart Items", () => {
    expectCode(
      () =>
        createOrderAggregate(
          input({ items: [{ orderItemReference: id(25), cartItemReference: id(7) }] }),
        ),
      "ORDER_INPUT_INVALID",
    );
    expectCode(
      () =>
        createOrderAggregate(
          input({
            items: [
              { orderItemReference: id(25), cartItemReference: id(7) },
              { orderItemReference: id(26), cartItemReference: id(30) },
            ],
          }),
        ),
      "ORDER_INPUT_INVALID",
    );
  });

  it("requires stable unique Order, Batch and Item identities", () => {
    expectCode(
      () =>
        createOrderAggregate(
          input({
            items: [
              { orderItemReference: id(20), cartItemReference: id(7) },
              { orderItemReference: id(26), cartItemReference: id(11) },
            ],
          }),
        ),
      "ORDER_INPUT_INVALID",
    );
  });

  it("rejects malformed or extra input fields", () => {
    expectCode(
      () => createOrderAggregate({ ...input(), amount: 1 } as unknown as ReturnType<typeof input>),
      "ORDER_INPUT_INVALID",
    );
    expectCode(
      () => createOrderAggregate(input({ orderReference: "not-a-reference" })),
      "ORDER_INPUT_INVALID",
    );
  });

  it("fails closed on malformed Checkout evidence", () => {
    expectCode(
      () =>
        createOrderAggregate(
          input({ checkoutValidationEvidence: { ...evidence(), injected: true } }),
        ),
      "ORDER_INPUT_INVALID",
    );
  });

  it("round-trips the stored minimum contract and rejects lifecycle invention", () => {
    const order = createOrderAggregate(input());
    expect(parseOrderAggregate(order)).toEqual(order);
    expectCode(
      () => parseOrderAggregate({ ...order, canonicalPhase: "Accepted" }),
      "ORDER_INPUT_INVALID",
    );
    expectCode(
      () => parseOrderAggregate({ ...order, paymentStatus: "Paid" }),
      "ORDER_INPUT_INVALID",
    );
  });
});
