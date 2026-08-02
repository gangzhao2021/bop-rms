import { describe, expect, it } from "vitest";
import { createEffectivePeriod } from "@bop/effective-period";

import {
  createCurrencyMetadataSnapshot,
  createTaxConfigurationSnapshot,
  parsePricingDigest,
  parsePricingReference,
  resolveTaxConfiguration,
  TaxConfigurationError,
  validateTaxConfigurationCoverage,
  type TaxConfigurationRule,
  type TaxConfigurationSnapshot,
} from "../index.js";

const id = (value: number) =>
  parsePricingReference(`018f5000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`);
const digest = (value: string) => parsePricingDigest(`sha256:${value.repeat(64)}`);
const at = "2026-08-02T14:00:00.000Z";
const expiry = "2026-09-01T14:00:00.000Z";

function period() {
  return createEffectivePeriod({
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
  });
}

function rule(overrides: Partial<TaxConfigurationRule> = {}): TaxConfigurationRule {
  return {
    ruleReference: id(20),
    taxClassificationReference: id(21),
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
    receiptPresentationCode: "SYNTHETIC_RECEIPT_LINE" as never,
    ...overrides,
  };
}

function snapshot(overrides: Partial<TaxConfigurationSnapshot> = {}): TaxConfigurationSnapshot {
  const versionReference = id(2);
  const snapshotDigest = digest("a");
  return {
    configurationReference: id(1),
    versionReference,
    brandReference: id(3),
    storeReference: id(4),
    stableCode: "PILOT_STORE_TAX" as never,
    aggregateVersion: 1,
    versionNumber: 1,
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
    effectivePeriod: period(),
    registrationEvidence: {
      applicabilityReference: id(6),
      operatingEntityTaxReference: id(7),
      jurisdictionProfileReference: id(8),
      status: "Verified",
      validUntil: expiry,
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
      validUntil: expiry,
    },
    rules: [rule()],
    createdAt: at,
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    brandReference: id(3),
    storeReference: id(4),
    jurisdictionCode: "CA-ON" as never,
    currencyCode: "CAD",
    taxClassificationReference: id(21),
    orderType: "Pickup" as const,
    chargeType: "Sellable" as const,
    evaluatedAt: at,
    ...overrides,
  };
}

function publishedProfessionalEvidence() {
  const evidence = snapshot().professionalEvidence;
  if (evidence === null) throw new Error("published fixture requires professional evidence");
  return evidence;
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected error");
  } catch (error) {
    expect(error).toBeInstanceOf(TaxConfigurationError);
    expect((error as TaxConfigurationError).code).toBe(code);
    expect((error as Error).message).not.toContain("0.13");
  }
}

describe("Store Tax Configuration snapshot", () => {
  it("creates one exact version-pinned CA-ON/CAD published snapshot", () => {
    const value = createTaxConfigurationSnapshot(snapshot());
    expect(value.lifecycle).toBe("Published");
    expect(value.rules).toHaveLength(1);
    expect(value.professionalEvidence?.snapshotDigest).toBe(value.snapshotDigest);
  });

  it("allows an evidence-free Draft without claiming publication", () => {
    const value = createTaxConfigurationSnapshot(
      snapshot({
        lifecycle: "Draft",
        rules: [],
        registrationEvidence: null,
        professionalEvidence: null,
      }),
    );
    expect(value.rules).toEqual([]);
  });

  it("blocks Published without registration, professional review, fixtures or rules", () => {
    expectCode(
      () => createTaxConfigurationSnapshot(snapshot({ professionalEvidence: null })),
      "TAX_CONFIGURATION_EVIDENCE_INVALID",
    );
    expectCode(
      () => createTaxConfigurationSnapshot(snapshot({ registrationEvidence: null })),
      "TAX_CONFIGURATION_EVIDENCE_INVALID",
    );
    expectCode(
      () => createTaxConfigurationSnapshot(snapshot({ rules: [] })),
      "TAX_CONFIGURATION_EVIDENCE_INVALID",
    );
  });

  it("binds professional evidence to the exact version and snapshot digest", () => {
    expectCode(
      () =>
        createTaxConfigurationSnapshot(
          snapshot({
            professionalEvidence: {
              ...publishedProfessionalEvidence(),
              snapshotDigest: digest("d"),
            },
          }),
        ),
      "TAX_CONFIGURATION_EVIDENCE_INVALID",
    );
  });

  it("keeps the accepted Pilot scope explicit", () => {
    expectCode(
      () => createTaxConfigurationSnapshot(snapshot({ jurisdictionCode: "CA-QC" as never })),
      "TAX_CONFIGURATION_SCOPE_MISMATCH",
    );
    expectCode(
      () =>
        createTaxConfigurationSnapshot(
          snapshot({
            currencyMetadata: createCurrencyMetadataSnapshot({
              ...snapshot().currencyMetadata,
              currencyCode: "USD" as never,
            }),
          }),
        ),
      "TAX_CONFIGURATION_SCOPE_MISMATCH",
    );
  });

  it("requires non-taxable treatment to retain exception evidence and zero rate", () => {
    expectCode(
      () => createTaxConfigurationSnapshot(snapshot({ rules: [rule({ treatment: "Exempt" })] })),
      "TAX_CONFIGURATION_INPUT_INVALID",
    );
    const value = createTaxConfigurationSnapshot(
      snapshot({
        rules: [
          rule({
            treatment: "ZeroRated",
            rate: "0" as never,
            exceptionEvidenceReference: id(30),
          }),
        ],
      }),
    );
    expect(value.rules[0]?.treatment).toBe("ZeroRated");
  });

  it("rejects rule identity, component and calculation-order conflicts", () => {
    expectCode(
      () => createTaxConfigurationSnapshot(snapshot({ rules: [rule(), rule()] })),
      "TAX_CONFIGURATION_RULE_CONFLICT",
    );
    expectCode(
      () =>
        createTaxConfigurationSnapshot(
          snapshot({
            rules: [
              rule(),
              rule({
                ruleReference: id(22),
                calculationOrder: 3,
                taxComponentCode: "SECOND" as never,
              }),
            ],
          }),
        ),
      "TAX_CONFIGURATION_RULE_CONFLICT",
    );
  });

  it("models deterministic compound component order without calculating legal semantics", () => {
    const value = createTaxConfigurationSnapshot(
      snapshot({
        rules: [
          rule(),
          rule({
            ruleReference: id(22),
            calculationOrder: 2,
            compoundOnPriorTax: true,
            taxComponentCode: "SYNTHETIC_SECOND" as never,
          }),
        ],
      }),
    );
    expect(value.rules.map((entry) => entry.calculationOrder)).toEqual([1, 2]);
  });

  it("rejects closed-shape extras, symbols, accessors and raw numeric rates", () => {
    expectCode(
      () => createTaxConfigurationSnapshot({ ...snapshot(), extra: true } as never),
      "TAX_CONFIGURATION_INPUT_INVALID",
    );
    expectCode(
      () => createTaxConfigurationSnapshot({ ...snapshot(), [Symbol("x")]: true } as never),
      "TAX_CONFIGURATION_INPUT_INVALID",
    );
    expectCode(
      () => createTaxConfigurationSnapshot(snapshot({ rules: [rule({ rate: 0.13 as never })] })),
      "TAX_CONFIGURATION_INPUT_INVALID",
    );
  });
});

