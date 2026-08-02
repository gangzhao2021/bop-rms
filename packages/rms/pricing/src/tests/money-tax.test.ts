import { describe, expect, it } from "vitest";
import {
  addMoney,
  allocateMoney,
  amountMinorBounds,
  calculateTax,
  compareMoney,
  createCurrencyMetadataSnapshot,
  createMoney,
  createResolvedTaxRuleSnapshot,
  MoneyTaxContractError,
  multiplyMoneyByTaxRate,
  parseCurrencyCode,
  parsePricingCode,
  parsePricingDigest,
  parsePricingReference,
  parseTaxRate,
  roundRational,
  subtractMoney,
  taxRateRatio,
  type ResolvedTaxRuleSnapshot,
  type TaxCalculationInput,
} from "../index.js";

const ids = {
  calculation: "018f4000-0000-7000-8000-000000000001",
  taxable: "018f4000-0000-7000-8000-000000000002",
  currencyVersion: "018f4000-0000-7000-8000-000000000003",
  ruleVersion: "018f4000-0000-7000-8000-000000000004",
  classification: "018f4000-0000-7000-8000-000000000005",
} as const;
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;

function money(amountMinor = 1000n, currencyCode = "CAD") {
  return createMoney({ amountMinor, currencyCode: currencyCode as never });
}

function metadata(currencyCode = "CAD") {
  return createCurrencyMetadataSnapshot({
    currencyCode: currencyCode as never,
    minorUnitExponent: 2,
    metadataVersion: 7,
    metadataVersionReference: ids.currencyVersion as never,
    metadataDigest: digestA as never,
  });
}

function rule(overrides: Partial<ResolvedTaxRuleSnapshot> = {}) {
  return createResolvedTaxRuleSnapshot({
    ruleVersionReference: ids.ruleVersion as never,
    ruleVersionDigest: digestB as never,
    jurisdictionCode: "CA-ON" as never,
    taxComponentCode: "SYNTHETIC_COMPONENT" as never,
    taxClassificationReference: ids.classification as never,
    treatment: "Taxable",
    rate: "0.13" as never,
    priceInclusion: "Exclusive",
    roundingMode: "HalfUp",
    ...overrides,
  });
}

function calculation(overrides: Partial<TaxCalculationInput> = {}): TaxCalculationInput {
  return {
    calculationReference: ids.calculation as never,
    taxableReference: ids.taxable as never,
    inputAmount: money(),
    currencyMetadata: metadata(),
    resolvedRule: rule(),
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected contract error");
  } catch (error) {
    expect(error).toBeInstanceOf(MoneyTaxContractError);
    expect((error as MoneyTaxContractError).code).toBe(code);
    expect((error as Error).message).not.toContain("CAD");
  }
}

describe("Money contract", () => {
  it("stores signed bigint minor units with an explicit currency", () => {
    expect(money(-123n)).toEqual({ amountMinor: -123n, currencyCode: "CAD" });
    expect(parseCurrencyCode("CAD")).toBe("CAD");
  });

  it("rejects number and binary floating-point inputs", () => {
    expectCode(
      () => createMoney({ amountMinor: 1.25 as never, currencyCode: "CAD" as never }),
      "MONEY_INPUT_INVALID",
    );
    expectCode(
      () => createMoney({ amountMinor: 100 as never, currencyCode: "CAD" as never }),
      "MONEY_INPUT_INVALID",
    );
  });

  it("enforces the PostgreSQL bigint range", () => {
    expect(money(amountMinorBounds.minimum).amountMinor).toBe(-(2n ** 63n));
    expect(money(amountMinorBounds.maximum).amountMinor).toBe(2n ** 63n - 1n);
    expectCode(() => money(amountMinorBounds.maximum + 1n), "MONEY_INPUT_INVALID");
  });

  it("rejects lowercase, unknown fields, symbols and accessors", () => {
    expectCode(() => money(1n, "cad"), "MONEY_INPUT_INVALID");
    expectCode(() => createMoney(null as never), "MONEY_INPUT_INVALID");
    expectCode(
      () => createMoney({ amountMinor: 1n, currencyCode: "CAD" as never, extra: true } as never),
      "MONEY_INPUT_INVALID",
    );
    expectCode(
      () =>
        createMoney({
          amountMinor: 1n,
          currencyCode: "CAD" as never,
          [Symbol("x")]: true,
        } as never),
      "MONEY_INPUT_INVALID",
    );
    const accessor = {
      amountMinor: 1n,
      get currencyCode() {
        return "CAD" as never;
      },
    };
    expectCode(() => createMoney(accessor), "MONEY_INPUT_INVALID");
  });

  it("adds, subtracts and compares only the same currency", () => {
    expect(addMoney(money(101n), money(9n)).amountMinor).toBe(110n);
    expect(subtractMoney(money(101n), money(9n)).amountMinor).toBe(92n);
    expect(compareMoney(money(1n), money(2n))).toBe(-1);
    expect(compareMoney(money(2n), money(2n))).toBe(0);
    expect(compareMoney(money(3n), money(2n))).toBe(1);
    expectCode(() => addMoney(money(1n), money(1n, "USD")), "MONEY_CURRENCY_MISMATCH");
  });

  it("fails closed on arithmetic overflow", () => {
    expectCode(() => addMoney(money(amountMinorBounds.maximum), money(1n)), "MONEY_OVERFLOW");
    expectCode(() => subtractMoney(money(amountMinorBounds.minimum), money(1n)), "MONEY_OVERFLOW");
  });
});

