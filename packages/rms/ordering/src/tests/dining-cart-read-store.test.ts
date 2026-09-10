import { describe, expect, it, vi } from "vitest";
import { createPostgresDiningCartReadStore } from "../infrastructure/persistence/dining-cart-read-store.js";
import type {
  CartQueryTransaction,
  CartQueryTransactionRunner,
} from "../infrastructure/persistence/cart-query-store.js";
const id = (n: number) => `018f2314-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T14:01:00.000Z";
const scope = { brandReference: id(1), storeReference: id(2) };
const input = { ...scope, diningSessionReference: id(3), observedAt: at as never };
const selected = { cartReference: id(4), aggregateVersion: 1 };
function cart() {
  return {
    cartReference: id(4),
    ...scope,
    orderType: "DineIn",
    sourceChannel: "Qr",
    diningSessionReference: id(3),
    createdByActorReference: id(5),
    aggregateVersion: 1,
    createdAt: "2026-08-02T14:00:00.000Z",
    updatedAt: "2026-08-02T14:00:00.000Z",
    items: [],
    lifecycle: {
      status: "Active",
      policyVersionReference: id(6),
      policyDigest: `sha256:${"a".repeat(64)}`,
      idleTimeoutSeconds: 3600,
      absoluteTimeoutSeconds: 86400,
      idleExpiresAt: "2026-08-02T15:00:00.000Z",
      absoluteExpiresAt: "2026-08-03T14:00:00.000Z",
      terminalAt: null,
      terminalReason: null,
    },
  };
}
function fixture(options: { first?: unknown; last?: unknown; loaded?: unknown } = {}) {
  let selection = 0;
  const query = vi.fn<CartQueryTransaction["query"]>(async (sql) => {
    if (sql.startsWith("SELECT set_config")) return { rows: [] };
    if (sql.includes('cart_id AS "cartReference"'))
      return ++selection === 1
        ? (options.first ?? { rows: [selected] })
        : (options.last ?? { rows: [selected] });
    return options.loaded ?? { rows: [{ cart: cart() }] };
  });
  const run = vi.fn();
  const runner: CartQueryTransactionRunner = {
    async run(action) {
      run();
      return action({ query });
    },
  };
  return { query, run, store: createPostgresDiningCartReadStore(runner, scope) };
}
describe("current shared Dining Cart PostgreSQL port", () => {
  it("uses one transaction and checks selection around immutable aggregate reconstruction", async () => {
    const f = fixture();
    const result = await f.store.current(input);
    expect(result).toEqual(cart());
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls.map((call) => call[1])).toEqual([
      [id(1), id(2)],
      [id(1), id(2), id(3), at],
      [id(1), id(2)],
      [id(1), id(2), id(4)],
      [id(1), id(2), id(3), at],
    ]);
    const sql = f.query.mock.calls[1]?.[0] ?? "";
    expect(sql).toContain("LIMIT 2");
    expect(sql).toContain("lifecycle_status = 'Active'");
    expect(sql).toContain("idle_expires_at > $4");
  });
  it("returns null only for no eligible current selection", async () => {
    const f = fixture({ first: { rows: [] } });
    expect(await f.store.current(input)).toBeNull();
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it.each([
    { rows: [selected, selected] },
    { rows: [{ ...selected, aggregateVersion: 0 }] },
    { rows: [{ ...selected, extra: true }] },
    { rows: "invalid" },
    { rows: [{ ...selected, cartReference: "invalid" }] },
  ])("rejects malformed or ambiguous first selection", async (first) => {
    const f = fixture({ first });
    await expect(f.store.current(input)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it.each([
    { rows: [] },
    { rows: [{ ...selected, cartReference: id(9) }] },
    { rows: [{ ...selected, aggregateVersion: 2 }] },
    { rows: [selected, selected] },
  ])("rejects disappearance, replacement or ambiguity after aggregate read", async (last) => {
    await expect(fixture({ last }).store.current(input)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
  });
  it.each([
    { aggregateVersion: 2 },
    { brandReference: id(9) },
    { storeReference: id(9) },
    { diningSessionReference: id(9) },
    { orderType: "Pickup" },
    { sourceChannel: "Pos" },
    { updatedAt: "2026-08-02T14:02:00.000Z" },
    { lifecycle: null },
  ])("rejects mismatched loaded aggregate", async (change) => {
    await expect(
      fixture({ loaded: { rows: [{ cart: { ...cart(), ...change } }] } }).store.current(input),
    ).rejects.toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
  });
  it("rejects effective expiry at the exact observation boundary", async () => {
    const f = fixture();
    await expect(
      f.store.current({ ...input, observedAt: "2026-08-02T15:00:00.000Z" as never }),
    ).rejects.toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
  });
  it.each([
    { ...input, brandReference: id(9) },
    { ...input, storeReference: id(9) },
    { ...input, diningSessionReference: "invalid" },
    { ...input, observedAt: "invalid" },
    { ...input, extra: true },
  ])("rejects input before entering the runner", async (value) => {
    const f = fixture();
    await expect(f.store.current(value as never)).rejects.toMatchObject({
      code: "CART_INPUT_INVALID",
    });
    expect(f.run).not.toHaveBeenCalled();
  });
  it("captures scope and input before transaction callbacks", async () => {
    const mutableScope = { ...scope };
    const mutableInput = { ...input };
    const f = fixture();
    const store = createPostgresDiningCartReadStore(
      {
        run: async (action) => {
          mutableInput.diningSessionReference = id(9);
          return action({ query: f.query });
        },
      },
      mutableScope,
    );
    mutableScope.storeReference = id(9);
    expect((await store.current(mutableInput))?.cartReference).toBe(id(4));
  });
  it("bounds database failures", async () => {
    const f = fixture();
    f.query.mockRejectedValue(new Error("private SQL details"));
    await expect(f.store.current(input)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
  });
});
