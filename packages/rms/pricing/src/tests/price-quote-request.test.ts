import { describe, expect, it, vi } from "vitest";
import {
  assertPriceQuoteRequestReplay,
  parsePriceQuoteRequestIdentity,
  parsePriceQuoteRequestRecord,
  priceQuoteRequestIntent,
  PriceQuoteRequestError,
} from "../index.js";
const id = (n: number) => `01902000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const identity = () =>
  parsePriceQuoteRequestIdentity({
    operationReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    guestSessionReference: id(4),
    cartReference: id(5),
    cartVersion: 7,
  });
const record = () =>
  parsePriceQuoteRequestRecord({
    ...identity(),
    recordVersion: 1,
    intentDigest: `sha256:${"a".repeat(64)}`,
    quoteReference: id(6),
    quoteOutcome: "Created",
    createdAt: "2026-09-09T12:00:00.000Z",
    idempotencyExpiresAt: "2026-09-10T12:00:00.000Z",
  });
describe("immutable Quote request identity and replay window", () => {
  it("owns canonical identity independent of property order", () => {
    const value = identity();
    expect(Object.isFrozen(value)).toBe(true);
    const reversed = Object.fromEntries(Object.entries(value).reverse());
    expect(priceQuoteRequestIntent(reversed)).toBe(priceQuoteRequestIntent(value));
    expect(priceQuoteRequestIntent(value)).not.toContain("observedAt");
    expect(Object.isFrozen(record())).toBe(true);
  });
  it("accepts only the original identity before the exact 24-hour boundary", () => {
    expect(() =>
      assertPriceQuoteRequestReplay(record(), identity(), "2026-09-09T12:00:00.000Z"),
    ).not.toThrow();
    expect(() =>
      assertPriceQuoteRequestReplay(record(), identity(), "2026-09-10T11:59:59.999Z"),
    ).not.toThrow();
    expect(() =>
      assertPriceQuoteRequestReplay(record(), identity(), "2026-09-10T12:00:00.000Z"),
    ).toThrow(PriceQuoteRequestError);
    expect(() =>
      assertPriceQuoteRequestReplay(record(), identity(), "2026-09-09T11:59:59.999Z"),
    ).toThrow(PriceQuoteRequestError);
  });
  it.each([
    "operationReference",
    "brandReference",
    "storeReference",
    "guestSessionReference",
    "cartReference",
    "cartVersion",
  ])("rejects changed %s", (key) => {
    const changed = { ...identity(), [key]: key === "cartVersion" ? 8 : id(99) };
    expect(() =>
      assertPriceQuoteRequestReplay(record(), changed, "2026-09-09T12:00:01.000Z"),
    ).toThrow(PriceQuoteRequestError);
    expect(priceQuoteRequestIntent(changed)).not.toBe(priceQuoteRequestIntent(identity()));
  });
  it.each([0, -1, 1.5, 2147483648, Number.NaN])(
    "rejects unpersistable Cart version %s",
    (cartVersion) => {
      expect(() => parsePriceQuoteRequestIdentity({ ...identity(), cartVersion })).toThrow(
        PriceQuoteRequestError,
      );
    },
  );
  it.each([
    ["recordVersion", 2],
    ["quoteOutcome", "Repriced"],
    ["intentDigest", "bad"],
    ["createdAt", "2026-02-30T12:00:00.000Z"],
    ["idempotencyExpiresAt", "2026-09-10T12:00:00.001Z"],
  ])("rejects malformed record %s", (key, value) => {
    expect(() => parsePriceQuoteRequestRecord({ ...record(), [key as string]: value })).toThrow(
      PriceQuoteRequestError,
    );
  });
  it("rejects accessors, symbols, hidden or extra fields without evaluating them", () => {
    const get = vi.fn(() => id(1));
    expect(() =>
      parsePriceQuoteRequestIdentity({
        ...identity(),
        get operationReference() {
          return get();
        },
      }),
    ).toThrow(PriceQuoteRequestError);
    expect(() =>
      parsePriceQuoteRequestIdentity({ ...identity(), [Symbol("extra")]: true }),
    ).toThrow(PriceQuoteRequestError);
    const hidden = { ...record() };
    Object.defineProperty(hidden, "extra", { value: true });
    expect(() => parsePriceQuoteRequestRecord(hidden)).toThrow(PriceQuoteRequestError);
    expect(() =>
      parsePriceQuoteRequestIdentity({ ...identity(), observedAt: "2026-09-09T12:00:00.000Z" }),
    ).toThrow(PriceQuoteRequestError);
    expect(get).not.toHaveBeenCalled();
  });
});
