import { describe, expect, it, vi } from "vitest";
import { decideInitialDiningCartSelection as decide } from "../domain/dining-cart-selection.js";

const id = (n: number) => `018f2315-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-10T12:00:00.000Z";
function input() {
  return {
    brandReference: id(1),
    storeReference: id(2),
    diningSessionReference: id(3),
    guestSessionReference: id(4),
    participantReference: id(5),
    observedAt: at,
    history: [] as unknown[],
    creation: {
      cartReference: id(6),
      sourceChannel: "Qr",
      policy: {
        policyVersionReference: id(7),
        policyDigest: `sha256:${"a".repeat(64)}`,
        idleTimeoutSeconds: 3600,
        absoluteTimeoutSeconds: 7200,
        validFrom: at,
        validUntil: "2026-09-11T12:00:00.000Z",
      },
    },
  };
}
function current() {
  return {
    ...decide(input()).cart,
    aggregateVersion: 4,
    items: [
      {
        cartItemReference: id(8),
        cartReference: id(6),
        sellableReference: id(9),
        quantity: 2,
        optionSelections: [{ optionReference: id(10), quantity: 1 }],
        customerNote: "Synthetic test note",
        catalogSelectionEvidence: null,
        addedByActorReference: id(4),
        addedByParticipantReference: id(5),
        addedAt: at,
      },
    ],
  };
}
function select(cart: unknown = current()) {
  return { ...input(), history: [cart], creation: null };
}

describe("initial shared Dining Cart transition", () => {
  it.each(["Qr", "Web"])("creates one empty version1 %s Cart from explicit policy", (source) => {
    const value = input();
    value.creation.sourceChannel = source;
    const result = decide(value);
    expect(result.action).toBe("Create");
    expect(result.expectedAggregateVersion).toBe(0);
    expect(result.cart).toMatchObject({
      cartReference: id(6),
      brandReference: id(1),
      storeReference: id(2),
      diningSessionReference: id(3),
      orderType: "DineIn",
      sourceChannel: source,
      createdByActorReference: id(4),
      aggregateVersion: 1,
      createdAt: at,
      updatedAt: at,
      items: [],
      lifecycle: {
        idleExpiresAt: "2026-09-10T13:00:00.000Z",
        absoluteExpiresAt: "2026-09-10T14:00:00.000Z",
      },
    });
    expect(result.participantReference).toBe(id(5));
    expect(Object.isFrozen(result.cart.items)).toBe(true);
    expect(Object.isFrozen(result.cart.lifecycle)).toBe(true);
    expect(Object.isFrozen(result.cart)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it("selects the same Cart for another Participant without touching creator, items or deadlines", () => {
    const cart = current();
    const first = decide(select(cart));
    const second = decide({
      ...select(cart),
      guestSessionReference: id(11),
      participantReference: id(12),
    });
    expect(first.action).toBe("Select");
    expect(first.expectedAggregateVersion).toBe(4);
    expect(second.cart).toEqual(first.cart);
    expect(second.cart).toEqual(cart);
    expect(second.guestSessionReference).toBe(id(11));
    expect(second.participantReference).toBe(id(12));
    const item = cart.items[0];
    const option = item?.optionSelections[0];
    if (!item || !option) throw new Error("synthetic fixture missing item");
    item.quantity = 9;
    option.quantity = 4;
    expect(second.cart.items[0]?.quantity).toBe(2);
    expect(second.cart.items[0]?.optionSelections[0]?.quantity).toBe(1);
    expect(Object.isFrozen(second.cart.items[0]?.optionSelections[0])).toBe(true);
  });
  it("reuses a Cart without consulting a replacement policy or allocating another ID", () => {
    expect(decide(select()).cart.lifecycle?.policyVersionReference).toBe(id(7));
    expect(() => decide({ ...select(), creation: input().creation })).toThrowError(
      expect.objectContaining({ code: "CART_INPUT_INVALID" }),
    );
  });
  it.each([
    { brandReference: id(99) },
    { storeReference: id(99) },
    { diningSessionReference: id(99) },
    { orderType: "Pickup", diningSessionReference: null },
    { sourceChannel: "Pos" },
    { sourceChannel: "Api" },
    { updatedAt: "2026-09-10T12:00:01.000Z" },
  ])("rejects wrong scope/source or future owner facts", (change) => {
    expect(() => decide(select({ ...current(), ...change }))).toThrowError(
      expect.objectContaining({ code: "CART_DEPENDENCY_UNAVAILABLE" }),
    );
  });
  it.each(["2026-09-10T13:00:00.000Z", "2026-09-10T14:00:00.000Z"])(
    "does not replace an effectively expired basket at %s",
    (observedAt) => {
      expect(() => decide({ ...select(), observedAt })).toThrowError(
        expect.objectContaining({ code: "CART_EXPIRED" }),
      );
    },
  );
  it.each(["Abandoned", "Expired"])("preserves %s history instead of creating", (status) => {
    const cart = current();
    const terminalAt = status === "Expired" ? "2026-09-10T13:00:00.000Z" : at;
    expect(() =>
      decide({
        ...select({
          ...cart,
          updatedAt: terminalAt,
          lifecycle: {
            ...cart.lifecycle,
            status,
            terminalAt,
            terminalReason: status === "Expired" ? "IDLE_TIMEOUT" : "CUSTOMER_ABANDONED",
          },
        }),
        observedAt: terminalAt,
      }),
    ).toThrowError(
      expect.objectContaining({ code: status === "Expired" ? "CART_EXPIRED" : "CART_ABANDONED" }),
    );
  });
  it("does not treat legacy history as absence", () => {
    expect(() => decide(select({ ...current(), lifecycle: null }))).toThrowError(
      expect.objectContaining({ code: "CART_LIFECYCLE_UNAVAILABLE" }),
    );
  });
  it.each([2, 3])(
    "rejects %i historical candidates without choosing or inspecting them",
    (count) => {
      const getter = vi.fn(() => current());
      const history = new Array(count);
      Object.defineProperty(history, "0", { get: getter, enumerable: true });
      expect(() => decide({ ...select(), history })).toThrowError(
        expect.objectContaining({ code: "CART_DEPENDENCY_UNAVAILABLE" }),
      );
      expect(getter).not.toHaveBeenCalled();
    },
  );
  it.each(["2026-09-10T11:59:59.999Z", "2026-09-11T12:00:00.000Z"])(
    "requires current lifecycle policy at %s",
    (observedAt) => {
      expect(() => decide({ ...input(), observedAt })).toThrowError(
        expect.objectContaining({ code: "CART_LIFECYCLE_UNAVAILABLE" }),
      );
    },
  );
  it.each([
    { idleTimeoutSeconds: 0 },
    { idleTimeoutSeconds: 1.5 },
    { absoluteTimeoutSeconds: 1 },
    { absoluteTimeoutSeconds: 365 * 86400 + 1 },
    { policyDigest: "invalid" },
    { policyVersionReference: "invalid" },
    { validUntil: at },
    { validFrom: "2026-09-10T12:00:00Z" },
    { extra: true },
  ])("rejects invalid or extra lifecycle policy facts", (change) => {
    const value = input();
    expect(() =>
      decide({
        ...value,
        creation: { ...value.creation, policy: { ...value.creation.policy, ...change } },
      }),
    ).toThrowError(expect.objectContaining({ code: "CART_INPUT_INVALID" }));
  });
  it("bounds policy deadline overflow to a Cart error", () => {
    const value = input();
    expect(() =>
      decide({
        ...value,
        observedAt: "9999-12-31T23:59:58.000Z",
        creation: {
          ...value.creation,
          policy: {
            ...value.creation.policy,
            validFrom: "9999-12-31T23:59:58.000Z",
            validUntil: "9999-12-31T23:59:59.000Z",
          },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "CART_INPUT_INVALID" }));
  });
  it.each([
    null,
    [],
    { ...input(), extra: true },
    { ...input(), history: null },
    { ...input(), creation: null },
    { ...input(), participantReference: null },
    { ...input(), guestSessionReference: "invalid" },
    { ...input(), observedAt: "yesterday" },
    { ...input(), creation: { ...input().creation, sourceChannel: "Pos" } },
    { ...input(), creation: { ...input().creation, extra: true } },
    { ...input(), history: new Array(1) },
  ])("rejects malformed owner inputs", (value) => {
    expect(() => decide(value)).toThrowError(
      expect.objectContaining({ code: "CART_INPUT_INVALID" }),
    );
  });
  it("does not invoke getters in input, policy or history", () => {
    const getter = vi.fn(() => current());
    const outer = input();
    Object.defineProperty(outer, "participantReference", { get: getter });
    const policy = input();
    Object.defineProperty(policy.creation.policy, "idleTimeoutSeconds", { get: getter });
    const history = select();
    Object.defineProperty(history.history, "0", { get: getter });
    for (const value of [outer, policy, history])
      expect(() => decide(value)).toThrowError(
        expect.objectContaining({ code: "CART_INPUT_INVALID" }),
      );
    expect(getter).not.toHaveBeenCalled();
  });
});
