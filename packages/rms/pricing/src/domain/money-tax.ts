import {
  createMoney,
  MoneyTaxContractError,
  parseAmountMinor,
  parsePricingCode,
  parseTaxRate,
  validateTaxCalculationInput,
  type CurrencyCode,
  type Money,
  type MoneyAllocation,
  type MoneyAllocationShare,
  type RoundingMode,
  type TaxCalculationInput,
  type TaxCalculationResult,
  type TaxRate,
} from "./money-tax-contract.js";

function fail(code: ConstructorParameters<typeof MoneyTaxContractError>[0]): never {
  throw new MoneyTaxContractError(code);
}

function checked(amountMinor: bigint, currencyCode: CurrencyCode): Money {
  try {
    return createMoney({ amountMinor: parseAmountMinor(amountMinor), currencyCode });
  } catch (error) {
    if (error instanceof MoneyTaxContractError && error.code === "MONEY_INPUT_INVALID")
      fail("MONEY_OVERFLOW");
    throw error;
  }
}

function sameCurrency(left: Money, right: Money): void {
  if (left.currencyCode !== right.currencyCode) fail("MONEY_CURRENCY_MISMATCH");
}

export function addMoney(leftInput: Money, rightInput: Money): Money {
  const left = createMoney(leftInput);
  const right = createMoney(rightInput);
  sameCurrency(left, right);
  return checked(left.amountMinor + right.amountMinor, left.currencyCode);
}

export function subtractMoney(leftInput: Money, rightInput: Money): Money {
  const left = createMoney(leftInput);
  const right = createMoney(rightInput);
  sameCurrency(left, right);
  return checked(left.amountMinor - right.amountMinor, left.currencyCode);
}

