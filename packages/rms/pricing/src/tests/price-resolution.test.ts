import { createEffectivePeriod } from "@bop/effective-period";
import { describe, expect, it } from "vitest";

import {
  createCurrencyMetadataSnapshot,
  createMoney,
  createPriceBookSnapshot,
  parseCurrencyCode,
  parsePricingCode,
  parsePricingDigest,
  parsePricingReference,
  PriceResolutionError,
  resolvePrice,
  validatePriceCoverage,
  type PriceBookSnapshot,
  type PriceEntry,
} from "../index.js";

const id = (value: number) =>
  parsePricingReference(`018f9000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`);
const at = "2026-08-02T16:00:00.000Z";
const digest = parsePricingDigest(`sha256:${"a".repeat(64)}`);
const channel = parsePricingCode("CUSTOMER_WEB");

function period(from = "2026-08-01T04:00:00.000Z", until: string | null = null) {
  return createEffectivePeriod({
    timeZone: "America/Toronto",
    effectiveFrom: {
      instant: from as never,
      localDateTime:
        from === "2026-08-01T04:00:00.000Z" ? "2026-08-01T00:00:00.000" : "2026-09-01T00:00:00.000",
      utcOffsetMinutes: -240,
    },
    effectiveUntil:
      until === null
        ? null
        : {
            instant: until as never,
            localDateTime: "2026-09-01T00:00:00.000",
            utcOffsetMinutes: -240,
          },
  });
}

function entry(value: number, overrides: Partial<PriceEntry> = {}): PriceEntry {
  return {
    entryReference: id(value),
    sellableReference: id(20),
    scopeKind: "Brand",
    scopeReference: null,
    channelCode: null,
    orderType: null,
    amount: createMoney({
      amountMinor: BigInt(value * 100),
      currencyCode: parseCurrencyCode("CAD"),
    }),
    effectivePeriod: period(),
    reasonCode: parsePricingCode("SYNTHETIC_BASE"),
    ...overrides,
  };
}

function snapshot(overrides: Partial<PriceBookSnapshot> = {}): PriceBookSnapshot {
  return {
    priceBookReference: id(1),
    versionReference: id(2),
    brandReference: id(3),
    stableCode: parsePricingCode("CAD_BASE"),
    aggregateVersion: 1,
    versionNumber: 1,
    snapshotDigest: digest,
    lifecycle: "Published",
    currencyMetadata: createCurrencyMetadataSnapshot({
      currencyCode: parseCurrencyCode("CAD"),
      minorUnitExponent: 2,
      metadataVersion: 1,
      metadataVersionReference: id(4),
      metadataDigest: parsePricingDigest(`sha256:${"b".repeat(64)}`),
    }),
    entries: [entry(10)],
    createdAt: at,
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    brandReference: id(3),
    storeReference: id(5),
    storeGroupReference: id(6),
    regionReference: id(7),
    sellableReference: id(20),
    channelCode: channel,
    orderType: "Pickup" as const,
    currencyCode: "CAD",
    evaluatedAt: at,
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected error");
  } catch (error) {
    expect(error).toBeInstanceOf(PriceResolutionError);
    expect((error as PriceResolutionError).code).toBe(code);
  }
}