describe("deterministic decimal and rounding contract", () => {
  it("accepts canonical decimal tax rates and rejects numbers/non-canonical text", () => {
    expect(parseTaxRate("0")).toBe("0");
    expect(parseTaxRate("0.13")).toBe("0.13");
    for (const invalid of [0.13, "00.13", ".13", "0.130", "1e-2", "-0.1"])
      expectCode(() => parseTaxRate(invalid), "TAX_INPUT_INVALID");
  });

  it("turns a decimal rate into an exact rational", () => {
    expect(taxRateRatio(parseTaxRate("0.0825"))).toEqual({ numerator: 825n, denominator: 10_000n });
    expectCode(() => taxRateRatio("0.130" as never), "TAX_INPUT_INVALID");
  });

  it("implements half-up and half-even ties symmetrically", () => {
    expect(roundRational(5n, 2n, "HalfUp")).toBe(3n);
    expect(roundRational(-5n, 2n, "HalfUp")).toBe(-3n);
    expect(roundRational(5n, 2n, "HalfEven")).toBe(2n);
    expect(roundRational(7n, 2n, "HalfEven")).toBe(4n);
    expect(roundRational(-7n, 2n, "HalfEven")).toBe(-4n);
  });

  it("implements directed rounding without floating point", () => {
    expect(roundRational(1n, 3n, "TowardZero")).toBe(0n);
    expect(roundRational(-1n, 3n, "TowardZero")).toBe(0n);
    expect(roundRational(1n, 3n, "AwayFromZero")).toBe(1n);
    expect(roundRational(-1n, 3n, "AwayFromZero")).toBe(-1n);
    expectCode(() => roundRational(1n, 0n, "HalfUp"), "MONEY_DIVISION_INVALID");
  });

  it("multiplies Money by an exact decimal rate", () => {
    expect(multiplyMoneyByTaxRate(money(999n), parseTaxRate("0.13"), "HalfUp")).toEqual(
      money(130n),
    );
  });
});

