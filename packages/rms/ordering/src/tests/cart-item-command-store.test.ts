import { describe, expect, it, vi } from "vitest";
import { createPostgresCartItemCommandStore } from "../infrastructure/persistence/cart-item-command-store.js";
const id = (n: number) => `018f5000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const references = { hashIntent: () => "invalid", equals: (a: string, b: string) => a === b };
describe("Cart Item writer boundary", () => {
  it("rejects invalid construction scope without starting a transaction", () => {
    const run = vi.fn();
    expect(() =>
      createPostgresCartItemCommandStore(
        { run },
        { brandReference: "invalid", storeReference: id(3) },
        references,
      ),
    ).toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it.each([null, {}, { record: {} }, { record: { result: {} } }])(
    "bounds malformed commit input before SQL",
    async (input) => {
      const run = vi.fn();
      const writer = createPostgresCartItemCommandStore(
        { run },
        { brandReference: id(2), storeReference: id(3) },
        references,
      );
      const error = await writer.commit(input as never).catch((value: unknown) => value);
      expect(error).toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
        message: "cart is unavailable",
      });
      expect(error).not.toHaveProperty("cause");
      expect(run).not.toHaveBeenCalled();
    },
  );
});
