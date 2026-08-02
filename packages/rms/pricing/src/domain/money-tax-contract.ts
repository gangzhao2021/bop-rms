export type CurrencyCode = string & { readonly __currencyCode: unique symbol };
export type PricingReference = string & { readonly __pricingReference: unique symbol };
export type PricingDigest = string & { readonly __pricingDigest: unique symbol };
export type PricingCode = string & { readonly __pricingCode: unique symbol };
export type TaxRate = string & { readonly __taxRate: unique symbol };

export const roundingModes = ["HalfUp", "HalfEven", "TowardZero", "AwayFromZero"] as const;
export type RoundingMode = (typeof roundingModes)[number];

export interface Money {
  readonly amountMinor: bigint;
  readonly currencyCode: CurrencyCode;
}

export interface CurrencyMetadataSnapshot {
  readonly currencyCode: CurrencyCode;
  readonly minorUnitExponent: number;
  readonly metadataVersion: number;
  readonly metadataVersionReference: PricingReference;
  readonly metadataDigest: PricingDigest;
}

export interface ResolvedTaxRuleSnapshot {
  readonly ruleVersionReference: PricingReference;
  readonly ruleVersionDigest: PricingDigest;
  readonly jurisdictionCode: PricingCode;
  readonly taxComponentCode: PricingCode;
  readonly taxClassificationReference: PricingReference;
  readonly treatment: "Taxable" | "Exempt" | "ZeroRated";
  readonly rate: TaxRate;
  readonly priceInclusion: "Exclusive" | "Inclusive";
  readonly roundingMode: RoundingMode;
}

export interface TaxCalculationInput {
  readonly calculationReference: PricingReference;
  readonly taxableReference: PricingReference;
  readonly inputAmount: Money;
  readonly currencyMetadata: CurrencyMetadataSnapshot;
  readonly resolvedRule: ResolvedTaxRuleSnapshot;
}

export interface TaxCalculationExplanation {
  readonly jurisdictionCode: PricingCode;
  readonly taxComponentCode: PricingCode;
  readonly taxClassificationReference: PricingReference;
  readonly treatment: ResolvedTaxRuleSnapshot["treatment"];
  readonly rate: TaxRate;
  readonly rateNumerator: string;
  readonly rateDenominator: string;
  readonly priceInclusion: ResolvedTaxRuleSnapshot["priceInclusion"];
  readonly roundingMode: RoundingMode;
  readonly currencyMetadataVersion: number;
  readonly currencyMetadataVersionReference: PricingReference;
  readonly currencyMetadataDigest: PricingDigest;
  readonly ruleVersionReference: PricingReference;
  readonly ruleVersionDigest: PricingDigest;
}

export interface TaxCalculationResult {
  readonly calculationReference: PricingReference;
  readonly taxableReference: PricingReference;
  readonly inputAmount: Money;
  readonly netAmount: Money;
  readonly taxAmount: Money;
  readonly grossAmount: Money;
  readonly explanation: TaxCalculationExplanation;
}

export interface MoneyAllocationShare {
  readonly allocationKey: PricingCode;
  readonly weight: bigint;
}

export interface MoneyAllocation {
  readonly allocationKey: PricingCode;
  readonly amount: Money;
}

export const moneyTaxErrorCodes = [
  "MONEY_INPUT_INVALID",
  "MONEY_CURRENCY_MISMATCH",
  "MONEY_OVERFLOW",
  "MONEY_DIVISION_INVALID",
  "MONEY_ALLOCATION_INVALID",
  "TAX_INPUT_INVALID",
] as const;
export type MoneyTaxErrorCode = (typeof moneyTaxErrorCodes)[number];

export class MoneyTaxContractError extends Error {
  readonly code: MoneyTaxErrorCode;

  constructor(code: MoneyTaxErrorCode) {
    super("money and tax contract input is invalid");
    this.name = "MoneyTaxContractError";
    this.code = code;
  }
}

const minimumMinor = -(2n ** 63n);
const maximumMinor = 2n ** 63n - 1n;
const currency = /^[A-Z]{3}$/u;
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;
const code = /^[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)*$/u;
const canonicalRate = /^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{0,11}[1-9])?$/u;

function fail(errorCode: MoneyTaxErrorCode): never {
  throw new MoneyTaxContractError(errorCode);
}

