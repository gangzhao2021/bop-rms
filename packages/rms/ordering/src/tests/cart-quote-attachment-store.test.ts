import { describe, expect, it, vi } from "vitest";
import { parseOrderingReference } from "../domain/cart.js";
import { createPostgresCartQuoteAttachmentStore } from "../infrastructure/persistence/cart-quote-attachment-store.js";
import type { CustomerCartDatabaseTransaction } from "../infrastructure/persistence/customer-cart-store.js";

const id = (n: number) =>
  parseOrderingReference(`018f5100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const make = (query: CustomerCartDatabaseTransaction["query"]) =>
  createPostgresCartQuoteAttachmentStore({
    brandReference: id(2),
    storeReference: id(3),
    runner: { run: (action) => action({ query }) },
  });

describe("Cart quote attachment persistence boundary", () => {
  it("locks the scoped Cart before reading Items and returns missing without further queries", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    expect(await make(query).loadCart(id(1))).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE"), [
      id(2),
      id(3),
      id(1),
    ]);
  });
  it("scopes operation lookup and validates identifiers before SQL", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const store = make(query);
    expect(await store.resolveOperation(id(4))).toBeNull();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("q.subtotal_minor::text"), [
      id(2),
      id(3),
      id(4),
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("cart_quote_attachment"), [
      id(2),
      id(3),
      id(4),
    ]);
    query.mockClear();
    await expect(store.resolveOperation("invalid" as ReturnType<typeof id>)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(query).not.toHaveBeenCalled();
  });
  it.each([null, { rows: null }, { rows: [null] }, { rows: [{ record: {} }] }])(
    "rejects malformed repository output without exposing values",
    async (value) => {
      await expect(make(async () => value).resolveOperation(id(4))).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it("removes database diagnostic text and causes", async () => {
    const store = make(async () => {
      throw new Error("synthetic-private-driver-detail");
    });
    let failure: unknown;
    try {
      await store.loadCart(id(1));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
    expect(String(failure)).not.toContain("synthetic-private-driver-detail");
    expect(failure).not.toHaveProperty("cause");
  });
});
