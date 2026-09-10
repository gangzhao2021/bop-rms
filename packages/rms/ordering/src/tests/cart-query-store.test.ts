import { describe, expect, it, vi } from "vitest";
import {
  createPostgresCartQueryStore,
  createPostgresDiningCartCommandQueryStore,
} from "../infrastructure/persistence/cart-query-store.js";

const id = (n: number) => `018f5000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T14:00:00.000Z";
const scope = { brandReference: id(2), storeReference: id(3) };
function cart() {
  return {
    cartReference: id(1),
    ...scope,
    orderType: "Pickup",
    sourceChannel: "Qr",
    diningSessionReference: null,
    createdByActorReference: id(4),
    aggregateVersion: 1,
    createdAt: at,
    updatedAt: at,
    lifecycle: null,
    items: [
      {
        cartItemReference: id(5),
        cartReference: id(1),
        sellableReference: id(6),
        quantity: 2,
        optionSelections: [{ optionReference: id(7), quantity: 1 }],
        customerNote: "Synthetic preparation note",
        catalogSelectionEvidence: null,
        addedByActorReference: id(4),
        addedByParticipantReference: null,
        addedAt: at,
      },
    ],
  };
}
function fixture(result: unknown = { rows: [{ cart: cart() }] }) {
  let calls = 0;
  const query = vi.fn<(sql: string, values: readonly unknown[]) => Promise<unknown>>(async () =>
    ++calls % 2 === 1 ? { rows: [] } : result,
  );
  const runner = {
    run: async <T>(action: (transaction: { query: typeof query }) => Promise<T>) =>
      action({ query }),
  };
  return { query, runner, reader: createPostgresCartQueryStore(runner, scope) };
}

describe("scoped PostgreSQL Cart reader", () => {
  it.each(["Qr", "Web"])(
    "binds Dining command reads before restricted aggregate retrieval: %s",
    async (sourceChannel) => {
      const record = {
        ...cart(),
        orderType: "DineIn",
        sourceChannel,
        diningSessionReference: id(40),
        items: [],
      };
      const f = fixture({ rows: [{ cart: record }] });
      const mutable = { ...scope, diningSessionReference: id(40) };
      const reader = createPostgresDiningCartCommandQueryStore(f.runner, mutable);
      mutable.diningSessionReference = id(90);
      expect(await reader.load(id(1))).toEqual(record);
      expect(f.query.mock.calls[1]?.[1]).toEqual([id(2), id(3), id(1), id(40)]);
      expect(f.query.mock.calls[1]?.[0]).toContain(
        "AND c.dining_session_id = $4 AND c.order_type = 'DineIn' AND c.source_channel IN ('Qr', 'Web')",
      );
    },
  );
  it.each([
    { diningSessionReference: id(90) },
    { sourceChannel: "Pos" },
    { orderType: "Pickup", diningSessionReference: null },
  ])("denies mismatched Dining results even from a faulty adapter", async (override) => {
    const f = fixture({
      rows: [
        {
          cart: {
            ...cart(),
            orderType: "DineIn",
            diningSessionReference: id(40),
            items: [],
            ...override,
          },
        },
      ],
    });
    const reader = createPostgresDiningCartCommandQueryStore(f.runner, {
      ...scope,
      diningSessionReference: id(40),
    });
    await expect(reader.load(id(1))).rejects.toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
  });
  it("rejects invalid Dining scope before a transaction and returns null for inaccessible Carts", async () => {
    const f = fixture({ rows: [] });
    expect(() =>
      createPostgresDiningCartCommandQueryStore(f.runner, {
        ...scope,
        diningSessionReference: "invalid",
      }),
    ).toThrow();
    expect(f.query).not.toHaveBeenCalled();
    const reader = createPostgresDiningCartCommandQueryStore(f.runner, {
      ...scope,
      diningSessionReference: id(40),
    });
    expect(await reader.load(id(90))).toBeNull();
  });
  it("reconstructs and freezes the accepted aggregate without inferring lifecycle or money", async () => {
    const f = fixture();
    const result = await f.reader.load(id(1));
    expect(result).toEqual(cart());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.items[0]?.optionSelections)).toBe(true);
    expect(result?.lifecycle).toBeNull();
  });
  it("copies trusted scope and binds parameters for every read", async () => {
    const f = fixture();
    const mutable = { ...scope };
    const reader = createPostgresCartQueryStore(f.runner, mutable);
    mutable.brandReference = id(90);
    mutable.storeReference = id(91);
    await reader.load(id(1));
    expect(f.query.mock.calls.map((call) => call[1])).toEqual([
      [id(2), id(3)],
      [id(2), id(3), id(1)],
    ]);
  });
  it("returns null only for an absent scoped row", async () => {
    expect(await fixture({ rows: [] }).reader.load(id(1))).toBeNull();
  });
  it("rejects invalid references before starting a transaction", async () => {
    const f = fixture();
    await expect(f.reader.load("untrusted")).rejects.toMatchObject({ code: "CART_INPUT_INVALID" });
    expect(f.query).not.toHaveBeenCalled();
    expect(() =>
      createPostgresCartQueryStore(f.runner, { ...scope, brandReference: "untrusted" }),
    ).toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { rows: null },
    { rows: [null] },
    { rows: [{ cart: {} }] },
    { rows: [{ cart: cart() }, { cart: cart() }] },
    { rows: [{ cart: { ...cart(), brandReference: id(90) } }] },
    { rows: [{ cart: { ...cart(), storeReference: id(90) } }] },
    { rows: [{ cart: { ...cart(), cartReference: id(90) } }] },
    { rows: [{ cart: { ...cart(), items: [{ ...cart().items[0], cartReference: id(90) }] } }] },
  ])("bounds malformed or mismatched driver results", async (result) => {
    await expect(fixture(result).reader.load(id(1))).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
  });
  it("does not disclose transaction faults", async () => {
    const reader = createPostgresCartQueryStore(
      {
        async run() {
          throw new Error("synthetic driver detail");
        },
      },
      scope,
    );
    const error = await reader.load(id(1)).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
    expect(error).not.toHaveProperty("cause");
  });
});