describe("version-pinned tax calculation", () => {
  it("calculates exclusive tax and preserves net + tax = gross", () => {
    const result = calculateTax(calculation());
    expect(result.netAmount.amountMinor).toBe(1000n);
    expect(result.taxAmount.amountMinor).toBe(130n);
    expect(result.grossAmount.amountMinor).toBe(1130n);
  });

  it("splits inclusive tax deterministically", () => {
    const result = calculateTax(
      calculation({
        inputAmount: money(1130n),
        resolvedRule: rule({ priceInclusion: "Inclusive" }),
      }),
    );
    expect(result.netAmount.amountMinor).toBe(1000n);
    expect(result.taxAmount.amountMinor).toBe(130n);
    expect(result.grossAmount.amountMinor).toBe(1130n);
  });

  it("uses the same signed calculation for refund-like values", () => {
    const result = calculateTax(
      calculation({
        inputAmount: money(-1130n),
        resolvedRule: rule({ priceInclusion: "Inclusive" }),
      }),
    );
    expect(result.netAmount.amountMinor).toBe(-1000n);
    expect(result.taxAmount.amountMinor).toBe(-130n);
  });

  it("keeps exempt and zero-rated treatment explicit", () => {
    for (const treatment of ["Exempt", "ZeroRated"] as const) {
      const result = calculateTax(
        calculation({ resolvedRule: rule({ treatment, rate: "0" as never }) }),
      );
      expect(result.taxAmount.amountMinor).toBe(0n);
      expect(result.explanation.treatment).toBe(treatment);
    }
    expectCode(() => rule({ treatment: "Exempt", rate: "0.13" as never }), "TAX_INPUT_INVALID");
  });

  it("pins exact currency and tax rule evidence in the explanation", () => {
    const result = calculateTax(calculation());
    expect(result.explanation).toMatchObject({
      jurisdictionCode: "CA-ON",
      rate: "0.13",
      rateNumerator: "13",
      rateDenominator: "100",
      currencyMetadataVersion: 7,
      currencyMetadataVersionReference: ids.currencyVersion,
      currencyMetadataDigest: digestA,
      ruleVersionReference: ids.ruleVersion,
      ruleVersionDigest: digestB,
    });
  });

  it("is exactly reproducible for the same input and versions", () => {
    expect(calculateTax(calculation())).toEqual(calculateTax(calculation()));
  });

  it("rejects a currency metadata mismatch", () => {
    expectCode(
      () => calculateTax(calculation({ currencyMetadata: metadata("USD") })),
      "MONEY_CURRENCY_MISMATCH",
    );
  });

  it("validates version references, digests, codes and currency precision", () => {
    expect(parsePricingReference(ids.ruleVersion)).toBe(ids.ruleVersion);
    expect(parsePricingDigest(digestA)).toBe(digestA);
    expect(parsePricingCode("CA-ON")).toBe("CA-ON");
    expectCode(() => parsePricingReference("rule-v1"), "TAX_INPUT_INVALID");
    expectCode(() => parsePricingDigest("sha256:nope"), "TAX_INPUT_INVALID");
    expectCode(
      () => createCurrencyMetadataSnapshot({ ...metadata(), minorUnitExponent: 7 }),
      "TAX_INPUT_INVALID",
    );
  });
});

describe("deterministic minor-unit allocation", () => {
  it("allocates every minor unit and sorts output by stable key", () => {
    const allocations = allocateMoney(money(10n), [
      { allocationKey: "C" as never, weight: 1n },
      { allocationKey: "A" as never, weight: 1n },
      { allocationKey: "B" as never, weight: 1n },
    ]);
    expect(
      allocations.map(({ allocationKey, amount }) => [allocationKey, amount.amountMinor]),
    ).toEqual([
      ["A", 4n],
      ["B", 3n],
      ["C", 3n],
    ]);
  });

  it("uses the same deterministic allocation for negative corrections", () => {
    const allocations = allocateMoney(money(-5n), [
      { allocationKey: "A" as never, weight: 1n },
      { allocationKey: "B" as never, weight: 1n },
    ]);
    expect(allocations.map(({ amount }) => amount.amountMinor)).toEqual([-3n, -2n]);
  });

  it("rejects duplicate keys, invalid weights, accessors and empty shares", () => {
    expectCode(() => allocateMoney(money(), []), "MONEY_ALLOCATION_INVALID");
    expectCode(
      () => allocateMoney(money(), [{ allocationKey: "A" as never, weight: 0n }]),
      "MONEY_ALLOCATION_INVALID",
    );
    expectCode(
      () =>
        allocateMoney(money(), [
          { allocationKey: "A" as never, weight: 1n },
          { allocationKey: "A" as never, weight: 2n },
        ]),
      "MONEY_ALLOCATION_INVALID",
    );
    const accessor = {
      allocationKey: "A" as never,
      get weight() {
        return 1n;
      },
    };
    expectCode(() => allocateMoney(money(), [accessor]), "MONEY_ALLOCATION_INVALID");
  });
});
