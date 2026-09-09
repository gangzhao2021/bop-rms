import { describe, expect, it, vi } from "vitest";
import {
  parseCartQuoteExpiryRecord,
  sameCartQuoteExpiryIntent,
} from "../domain/cart-quote-expiry.js";
import { createPostgresCartQuoteExpiryStore } from "../infrastructure/persistence/cart-quote-expiry-store.js";
const id = (n: number) => `01902263-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (s = 0) => new Date(Date.parse("2026-09-09T12:00:00.000Z") + s * 1000).toISOString();
const raw = () => ({
  resolutionVersion: 1,
  cartVersion: 2,
  operationReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  cartReference: id(4),
  guestSessionReference: id(5),
  quoteReference: id(6),
  quoteInputDigest: `sha256:${"a".repeat(64)}`,
  requestIntentDigest: `sha256:${"b".repeat(64)}`,
  quoteCreatedAt: at(),
  quoteExpiresAt: at(300),
  requestCreatedAt: at(1),
  requestExpiresAt: at(86401),
  expiredAt: at(300),
});
describe("immutable original Quote expiry record", () => {
  it("accepts the exact expiry boundary and owns its immutable copy", () => {
    const input = raw();
    const result = parseCartQuoteExpiryRecord(input);
    input.cartVersion = 3;
    expect(result.cartVersion).toBe(2);
    expect(Object.isFrozen(result)).toBe(true);
    expect(
      sameCartQuoteExpiryIntent(
        result,
        parseCartQuoteExpiryRecord({ ...raw(), expiredAt: at(301) }),
      ),
    ).toBe(true);
    expect(
      sameCartQuoteExpiryIntent(
        result,
        parseCartQuoteExpiryRecord({ ...raw(), quoteReference: id(7) }),
      ),
    ).toBe(false);
  });
  it.each([
    { resolutionVersion: 2 },
    { cartVersion: 0 },
    { cartVersion: 2147483648 },
    { cartVersion: 1.5 },
    { operationReference: "bad" },
    { quoteInputDigest: "bad" },
    { requestIntentDigest: "a".repeat(64) },
    { quoteCreatedAt: at(2) },
    { requestCreatedAt: at(300) },
    { expiredAt: at(299) },
    { requestExpiresAt: at(86400) },
    { expiredAt: "2026-09-09T12:05:00Z" },
    { unexpected: true },
  ])("denies malformed chronology or identity %j", (patch) => {
    expect(() => parseCartQuoteExpiryRecord({ ...raw(), ...patch })).toThrow(
      expect.objectContaining({ code: "CART_QUOTE_INVALID" }),
    );
  });
  it("rejects accessors and hidden properties without executing them", () => {
    const get = vi.fn();
    const input = raw();
    Object.defineProperty(input, "quoteReference", { get, enumerable: true });
    expect(() => parseCartQuoteExpiryRecord(input)).toThrow();
    expect(get).not.toHaveBeenCalled();
    expect(() => parseCartQuoteExpiryRecord(Object.create(raw()))).toThrow();
    expect(() =>
      parseCartQuoteExpiryRecord(Object.defineProperty(raw(), "extra", { value: 1 })),
    ).toThrow();
  });
  it("copies scope without IO and fails malformed writes before a transaction", async () => {
    const run = vi.fn();
    const scope = { brandReference: id(2), storeReference: id(3) };
    const store = createPostgresCartQuoteExpiryStore({ run }, scope);
    expect(run).not.toHaveBeenCalled();
    expect(Object.isFrozen(store)).toBe(true);
    await expect(
      store.expire({ record: parseCartQuoteExpiryRecord(raw()), audit: {} }),
    ).rejects.toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
    expect(run).not.toHaveBeenCalled();
  });
  it("reads only scoped original records and owns the hydrated result", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ record: raw() }] });
    const scope = { brandReference: id(2), storeReference: id(3) };
    const store = createPostgresCartQuoteExpiryStore(
      { run: async (action) => action({ query }) },
      scope,
    );
    scope.storeReference = id(99);
    expect(await store.resolveOperation(id(1))).toEqual(raw());
    expect(query.mock.calls[1]?.[1]).toEqual([id(2), id(3), id(1)]);
  });
  it.each(
    [
      [],
      [{ record: { ...raw(), storeReference: id(9) } }],
      [{ record: raw() }, { record: raw() }],
      [{ record: { ...raw(), operationReference: id(9) } }],
    ].map((rows) => ({ rows })),
  )("bounds empty or corrupt reads %j", async ({ rows }) => {
    const query = vi.fn().mockResolvedValue({ rows });
    const store = createPostgresCartQuoteExpiryStore(
      { run: async (action) => action({ query }) },
      { brandReference: id(2), storeReference: id(3) },
    );
    if (rows.length === 0) expect(await store.resolveOperation(id(1))).toBeNull();
    else
      await expect(store.resolveOperation(id(1))).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
  });
  it("redacts dependency errors", async () => {
    const run = vi.fn().mockRejectedValue(new Error("synthetic restricted payload"));
    await expect(
      createPostgresCartQuoteExpiryStore(
        { run },
        { brandReference: id(2), storeReference: id(3) },
      ).resolveOperation(id(1)),
    ).rejects.toMatchObject({
      message: "cart is unavailable",
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
  });
});