describe("Price Book resolution", () => {
  it("creates a version-pinned single-currency published snapshot", () => {
    const value = createPriceBookSnapshot(snapshot());
    expect(value.lifecycle).toBe("Published");
    expect(value.currencyMetadata.currencyCode).toBe("CAD");
  });

  it("allows an empty Draft but blocks empty Published", () => {
    expect(createPriceBookSnapshot(snapshot({ lifecycle: "Draft", entries: [] })).entries).toEqual(
      [],
    );
    expectCode(() => createPriceBookSnapshot(snapshot({ entries: [] })), "PRICE_COVERAGE_MISSING");
  });

  it("rejects negative or cross-currency entries", () => {
    expectCode(
      () =>
        createPriceBookSnapshot(
          snapshot({
            entries: [
              entry(10, {
                amount: createMoney({ amountMinor: -1n, currencyCode: parseCurrencyCode("CAD") }),
              }),
            ],
          }),
        ),
      "PRICE_SCOPE_MISMATCH",
    );
    expectCode(
      () =>
        createPriceBookSnapshot(
          snapshot({
            entries: [
              entry(10, {
                amount: createMoney({ amountMinor: 1n, currencyCode: parseCurrencyCode("USD") }),
              }),
            ],
          }),
        ),
      "PRICE_SCOPE_MISMATCH",
    );
  });

  it("requires Brand scope to omit a reference and overlays to provide one", () => {
    expectCode(
      () => createPriceBookSnapshot(snapshot({ entries: [entry(10, { scopeReference: id(5) })] })),
      "PRICE_INPUT_INVALID",
    );
    expectCode(
      () =>
        createPriceBookSnapshot(
          snapshot({ entries: [entry(10, { scopeKind: "Store", scopeReference: null })] }),
        ),
      "PRICE_INPUT_INVALID",
    );
  });

  it("rejects overlapping identical resolution identities", () => {
    expectCode(
      () => createPriceBookSnapshot(snapshot({ entries: [entry(10), entry(11)] })),
      "PRICE_ENTRY_CONFLICT",
    );
  });

  it("allows adjacent effective periods", () => {
    const first = entry(10, {
      effectivePeriod: period("2026-08-01T04:00:00.000Z", "2026-09-01T04:00:00.000Z"),
    });
    const second = entry(11, { effectivePeriod: period("2026-09-01T04:00:00.000Z") });
    expect(createPriceBookSnapshot(snapshot({ entries: [first, second] })).entries).toHaveLength(2);
  });

  it("resolves the exact canonical eight-level priority", () => {
    const entries = [
      entry(80),
      entry(70, { channelCode: channel }),
      entry(60, { scopeKind: "Region", scopeReference: id(7) }),
      entry(50, { scopeKind: "Region", scopeReference: id(7), orderType: "Pickup" }),
      entry(40, { scopeKind: "StoreGroup", scopeReference: id(6) }),
      entry(30, { scopeKind: "StoreGroup", scopeReference: id(6), channelCode: channel }),
      entry(20, { scopeKind: "Store", scopeReference: id(5) }),
      entry(10, { scopeKind: "Store", scopeReference: id(5), channelCode: channel }),
    ];
    const value = resolvePrice(snapshot({ entries }), context());
    expect(value.priority).toBe(1);
    expect(value.entryReference).toBe(id(10));
    expect(value.amount.amountMinor).toBe(1000n);
  });

  it("falls back from Store to Brand default", () => {
    const value = resolvePrice(snapshot(), context());
    expect(value.priority).toBe(8);
    expect(value.scopeKind).toBe("Brand");
  });

  it("treats effective period only as eligibility", () => {
    const futureStore = entry(11, {
      scopeKind: "Store",
      scopeReference: id(5),
      effectivePeriod: period("2026-09-01T04:00:00.000Z"),
    });
    expect(resolvePrice(snapshot({ entries: [entry(10), futureStore] }), context()).priority).toBe(
      8,
    );
  });

  it("fails closed on two matches at one priority", () => {
    const entries = [
      entry(10, { channelCode: channel }),
      entry(11, { orderType: "Pickup", reasonCode: parsePricingCode("SYNTHETIC_SECOND") }),
    ];
    expectCode(() => resolvePrice(snapshot({ entries }), context()), "PRICE_ENTRY_CONFLICT");
  });

  it("fails closed for missing coverage", () => {
    expectCode(
      () => resolvePrice(snapshot(), context({ sellableReference: id(99) })),
      "PRICE_COVERAGE_MISSING",
    );
  });

  it("rejects Draft, wrong Brand and wrong Currency", () => {
    expectCode(
      () => resolvePrice(snapshot({ lifecycle: "Draft" }), context()),
      "PRICE_BOOK_NOT_PUBLISHED",
    );
    expectCode(
      () => resolvePrice(snapshot(), context({ brandReference: id(99) })),
      "PRICE_SCOPE_MISMATCH",
    );
    expectCode(
      () => resolvePrice(snapshot(), context({ currencyCode: "USD" })),
      "PRICE_SCOPE_MISMATCH",
    );
  });

  it("validates an explicit publish coverage matrix", () => {
    expect(() => validatePriceCoverage(snapshot(), [context()])).not.toThrow();
    expectCode(() => validatePriceCoverage(snapshot(), []), "PRICE_COVERAGE_MISSING");
  });

  it("returns replay evidence without consulting mutable state", () => {
    const value = resolvePrice(snapshot(), context());
    expect(value.versionReference).toBe(id(2));
    expect(value.snapshotDigest).toBe(digest);
    expect(value.reasonCode).toBe("SYNTHETIC_BASE");
  });

  it("rejects extra input fields", () => {
    expectCode(
      () => createPriceBookSnapshot({ ...snapshot(), providerRate: 1 } as never),
      "PRICE_INPUT_INVALID",
    );
  });
});
