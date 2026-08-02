import { createEffectivePeriod } from "@bop/effective-period";
import { describe, expect, it } from "vitest";

import {
  createCurrencyMetadataSnapshot,
  createMoney,
  createPriceQuote,
  parseCurrencyCode,
  parsePricingCode,
  parsePricingDigest,
  parsePricingReference,
  PriceQuoteError,
  type CreatePriceQuoteInput,
  type PriceBookSnapshot,
  type TaxConfigurationSnapshot,
} from "../index.js";

const id = (n: number) =>
  parsePricingReference(`018fb000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = "2026-08-02T16:00:00.000Z";
const expires = "2026-08-02T16:05:00.000Z";
const digest = (c: string) => parsePricingDigest(`sha256:${c.repeat(64)}`);
const currencyMetadata = createCurrencyMetadataSnapshot({
  currencyCode: parseCurrencyCode("CAD"),
  minorUnitExponent: 2,
  metadataVersion: 1,
  metadataVersionReference: id(90),
  metadataDigest: digest("d"),
});

function period() {
  return createEffectivePeriod({
    timeZone: "America/Toronto",
    effectiveFrom: {
      instant: "2026-08-01T04:00:00.000Z" as never,
      localDateTime: "2026-08-01T00:00:00.000",
      utcOffsetMinutes: -240,
    },
    effectiveUntil: null,
  });
}

function priceBook(): PriceBookSnapshot {
  return {
    priceBookReference: id(1),
    versionReference: id(2),
    brandReference: id(3),
    stableCode: parsePricingCode("CAD_BASE"),
    aggregateVersion: 1,
    versionNumber: 1,
    snapshotDigest: digest("a"),
    lifecycle: "Published",
    currencyMetadata,
    entries: [
      {
        entryReference: id(4),
        sellableReference: id(5),
        scopeKind: "Brand",
        scopeReference: null,
        channelCode: null,
        orderType: null,
        amount: createMoney({ amountMinor: 1000n, currencyCode: parseCurrencyCode("CAD") }),
        effectivePeriod: period(),
        reasonCode: parsePricingCode("SYNTHETIC_BASE"),
      },
    ],
    createdAt: at,
  };
}

function taxConfiguration(
  priceInclusion: "Exclusive" | "Inclusive" = "Exclusive",
): TaxConfigurationSnapshot {
  return {
    configurationReference: id(10),
    versionReference: id(11),
    brandReference: id(3),
    storeReference: id(6),
    stableCode: parsePricingCode("PILOT_STORE_TAX"),
    aggregateVersion: 1,
    versionNumber: 1,
    snapshotDigest: digest("b"),
    lifecycle: "Published",
    jurisdictionCode: parsePricingCode("CA-ON"),
    currencyMetadata,
    effectivePeriod: period(),
    registrationEvidence: {
      applicabilityReference: id(12),
      operatingEntityTaxReference: id(13),
      jurisdictionProfileReference: id(14),
      status: "Verified",
      validUntil: "2026-09-01T16:00:00.000Z",
    },
    professionalEvidence: {
      evidenceReference: id(15),
      snapshotReference: id(11),
      snapshotDigest: digest("b"),
      professionalReviewReference: id(16),
      fixtureSuiteReference: id(17),
      fixtureSuiteDigest: digest("c"),
      result: "Pass",
      reviewedAt: "2026-08-01T16:00:00.000Z",
      validUntil: "2026-09-01T16:00:00.000Z",
    },
    rules: [
      {
        ruleReference: id(18),
        taxClassificationReference: id(19),
        orderType: "Pickup",
        chargeType: "Sellable",
        taxComponentCode: parsePricingCode("SYNTHETIC_TAX"),
        treatment: "Taxable",
        rate: "0.13" as never,
        priceInclusion,
        roundingMode: "HalfUp",
        calculationOrder: 1,
        compoundOnPriorTax: false,
        exceptionEvidenceReference: null,
        receiptPresentationCode: parsePricingCode("SYNTHETIC_TAX_LINE"),
      },
    ],
    createdAt: at,
  };
}

function input(overrides: Partial<CreatePriceQuoteInput> = {}): CreatePriceQuoteInput {
  return {
    quoteReference: id(20),
    brandReference: id(3),
    storeReference: id(6),
    cartReference: id(21),
    cartVersion: 4,
    inputDigest: digest("e"),
    createdAt: at,
    expiresAt: expires,
    currencyMetadata,
    priceBook: priceBook(),
    taxConfiguration: taxConfiguration(),
    lines: [
      {
        lineReference: id(22),
        sellableReference: id(5),
        productVersionReference: id(23),
        menuVersionReference: id(24),
        quantity: 2,
        priceContext: {
          brandReference: id(3),
          storeReference: id(6),
          storeGroupReference: null,
          regionReference: null,
          sellableReference: id(5),
          channelCode: parsePricingCode("CUSTOMER_WEB"),
          orderType: "Pickup",
          currencyCode: "CAD",
          evaluatedAt: at,
        },
        taxContext: {
          brandReference: id(3),
          storeReference: id(6),
          jurisdictionCode: parsePricingCode("CA-ON"),
          currencyCode: "CAD",
          taxClassificationReference: id(19),
          orderType: "Pickup",
          chargeType: "Sellable",
          evaluatedAt: at,
        },
      },
    ],
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected error");
  } catch (error) {
    expect(error).toBeInstanceOf(PriceQuoteError);
    expect((error as PriceQuoteError).code).toBe(code);
  }
}

function firstLine() {
  const line = input().lines[0];
  if (line === undefined) throw new Error("quote fixture requires one line");
  return line;
}

describe("Price Quote creation", () => {
  it("creates a replayable single-Currency quote snapshot", () => {
    const quote = createPriceQuote(input());
    expect(quote.subtotal.amountMinor).toBe(2000n);
    expect(quote.tax.amountMinor).toBe(260n);
    expect(quote.total.amountMinor).toBe(2260n);
    expect(quote.discount.amountMinor).toBe(0n);
    expect(quote.fee.amountMinor).toBe(0n);
    expect(quote.lines[0]?.resolvedPrice.versionReference).toBe(id(2));
    expect(quote.lines[0]?.taxResolution.versionReference).toBe(id(11));
  });

  it("pins Cart, Catalog, Price, Tax and input digest evidence", () => {
    const quote = createPriceQuote(input());
    expect(quote.cartVersion).toBe(4);
    expect(quote.inputDigest).toBe(digest("e"));
    expect(quote.lines[0]?.productVersionReference).toBe(id(23));
    expect(quote.lines[0]?.menuVersionReference).toBe(id(24));
  });

  it("rejects empty lines, duplicate lines, bad quantity and invalid expiry", () => {
    expectCode(() => createPriceQuote(input({ lines: [] })), "QUOTE_INPUT_INVALID");
    const line = firstLine();
    expectCode(() => createPriceQuote(input({ lines: [line, line] })), "QUOTE_INPUT_INVALID");
    expectCode(
      () => createPriceQuote(input({ lines: [{ ...line, quantity: 0 }] })),
      "QUOTE_INPUT_INVALID",
    );
    expectCode(() => createPriceQuote(input({ expiresAt: at })), "QUOTE_INPUT_INVALID");
  });

  it("rejects client/context scope or Currency substitution", () => {
    const line = firstLine();
    expectCode(
      () =>
        createPriceQuote(
          input({
            lines: [{ ...line, priceContext: { ...line.priceContext, storeReference: id(99) } }],
          }),
        ),
      "QUOTE_SCOPE_MISMATCH",
    );
    expectCode(
      () =>
        createPriceQuote(
          input({
            lines: [{ ...line, priceContext: { ...line.priceContext, currencyCode: "USD" } }],
          }),
        ),
      "QUOTE_SCOPE_MISMATCH",
    );
  });

  it("fails closed when authoritative Price coverage is missing", () => {
    const line = firstLine();
    expectCode(
      () =>
        createPriceQuote(
          input({
            lines: [
              {
                ...line,
                sellableReference: id(99),
                priceContext: { ...line.priceContext, sellableReference: id(99) },
              },
            ],
          }),
        ),
      "QUOTE_CALCULATION_FAILED",
    );
  });

  it("keeps the WP-1103 Pilot path explicitly exclusive-tax", () => {
    expectCode(
      () => createPriceQuote(input({ taxConfiguration: taxConfiguration("Inclusive") })),
      "QUOTE_UNSUPPORTED_TAX_MODE",
    );
  });

  it("does not invent Promotion, Fee, warnings or blockers", () => {
    const quote = createPriceQuote(input());
    expect(quote.appliedPromotionReferences).toEqual([]);
    expect(quote.warnings).toEqual([]);
    expect(quote.blockingReasons).toEqual([]);
  });

  it("rejects open input fields", () => {
    expectCode(
      () => createPriceQuote({ ...input(), clientTotal: "0.01" } as never),
      "QUOTE_INPUT_INVALID",
    );
  });
});