function exact(value: object, fields: readonly string[], errorCode: MoneyTaxErrorCode): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail(errorCode);
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(fields);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !keys.includes(field)) ||
    keys.some((field) => typeof field !== "string" || !allowed.has(field)) ||
    keys.some((field) => {
      if (typeof field !== "string") return true;
      const descriptor = descriptors[field];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    fail(errorCode);
}

export function parseCurrencyCode(value: unknown): CurrencyCode {
  if (typeof value !== "string" || !currency.test(value)) fail("MONEY_INPUT_INVALID");
  return value as CurrencyCode;
}

export function parsePricingReference(value: unknown): PricingReference {
  if (typeof value !== "string" || !uuidV7.test(value)) fail("TAX_INPUT_INVALID");
  return value as PricingReference;
}

export function parsePricingDigest(value: unknown): PricingDigest {
  if (typeof value !== "string" || !digest.test(value)) fail("TAX_INPUT_INVALID");
  return value as PricingDigest;
}

export function parsePricingCode(value: unknown): PricingCode {
  if (typeof value !== "string" || value.length > 64 || !code.test(value))
    fail("TAX_INPUT_INVALID");
  return value as PricingCode;
}

export function parseTaxRate(value: unknown): TaxRate {
  if (typeof value !== "string" || !canonicalRate.test(value)) fail("TAX_INPUT_INVALID");
  return value as TaxRate;
}

export function parseAmountMinor(value: unknown): bigint {
  if (typeof value !== "bigint" || value < minimumMinor || value > maximumMinor)
    fail("MONEY_INPUT_INVALID");
  return value;
}

export function createMoney(input: Money): Money {
  exact(input, ["amountMinor", "currencyCode"], "MONEY_INPUT_INVALID");
  return Object.freeze({
    amountMinor: parseAmountMinor(input.amountMinor),
    currencyCode: parseCurrencyCode(input.currencyCode),
  });
}

export function createCurrencyMetadataSnapshot(
  input: CurrencyMetadataSnapshot,
): CurrencyMetadataSnapshot {
  exact(
    input,
    [
      "currencyCode",
      "minorUnitExponent",
      "metadataVersion",
      "metadataVersionReference",
      "metadataDigest",
    ],
    "TAX_INPUT_INVALID",
  );
  if (
    !Number.isInteger(input.minorUnitExponent) ||
    input.minorUnitExponent < 0 ||
    input.minorUnitExponent > 6 ||
    !Number.isSafeInteger(input.metadataVersion) ||
    input.metadataVersion < 1
  )
    fail("TAX_INPUT_INVALID");
  return Object.freeze({
    currencyCode: parseCurrencyCode(input.currencyCode),
    minorUnitExponent: input.minorUnitExponent,
    metadataVersion: input.metadataVersion,
    metadataVersionReference: parsePricingReference(input.metadataVersionReference),
    metadataDigest: parsePricingDigest(input.metadataDigest),
  });
}

export function createResolvedTaxRuleSnapshot(
  input: ResolvedTaxRuleSnapshot,
): ResolvedTaxRuleSnapshot {
  exact(
    input,
    [
      "ruleVersionReference",
      "ruleVersionDigest",
      "jurisdictionCode",
      "taxComponentCode",
      "taxClassificationReference",
      "treatment",
      "rate",
      "priceInclusion",
      "roundingMode",
    ],
    "TAX_INPUT_INVALID",
  );
  const rate = parseTaxRate(input.rate);
  if (
    (input.treatment !== "Taxable" &&
      input.treatment !== "Exempt" &&
      input.treatment !== "ZeroRated") ||
    (input.priceInclusion !== "Exclusive" && input.priceInclusion !== "Inclusive") ||
    !roundingModes.includes(input.roundingMode) ||
    (input.treatment !== "Taxable" && rate !== "0")
  )
    fail("TAX_INPUT_INVALID");
  return Object.freeze({
    ruleVersionReference: parsePricingReference(input.ruleVersionReference),
    ruleVersionDigest: parsePricingDigest(input.ruleVersionDigest),
    jurisdictionCode: parsePricingCode(input.jurisdictionCode),
    taxComponentCode: parsePricingCode(input.taxComponentCode),
    taxClassificationReference: parsePricingReference(input.taxClassificationReference),
    treatment: input.treatment,
    rate,
    priceInclusion: input.priceInclusion,
    roundingMode: input.roundingMode,
  });
}

export function validateTaxCalculationInput(input: TaxCalculationInput): TaxCalculationInput {
  exact(
    input,
    ["calculationReference", "taxableReference", "inputAmount", "currencyMetadata", "resolvedRule"],
    "TAX_INPUT_INVALID",
  );
  const inputAmount = createMoney(input.inputAmount);
  const currencyMetadata = createCurrencyMetadataSnapshot(input.currencyMetadata);
  if (inputAmount.currencyCode !== currencyMetadata.currencyCode) fail("MONEY_CURRENCY_MISMATCH");
  return Object.freeze({
    calculationReference: parsePricingReference(input.calculationReference),
    taxableReference: parsePricingReference(input.taxableReference),
    inputAmount,
    currencyMetadata,
    resolvedRule: createResolvedTaxRuleSnapshot(input.resolvedRule),
  });
}

export const amountMinorBounds = Object.freeze({ minimum: minimumMinor, maximum: maximumMinor });