export function compareMoney(leftInput: Money, rightInput: Money): -1 | 0 | 1 {
  const left = createMoney(leftInput);
  const right = createMoney(rightInput);
  sameCurrency(left, right);
  return left.amountMinor < right.amountMinor ? -1 : left.amountMinor > right.amountMinor ? 1 : 0;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function roundRational(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (typeof numerator !== "bigint" || typeof denominator !== "bigint" || denominator <= 0n)
    fail("MONEY_DIVISION_INVALID");
  if (mode !== "HalfUp" && mode !== "HalfEven" && mode !== "TowardZero" && mode !== "AwayFromZero")
    fail("MONEY_DIVISION_INVALID");
  const sign = numerator < 0n ? -1n : 1n;
  const magnitude = absolute(numerator);
  const quotient = magnitude / denominator;
  const remainder = magnitude % denominator;
  if (remainder === 0n || mode === "TowardZero") return sign * quotient;
  if (mode === "AwayFromZero") return sign * (quotient + 1n);
  const comparison = remainder * 2n - denominator;
  const increment =
    comparison > 0n ||
    (comparison === 0n && (mode === "HalfUp" || (mode === "HalfEven" && quotient % 2n !== 0n)));
  return sign * (increment ? quotient + 1n : quotient);
}

export function taxRateRatio(rate: TaxRate): Readonly<{ numerator: bigint; denominator: bigint }> {
  const canonicalRate = parseTaxRate(rate);
  const [whole = "0", fraction = ""] = canonicalRate.split(".");
  const denominator = 10n ** BigInt(fraction.length);
  return Object.freeze({
    numerator: BigInt(whole) * denominator + BigInt(fraction || "0"),
    denominator,
  });
}

export function multiplyMoneyByTaxRate(
  amountInput: Money,
  rate: TaxRate,
  roundingMode: RoundingMode,
): Money {
  const amount = createMoney(amountInput);
  const ratio = taxRateRatio(rate);
  return checked(
    roundRational(amount.amountMinor * ratio.numerator, ratio.denominator, roundingMode),
    amount.currencyCode,
  );
}

export function calculateTax(input: TaxCalculationInput): TaxCalculationResult {
  const candidate = validateTaxCalculationInput(input);
  const { inputAmount, resolvedRule: rule } = candidate;
  const ratio = taxRateRatio(rule.rate);
  const taxMinor =
    rule.treatment !== "Taxable" || ratio.numerator === 0n
      ? 0n
      : rule.priceInclusion === "Exclusive"
        ? roundRational(
            inputAmount.amountMinor * ratio.numerator,
            ratio.denominator,
            rule.roundingMode,
          )
        : roundRational(
            inputAmount.amountMinor * ratio.numerator,
            ratio.denominator + ratio.numerator,
            rule.roundingMode,
          );
  const taxAmount = checked(taxMinor, inputAmount.currencyCode);
  const netAmount =
    rule.priceInclusion === "Inclusive"
      ? subtractMoney(inputAmount, taxAmount)
      : createMoney(inputAmount);
  const grossAmount =
    rule.priceInclusion === "Exclusive"
      ? addMoney(inputAmount, taxAmount)
      : createMoney(inputAmount);
  return Object.freeze({
    calculationReference: candidate.calculationReference,
    taxableReference: candidate.taxableReference,
    inputAmount,
    netAmount,
    taxAmount,
    grossAmount,
    explanation: Object.freeze({
      jurisdictionCode: rule.jurisdictionCode,
      taxComponentCode: rule.taxComponentCode,
      taxClassificationReference: rule.taxClassificationReference,
      treatment: rule.treatment,
      rate: rule.rate,
      rateNumerator: ratio.numerator.toString(),
      rateDenominator: ratio.denominator.toString(),
      priceInclusion: rule.priceInclusion,
      roundingMode: rule.roundingMode,
      currencyMetadataVersion: candidate.currencyMetadata.metadataVersion,
      currencyMetadataVersionReference: candidate.currencyMetadata.metadataVersionReference,
      currencyMetadataDigest: candidate.currencyMetadata.metadataDigest,
      ruleVersionReference: rule.ruleVersionReference,
      ruleVersionDigest: rule.ruleVersionDigest,
    }),
  });
}

export function allocateMoney(
  totalInput: Money,
  sharesInput: readonly MoneyAllocationShare[],
): readonly MoneyAllocation[] {
  const total = createMoney(totalInput);
  if (!Array.isArray(sharesInput) || sharesInput.length === 0) fail("MONEY_ALLOCATION_INVALID");
  const seen = new Set<string>();
  const shares = sharesInput.map((share) => {
    if (
      !share ||
      typeof share !== "object" ||
      Array.isArray(share) ||
      Object.getPrototypeOf(share) !== Object.prototype
    )
      fail("MONEY_ALLOCATION_INVALID");
    const keys = Reflect.ownKeys(share);
    const descriptors = Object.getOwnPropertyDescriptors(share);
    if (
      keys.length !== 2 ||
      !keys.includes("allocationKey") ||
      !keys.includes("weight") ||
      keys.some((key) => typeof key !== "string") ||
      !("value" in (descriptors.allocationKey ?? {})) ||
      !("value" in (descriptors.weight ?? {})) ||
      descriptors.allocationKey?.enumerable !== true ||
      descriptors.weight?.enumerable !== true ||
      typeof share.weight !== "bigint" ||
      share.weight < 0n
    )
      fail("MONEY_ALLOCATION_INVALID");
    let allocationKey;
    try {
      allocationKey = parsePricingCode(share.allocationKey);
    } catch {
      return fail("MONEY_ALLOCATION_INVALID");
    }
    if (seen.has(allocationKey)) fail("MONEY_ALLOCATION_INVALID");
    seen.add(allocationKey);
    return { allocationKey, weight: share.weight };
  });
  const weightTotal = shares.reduce((sum, share) => sum + share.weight, 0n);
  if (weightTotal <= 0n) fail("MONEY_ALLOCATION_INVALID");
  const magnitude = absolute(total.amountMinor);
  const sign = total.amountMinor < 0n ? -1n : 1n;
  const candidates = shares.map((share) => {
    const product = magnitude * share.weight;
    return {
      allocationKey: share.allocationKey,
      amount: product / weightTotal,
      remainder: product % weightTotal,
    };
  });
  let undistributed = magnitude - candidates.reduce((sum, candidate) => sum + candidate.amount, 0n);
  for (const candidate of [...candidates].sort((left, right) =>
    left.remainder === right.remainder
      ? left.allocationKey.localeCompare(right.allocationKey, "en")
      : left.remainder > right.remainder
        ? -1
        : 1,
  )) {
    if (undistributed === 0n) break;
    candidate.amount += 1n;
    undistributed -= 1n;
  }
  return Object.freeze(
    candidates
      .sort((left, right) => left.allocationKey.localeCompare(right.allocationKey, "en"))
      .map((candidate) =>
        Object.freeze({
          allocationKey: candidate.allocationKey,
          amount: checked(sign * candidate.amount, total.currencyCode),
        }),
      ),
  );
}
