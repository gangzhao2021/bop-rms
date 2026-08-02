import { createEffectivePeriod } from "@bop/effective-period";

import {
  createCurrencyMetadataSnapshot,
  createMoney,
  parseCurrencyCode,
  parsePricingCode,
  parsePricingDigest,
  parsePricingReference,
  type CreatePriceQuoteInput,
  type PriceBookSnapshot,
  type TaxConfigurationSnapshot,
} from "../index.js";

const id = (n: number) =>
  parsePricingReference(`018fb000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = "2026-08-02T16:00:00.000Z";
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

function taxConfiguration(): TaxConfigurationSnapshot {
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
        priceInclusion: "Exclusive",
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

export function input(overrides: Partial<CreatePriceQuoteInput> = {}): CreatePriceQuoteInput {
  return {
    quoteReference: id(20),
    brandReference: id(3),
    storeReference: id(6),
    cartReference: id(21),
    cartVersion: 4,
    inputDigest: digest("e"),
    createdAt: at,
    expiresAt: "2026-08-02T16:05:00.000Z",
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