describe("Store Tax Configuration resolution", () => {
  it("returns deterministic ordered rule snapshots and exact configuration evidence", () => {
    const value = resolveTaxConfiguration(
      snapshot({
        rules: [
          rule(),
          rule({
            ruleReference: id(22),
            calculationOrder: 2,
            compoundOnPriorTax: true,
            taxComponentCode: "SYNTHETIC_SECOND" as never,
          }),
        ],
      }),
      context(),
    );
    expect(value.versionReference).toBe(id(2));
    expect(value.snapshotDigest).toBe(digest("a"));
    expect(value.rules.map((entry) => entry.calculationOrder)).toEqual([1, 2]);
    expect(value.rules[1]?.resolvedRule.ruleVersionDigest).toBe(digest("a"));
  });

  it("rejects Draft and cross-Store/currency/jurisdiction contexts", () => {
    expectCode(
      () =>
        resolveTaxConfiguration(
          snapshot({ lifecycle: "Draft", professionalEvidence: null, registrationEvidence: null }),
          context(),
        ),
      "TAX_CONFIGURATION_SCOPE_MISMATCH",
    );
    expectCode(
      () => resolveTaxConfiguration(snapshot(), context({ storeReference: id(40) })),
      "TAX_CONFIGURATION_SCOPE_MISMATCH",
    );
    expectCode(
      () => resolveTaxConfiguration(snapshot(), context({ currencyCode: "USD" })),
      "TAX_CONFIGURATION_SCOPE_MISMATCH",
    );
  });

  it("fails closed outside the effective period", () => {
    expectCode(
      () =>
        resolveTaxConfiguration(snapshot(), context({ evaluatedAt: "2026-09-01T04:00:00.000Z" })),
      "TAX_CONFIGURATION_NOT_EFFECTIVE",
    );
  });

  it("fails closed when professional or registration evidence expires", () => {
    expectCode(
      () =>
        resolveTaxConfiguration(
          snapshot({
            professionalEvidence: { ...publishedProfessionalEvidence(), validUntil: at },
          }),
          context(),
        ),
      "TAX_CONFIGURATION_EVIDENCE_INVALID",
    );
  });

  it("fails closed for an uncovered classification/order/charge context", () => {
    expectCode(
      () => resolveTaxConfiguration(snapshot(), context({ taxClassificationReference: id(99) })),
      "TAX_CONFIGURATION_COVERAGE_MISSING",
    );
  });

  it("validates exact required coverage before publication", () => {
    expect(() =>
      validateTaxConfigurationCoverage(snapshot(), [
        {
          taxClassificationReference: id(21),
          orderType: "Pickup",
          chargeType: "Sellable",
        },
      ]),
    ).not.toThrow();
    expectCode(
      () =>
        validateTaxConfigurationCoverage(snapshot(), [
          {
            taxClassificationReference: id(21),
            orderType: "DineIn",
            chargeType: "Sellable",
          },
        ]),
      "TAX_CONFIGURATION_COVERAGE_MISSING",
    );
  });
});
