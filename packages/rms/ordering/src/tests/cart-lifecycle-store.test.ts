import { describe, expect, it, vi } from "vitest";
import { createPostgresCartLifecycleStore } from "../infrastructure/persistence/cart-lifecycle-store.js";
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
