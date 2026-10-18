import { describe, expect, it, vi } from "vitest";
import {
  createPostgresCartLifecycleStore,
  createPostgresDueCartSource,
} from "../infrastructure/persistence/cart-lifecycle-store.js";
const id = (n: number) => `018f5600-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = { brandReference: id(2), storeReference: id(3) };
const references = { hashIntent: () => "invalid", equals: (a: string, b: string) => a === b };
describe("Cart lifecycle persistence boundary", () => {
  it("rejects invalid scope before opening a transaction", () => {
    const run = vi.fn();
    expect(() =>
      createPostgresCartLifecycleStore(
        { run },
        { ...scope, storeReference: "invalid" },
        references,
      ),
    ).toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { record: {} },
    { record: {}, audit: {}, expectedAggregateVersion: 1 },
    { record: {}, audit: {}, expectedAggregateVersion: 1, secret: "synthetic" },
  ])("rejects malformed commits before SQL", async (input) => {
    const run = vi.fn();
    const writer = createPostgresCartLifecycleStore({ run }, scope, references);
    const error = await writer.commit(input as never).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
    expect(error).not.toHaveProperty("cause");
    expect(run).not.toHaveBeenCalled();
  });
  it.each([null, { rows: [{}] }, { rows: [{}, {}] }, { rows: "invalid" }])(
    "bounds malformed reader results",
    async (response) => {
      const query = vi.fn().mockResolvedValue(response);
      const reader = createPostgresCartLifecycleStore(
        { run: async (action) => action({ query }) },
        scope,
        references,
      );
      await expect(reader.resolveOperation(id(1))).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it("returns null for a missing operation and applies exact scope", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const reader = createPostgresCartLifecycleStore(
      { run: async (action) => action({ query }) },
      scope,
      references,
    );
    expect(await reader.resolveOperation(id(1))).toBeNull();
    expect(query.mock.calls[0]?.[1]).toEqual([id(2), id(3)]);
    expect(query.mock.calls[1]?.[1]).toEqual([id(2), id(3), id(1)]);
  });
  it("hides driver payloads", async () => {
    const run = vi.fn().mockRejectedValue(new Error("synthetic restricted database payload"));
    const reader = createPostgresCartLifecycleStore({ run }, scope, references);
    const error = await reader.resolveOperation(id(1)).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
    expect(error).not.toHaveProperty("cause");
  });
});

describe("Due Cart discovery", () => {
  const at = "2026-09-20T12:00:00.000Z";
  it("selects a bounded scoped page without locks or mutation", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ cartReference: id(5), expectedAggregateVersion: 3 }] });
    const source = createPostgresDueCartSource({ run: async (work) => work({ query }) }, scope);
    const result = await source.discover({ evaluatedAt: at, limit: 2, after: id(4) });
    expect(result).toEqual([{ cartReference: id(5), expectedAggregateVersion: 3 }]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(query.mock.calls[0]?.[1]).toEqual([scope.brandReference, scope.storeReference]);
    expect(query.mock.calls[1]?.[1]).toEqual([
      scope.brandReference,
      scope.storeReference,
      at,
      id(4),
      2,
    ]);
    const sql = query.mock.calls[1]?.[0];
    expect(sql).toContain("lifecycle_status='Active'");
    expect(sql).toContain(
      "idle_expires_at <= $3::timestamptz OR absolute_expires_at <= $3::timestamptz",
    );
    expect(sql).toContain("cart_id > $4::uuid");
    expect(sql).toContain("ORDER BY cart_id LIMIT $5");
    expect(sql).not.toMatch(/FOR UPDATE|INSERT|DELETE/);
  });
  it.each([0, 101, 1.5, NaN])("rejects invalid page size before SQL", async (limit) => {
    const run = vi.fn();
    await expect(
      createPostgresDueCartSource({ run }, scope).discover({ evaluatedAt: at, limit, after: null }),
    ).rejects.toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
    expect(run).not.toHaveBeenCalled();
  });
  it.each(
    [
      [{ cartReference: id(4), expectedAggregateVersion: 1 }],
      [
        { cartReference: id(5), expectedAggregateVersion: 1 },
        { cartReference: id(5), expectedAggregateVersion: 2 },
      ],
      [{ cartReference: id(5), expectedAggregateVersion: 0 }],
      [{ cartReference: id(5), expectedAggregateVersion: 2147483647 }],
      [{ cartReference: id(5), expectedAggregateVersion: 1, extra: "restricted" }],
    ].map((rows) => ({ rows })),
  )("rejects invalid or non-monotonic candidates", async ({ rows }) => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows });
    await expect(
      createPostgresDueCartSource({ run: async (work) => work({ query }) }, scope).discover({
        evaluatedAt: at,
        limit: 2,
        after: id(4),
      }),
    ).rejects.toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
  });
  it("bounds driver errors without exposing their payload", async () => {
    const run = vi.fn().mockRejectedValue(new Error("restricted driver details"));
    const error = await createPostgresDueCartSource({ run }, scope)
      .discover({ evaluatedAt: at, limit: 1, after: null })
      .catch((value) => value);
    expect(error).toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
    expect(error).not.toHaveProperty("cause");
  });
});
