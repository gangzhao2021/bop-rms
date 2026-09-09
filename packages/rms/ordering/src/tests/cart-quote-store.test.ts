import { describe, expect, it, vi } from "vitest";
import { createPostgresCartQuoteStore } from "../infrastructure/persistence/cart-quote-store.js";
const id = (n: number) => `018f5700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = { brandReference: id(2), storeReference: id(3) };
const references = { hashIntent: () => "invalid", equals: (a: string, b: string) => a === b };
function attachment() {
  const money = (amountMinor: unknown) => ({ amountMinor, currencyCode: "CAD" });
  return {
    ...scope,
    operationReference: id(1),
    operationIntentHash: `sha256:${"a".repeat(64)}`,
    guestSessionReference: id(5),
    cartReference: id(4),
    cartVersion: 1,
    quoteReference: id(6),
    quoteVersion: 1,
    quoteInputDigest: `sha256:${"b".repeat(64)}`,
    currencyCode: "CAD",
    currencyMetadataVersion: 1,
    currencyMetadataVersionReference: id(7),
    subtotal: money("9007199254740993"),
    discount: money("0"),
    tax: money("0"),
    fee: money("0"),
    total: money("9007199254740993"),
    lines: [
      {
        lineReference: id(8),
        sellableReference: id(9),
        productVersionReference: id(10),
        menuVersionReference: id(11),
        quantity: 1,
      },
    ],
    warnings: [],
    quoteCreatedAt: "2026-09-08T12:00:00.000Z",
    quoteExpiresAt: "2026-09-08T12:05:00.000Z",
    attachedAt: "2026-09-08T12:00:00.000Z",
    idempotencyExpiresAt: "2026-09-09T12:00:00.000Z",
  };
}
function reader(value: unknown, lineCount = 1) {
  const query = vi.fn().mockResolvedValue({ rows: [{ attachment: value, lineCount }] });
  return createPostgresCartQuoteStore(
    { run: async (action) => action({ query }) },
    scope,
    references,
  );
}
describe("Cart Quote persistence boundary", () => {
  it("hydrates bigint amounts above Number's exact integer range", async () => {
    const result = await reader(attachment()).resolveOperation(id(1));
    expect(result?.total.amountMinor).toBe(9007199254740993n);
  });
  it.each(["01", "-1", "1.0", "1e3", "9223372036854775808", 9007199254740992])(
    "denies noncanonical or unsafe money %s",
    async (value) => {
      const raw = attachment();
      raw.total.amountMinor = value;
      await expect(reader(raw).resolveOperation(id(1))).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it.each(["scope", "operation", "count", "extra"])(
    "denies substituted reader %s",
    async (kind) => {
      let raw: unknown = attachment();
      if (kind === "scope") raw = { ...attachment(), storeReference: id(99) };
      if (kind === "operation") raw = { ...attachment(), operationReference: id(99) };
      if (kind === "extra") raw = { ...attachment(), secret: "synthetic" };
      await expect(reader(raw, kind === "count" ? 2 : 1).resolveOperation(id(1))).rejects.toThrow();
    },
  );
  it.each([null, {}, { attachment: {} }, { attachment: {}, expectedCartVersion: 1, audit: {} }])(
    "rejects malformed attach before SQL",
    async (input) => {
      const run = vi.fn();
      const store = createPostgresCartQuoteStore({ run }, scope, references);
      const error = await store.attach(input as never).catch((value: unknown) => value);
      expect(error).toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
        message: "cart is unavailable",
      });
      expect(error).not.toHaveProperty("cause");
      expect(run).not.toHaveBeenCalled();
    },
  );
  it("bounds driver failure", async () => {
    const run = vi.fn().mockRejectedValue(new Error("synthetic restricted driver payload"));
    const error = await createPostgresCartQuoteStore({ run }, scope, references)
      .resolveOperation(id(1))
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
    expect(error).not.toHaveProperty("cause");
  });
});
