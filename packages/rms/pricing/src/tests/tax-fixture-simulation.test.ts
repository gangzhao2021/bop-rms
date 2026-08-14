import { createEffectivePeriod } from "@bop/effective-period";
import { describe, expect, it } from "vitest";
import {
  createCurrencyMetadataSnapshot,
  parsePricingDigest,
  parsePricingReference,
  simulateApprovedTaxFixture,
  TaxFixtureSimulationError,
  type TaxConfigurationSnapshot,
} from "../index.js";

const id = (n: number) =>
  parsePricingReference(`018f9100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const digest = (c: string) => parsePricingDigest(`sha256:${c.repeat(64)}`);
const evaluatedAt = "2026-08-13T16:00:00.000Z";

function snapshot(): TaxConfigurationSnapshot {
  const versionReference = id(2);
  const snapshotDigest = digest("a");
  return {
    configurationReference: id(1),
    versionReference,
    brandReference: id(3),
    storeReference: id(4),
    stableCode: "PILOT_STORE_TAX" as never,
    aggregateVersion: 2,
    versionNumber: 2,
    snapshotDigest,
    lifecycle: "Published",
    jurisdictionCode: "CA-ON" as never,
    currencyMetadata: createCurrencyMetadataSnapshot({
      currencyCode: "CAD" as never,
      minorUnitExponent: 2,
      metadataVersion: 1,
      metadataVersionReference: id(5),
      metadataDigest: digest("b"),
    }),
    effectivePeriod: createEffectivePeriod({
      timeZone: "America/Toronto",
      effectiveFrom: {
        instant: "2026-08-01T04:00:00.000Z" as never,
        localDateTime: "2026-08-01T00:00:00.000",
        utcOffsetMinutes: -240,
      },
      effectiveUntil: {
        instant: "2026-09-01T04:00:00.000Z" as never,
        localDateTime: "2026-09-01T00:00:00.000",
        utcOffsetMinutes: -240,
      },
    }),
    registrationEvidence: {
      applicabilityReference: id(6),
      operatingEntityTaxReference: id(7),
      jurisdictionProfileReference: id(8),
      status: "Verified",
      validUntil: "2026-10-01T04:00:00.000Z",
    },
    professionalEvidence: {
      evidenceReference: id(9),
      snapshotReference: versionReference,
      snapshotDigest,
      professionalReviewReference: id(10),
      fixtureSuiteReference: id(11),
      fixtureSuiteDigest: digest("c"),
      result: "Pass",
      reviewedAt: "2026-07-31T14:00:00.000Z",
      validUntil: "2026-10-01T04:00:00.000Z",
    },
    rules: [
      {
        ruleReference: id(12),
        taxClassificationReference: id(13),
        orderType: "Pickup",
        chargeType: "Sellable",
        taxComponentCode: "SYNTHETIC_COMPONENT" as never,
        treatment: "Taxable",
        rate: "0.13" as never,
        priceInclusion: "Exclusive",
        roundingMode: "HalfUp",
        calculationOrder: 1,
        compoundOnPriorTax: false,
        exceptionEvidenceReference: null,
        receiptPresentationCode: "SYNTHETIC_TAX" as never,
      },
    ],
    createdAt: evaluatedAt,
  };
}

const fixture = (kind: "Basket" | "Refund", amountMinor: string) => ({
  fixtureReference: id(20),
  fixtureSuiteReference: id(11),
  fixtureSuiteDigest: digest("c"),
  kind,
  evaluatedAt,
  lines: [
    {
      lineReference: id(21),
      calculationReferences: [id(22)],
      labelCode: "SYNTHETIC_LINE",
      taxClassificationReference: id(13),
      orderType: "Pickup" as const,
      chargeType: "Sellable" as const,
      amountMinor,
    },
  ],
});

describe("approved Tax fixture simulation", () => {
  it("simulates a basket with exact minor-unit receipt evidence", () => {
    const result = simulateApprovedTaxFixture(snapshot(), fixture("Basket", "1000"));
    expect(result).toMatchObject({
      netAmountMinor: "1000",
      taxAmountMinor: "130",
      grossAmountMinor: "1130",
    });
    expect(result.receiptPreview[0]?.componentCode).toBe("SYNTHETIC_COMPONENT");
  });

  it("uses the same version-pinned rules symmetrically for refunds", () => {
    expect(simulateApprovedTaxFixture(snapshot(), fixture("Refund", "-1000"))).toMatchObject({
      taxAmountMinor: "-130",
      grossAmountMinor: "-1130",
    });
  });

  it("preserves inclusive fixture gross while deriving exact net", () => {
    const source = snapshot();
    const rule = source.rules[0];
    if (rule === undefined) throw new Error("synthetic Tax rule missing");
    const inclusive = {
      ...source,
      rules: [{ ...rule, priceInclusion: "Inclusive" as const }],
    };
    expect(simulateApprovedTaxFixture(inclusive, fixture("Basket", "1130"))).toMatchObject({
      netAmountMinor: "1000",
      taxAmountMinor: "130",
      grossAmountMinor: "1130",
    });
  });

  it("fails closed for a fixture not bound to approved professional evidence", () => {
    expect(() =>
      simulateApprovedTaxFixture(snapshot(), {
        ...fixture("Basket", "1000"),
        fixtureSuiteDigest: digest("d"),
      }),
    ).toThrow(TaxFixtureSimulationError);
  });
});
