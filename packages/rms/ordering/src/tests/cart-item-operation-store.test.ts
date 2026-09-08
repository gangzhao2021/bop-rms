import { describe, expect, it, vi } from "vitest";
import { createPostgresCartItemOperationStore } from "../infrastructure/persistence/cart-item-operation-store.js";

const id = (n: number) => `018f5000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T14:00:00.000Z";
const scope = { brandReference: id(2), storeReference: id(3) };
function row() {
  return {
    operationReference: id(9),
    ...scope,
    cartReference: id(1),
    cartItemReference: id(5),
    guestSessionReference: id(4),
    action: "Add",
    operationIntentHash: `sha256:${"a".repeat(64)}`,
    aggregateVersion: 2,
    occurredAt: at,
    expiresAt: "2026-08-03T14:00:00.000Z",
    result: {
      cartReference: id(1),
      ...scope,
      orderType: "Pickup",
      sourceChannel: "Qr",
      diningSessionReference: null,
      createdByActorReference: id(4),
      aggregateVersion: 2,
      createdAt: at,
      updatedAt: at,
      lifecycle: null,
      items: [
        {
          cartItemReference: id(5),
          cartReference: id(1),
          sellableReference: id(6),
          quantity: 2,
          optionSelections: [],
          customerNote: "Synthetic note",
          catalogSelectionEvidence: null,
          addedByActorReference: id(4),
          addedByParticipantReference: null,
          addedAt: at,
        },
      ],
    },
  };
}
function fixture(response: unknown = { rows: [row()] }) {
  let calls = 0;
  const query = vi.fn<(sql: string, values: readonly unknown[]) => Promise<unknown>>(async () =>
    ++calls % 2 === 1 ? { rows: [] } : response,
  );
  const runner = {
    run: async <T>(action: (transaction: { query: typeof query }) => Promise<T>) =>
      action({ query }),
  };
  return { query, runner, store: createPostgresCartItemOperationStore(runner, scope) };
}

describe("scoped Cart Item operation reader", () => {
  it.each(["Add", "Update", "Remove"])(
    "reconstructs original %s history without reading the current Cart",
    async (action) => {
      const record = row();
      record.action = action;
      if (action === "Remove") record.result.items = [];
      const f = fixture({ rows: [record] });
      const result = await f.store.resolveOperation(id(9));
      expect(result).toMatchObject({
        action,
        result: record.result,
        occurredAt: at,
        expiresAt: record.expiresAt,
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result?.result.items)).toBe(true);
      expect(f.query).toHaveBeenCalledTimes(2);
      expect(f.query.mock.calls[1]?.[0]).not.toContain("JOIN");
      expect(f.query.mock.calls[1]?.[1]).toEqual([id(2), id(3), id(9)]);
    },
  );
  it("copies scope and returns null only for absent rows", async () => {
    const f = fixture({ rows: [] });
    const mutable = { ...scope };
    const store = createPostgresCartItemOperationStore(f.runner, mutable);
    mutable.storeReference = id(90);
    expect(await store.resolveOperation(id(9))).toBeNull();
    expect(f.query.mock.calls.map((call) => call[1])).toEqual([
      [id(2), id(3)],
      [id(2), id(3), id(9)],
    ]);
  });
  it("rejects invalid references without a query", async () => {
    const f = fixture();
    await expect(f.store.resolveOperation("invalid")).rejects.toMatchObject({
      code: "CART_INPUT_INVALID",
    });
    expect(() =>
      createPostgresCartItemOperationStore(f.runner, { ...scope, brandReference: "invalid" }),
    ).toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });
  it.each([
    { operationReference: id(90) },
    { brandReference: id(90) },
    { storeReference: id(90) },
    { cartReference: id(90) },
    { cartItemReference: id(90) },
    { guestSessionReference: "invalid" },
    { guestSessionReference: id(90) },
    { operationIntentHash: "invalid" },
    { aggregateVersion: 3 },
    { action: "Unknown" },
    { action: "Remove" },
    { expiresAt: at },
    { occurredAt: "2026-08-02T14:01:00.000Z" },
    { result: { ...row().result, brandReference: id(90) } },
    { result: { ...row().result, storeReference: id(90) } },
  ])("bounds inconsistent persisted history", async (override) => {
    await expect(
      fixture({ rows: [{ ...row(), ...override }] }).store.resolveOperation(id(9)),
    ).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
  });
  it.each([null, {}, { rows: null }, { rows: [null] }, { rows: [{}] }, { rows: [row(), row()] }])(
    "bounds malformed driver results",
    async (response) => {
      await expect(fixture(response).store.resolveOperation(id(9))).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it("rejects accessors without evaluating them", async () => {
    const get = vi.fn(() => row().result);
    const record = Object.defineProperty(row(), "result", { get, enumerable: true });
    await expect(fixture({ rows: [record] }).store.resolveOperation(id(9))).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(get).not.toHaveBeenCalled();
  });
  it("hides driver failure details", async () => {
    const store = createPostgresCartItemOperationStore(
      {
        async run() {
          throw new Error("synthetic database detail");
        },
      },
      scope,
    );
    const error = await store.resolveOperation(id(9)).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
    expect(error).not.toHaveProperty("cause");
  });
});
