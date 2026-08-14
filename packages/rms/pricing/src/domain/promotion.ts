import { createEffectivePeriod, type EffectivePeriod } from "@bop/effective-period";
import { compareMoney, multiplyMoneyByTaxRate, subtractMoney, taxRateRatio } from "./money-tax.js";
import {
  createMoney,
  parseAmountMinor,
  parseCurrencyCode,
  parsePricingCode,
  parsePricingDigest,
  parsePricingReference,
  parseTaxRate,
  type CurrencyCode,
  type Money,
  type PricingCode,
  type PricingDigest,
  type PricingReference,
  type TaxRate,
} from "./money-tax-contract.js";

export type PromotionLifecycle = "Draft" | "Published" | "Paused" | "Archived";
export type PromotionType =
  | "ItemPercentage"
  | "ItemFixed"
  | "OrderPercentage"
  | "OrderFixed"
  | "Threshold"
  | "BuyXGetY"
  | "HappyHour"
  | "Coupon"
  | "ManualDiscount";
export type PromotionStacking = "Exclusive" | "SameGroupExclusive" | "Stackable";

export interface PromotionBenefit {
  readonly scope: "Item" | "Order";
  readonly calculation: "Percentage" | "Fixed";
  readonly value: string;
  readonly maximumDiscountMinor: string | null;
}
export interface PromotionSnapshot {
  readonly promotionReference: PricingReference;
  readonly versionReference: PricingReference;
  readonly brandReference: PricingReference;
  readonly stableCode: PricingCode;
  readonly aggregateVersion: number;
  readonly versionNumber: number;
  readonly snapshotDigest: PricingDigest;
  readonly lifecycle: PromotionLifecycle;
  readonly promotionType: PromotionType;
  readonly currencyCode: CurrencyCode;
  readonly eligibleSellableReferences: readonly PricingReference[];
  readonly eligibleCategoryReferences: readonly PricingReference[];
  readonly eligibleSegmentReference: PricingReference | null;
  readonly thresholdMinor: string | null;
  readonly benefit: PromotionBenefit;
  readonly stacking: PromotionStacking;
  readonly stackingGroupCode: PricingCode | null;
  readonly priority: number;
  readonly budgetMinor: string;
  readonly usageMinor: string;
  readonly usageCount: number;
  readonly redemptionLimit: number;
  readonly effectivePeriod: EffectivePeriod;
  readonly customerCopyCode: PricingCode;
  readonly createdAt: string;
}
export interface PromotionBasketLine {
  readonly lineReference: PricingReference;
  readonly sellableReference: PricingReference;
  readonly categoryReferences: readonly PricingReference[];
  readonly amountMinor: string;
}
export interface PromotionBasket {
  readonly basketReference: PricingReference;
  readonly brandReference: PricingReference;
  readonly currencyCode: CurrencyCode;
  readonly segmentReference: PricingReference | null;
  readonly evaluatedAt: string;
  readonly lines: readonly PromotionBasketLine[];
}
export interface PromotionSimulation {
  readonly basketReference: PricingReference;
  readonly subtotal: Money;
  readonly discount: Money;
  readonly total: Money;
  readonly selections: readonly {
    readonly promotionReference: PricingReference;
    readonly versionReference: PricingReference;
    readonly discount: Money;
    readonly decision: "Selected" | "NotSelected";
    readonly reasonCode: PricingCode;
  }[];
}

export type PromotionErrorCode =
  | "PROMOTION_INPUT_INVALID"
  | "PROMOTION_SCOPE_MISMATCH"
  | "PROMOTION_NOT_EFFECTIVE"
  | "PROMOTION_BUDGET_EXHAUSTED"
  | "PROMOTION_STACKING_CONFLICT";
export class PromotionError extends Error {
  constructor(readonly code: PromotionErrorCode) {
    super("Promotion is unavailable");
    this.name = "PromotionError";
  }
}
const fail = (code: PromotionErrorCode): never => {
  throw new PromotionError(code);
};
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !instantPattern.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return fail("PROMOTION_INPUT_INVALID");
  return value;
}
function minor(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value))
    return fail("PROMOTION_INPUT_INVALID");
  try {
    return parseAmountMinor(BigInt(value));
  } catch {
    return fail("PROMOTION_INPUT_INVALID");
  }
}
function references(value: unknown): readonly PricingReference[] {
  if (!Array.isArray(value) || new Set(value).size !== value.length)
    return fail("PROMOTION_INPUT_INVALID");
  try {
    return Object.freeze(value.map(parsePricingReference));
  } catch {
    return fail("PROMOTION_INPUT_INVALID");
  }
}
function benefit(input: PromotionBenefit): PromotionBenefit {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Reflect.ownKeys(input).length !== 4
  )
    return fail("PROMOTION_INPUT_INVALID");
  if (
    (input.scope !== "Item" && input.scope !== "Order") ||
    (input.calculation !== "Percentage" && input.calculation !== "Fixed")
  )
    return fail("PROMOTION_INPUT_INVALID");
  if (input.calculation === "Percentage") {
    let rate: TaxRate;
    try {
      rate = parseTaxRate(input.value);
    } catch {
      return fail("PROMOTION_INPUT_INVALID");
    }
    const ratio = taxRateRatio(rate);
    if (ratio.numerator <= 0n || ratio.numerator > ratio.denominator)
      return fail("PROMOTION_INPUT_INVALID");
  } else if (minor(input.value) <= 0n) return fail("PROMOTION_INPUT_INVALID");
  if (input.maximumDiscountMinor !== null) minor(input.maximumDiscountMinor);
  return Object.freeze({ ...input });
}

export function createPromotionSnapshot(input: PromotionSnapshot): PromotionSnapshot {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Reflect.ownKeys(input).length !== 25
  )
    return fail("PROMOTION_INPUT_INVALID");
  if (
    !Number.isSafeInteger(input.aggregateVersion) ||
    input.aggregateVersion < 1 ||
    !Number.isSafeInteger(input.versionNumber) ||
    input.versionNumber < 1 ||
    !Number.isSafeInteger(input.priority) ||
    input.priority < 0 ||
    input.priority > 1000 ||
    !Number.isSafeInteger(input.usageCount) ||
    input.usageCount < 0 ||
    !Number.isSafeInteger(input.redemptionLimit) ||
    input.redemptionLimit < 1
  )
    return fail("PROMOTION_INPUT_INVALID");
  if (
    !["Draft", "Published", "Paused", "Archived"].includes(input.lifecycle) ||
    ![
      "ItemPercentage",
      "ItemFixed",
      "OrderPercentage",
      "OrderFixed",
      "Threshold",
      "BuyXGetY",
      "HappyHour",
      "Coupon",
      "ManualDiscount",
    ].includes(input.promotionType) ||
    !["Exclusive", "SameGroupExclusive", "Stackable"].includes(input.stacking)
  )
    return fail("PROMOTION_INPUT_INVALID");
  const budget = minor(input.budgetMinor);
  const usage = minor(input.usageMinor);
  if (budget <= 0n || usage > budget || input.usageCount > input.redemptionLimit)
    return fail("PROMOTION_INPUT_INVALID");
  const parsedBenefit = benefit(input.benefit);
  if ((input.stacking === "SameGroupExclusive") !== (input.stackingGroupCode !== null))
    return fail("PROMOTION_STACKING_CONFLICT");
  if (input.thresholdMinor !== null) minor(input.thresholdMinor);
  let period: EffectivePeriod;
  try {
    period = createEffectivePeriod(input.effectivePeriod);
  } catch {
    return fail("PROMOTION_INPUT_INVALID");
  }
  return Object.freeze({
    promotionReference: parsePricingReference(input.promotionReference),
    versionReference: parsePricingReference(input.versionReference),
    brandReference: parsePricingReference(input.brandReference),
    stableCode: parsePricingCode(input.stableCode),
    aggregateVersion: input.aggregateVersion,
    versionNumber: input.versionNumber,
    snapshotDigest: parsePricingDigest(input.snapshotDigest),
    lifecycle: input.lifecycle,
    promotionType: input.promotionType,
    currencyCode: parseCurrencyCode(input.currencyCode),
    eligibleSellableReferences: references(input.eligibleSellableReferences),
    eligibleCategoryReferences: references(input.eligibleCategoryReferences),
    eligibleSegmentReference:
      input.eligibleSegmentReference === null
        ? null
        : parsePricingReference(input.eligibleSegmentReference),
    thresholdMinor: input.thresholdMinor,
    benefit: parsedBenefit,
    stacking: input.stacking,
    stackingGroupCode:
      input.stackingGroupCode === null ? null : parsePricingCode(input.stackingGroupCode),
    priority: input.priority,
    budgetMinor: budget.toString(),
    usageMinor: usage.toString(),
    usageCount: input.usageCount,
    redemptionLimit: input.redemptionLimit,
    effectivePeriod: period,
    customerCopyCode: parsePricingCode(input.customerCopyCode),
    createdAt: instant(input.createdAt),
  });
}

function minimum(left: Money, right: Money): Money {
  return compareMoney(left, right) <= 0 ? left : right;
}
function candidateDiscount(
  promotion: PromotionSnapshot,
  basket: PromotionBasket,
  subtotal: Money,
): Money | null {
  if (
    promotion.lifecycle !== "Published" ||
    promotion.brandReference !== basket.brandReference ||
    promotion.currencyCode !== basket.currencyCode
  )
    return null;
  const at = Date.parse(basket.evaluatedAt);
  if (
    at < Date.parse(promotion.effectivePeriod.effectiveFrom.instant) ||
    (promotion.effectivePeriod.effectiveUntil !== null &&
      at >= Date.parse(promotion.effectivePeriod.effectiveUntil.instant))
  )
    return null;
  if (
    promotion.eligibleSegmentReference !== null &&
    promotion.eligibleSegmentReference !== basket.segmentReference
  )
    return null;
  if (promotion.thresholdMinor !== null && subtotal.amountMinor < minor(promotion.thresholdMinor))
    return null;
  if (promotion.usageCount >= promotion.redemptionLimit) return null;
  const eligibleLines = basket.lines.filter(
    (line) =>
      (promotion.eligibleSellableReferences.length === 0 &&
        promotion.eligibleCategoryReferences.length === 0) ||
      promotion.eligibleSellableReferences.includes(line.sellableReference) ||
      line.categoryReferences.some((reference) =>
        promotion.eligibleCategoryReferences.includes(reference),
      ),
  );
  const baseMinor =
    promotion.benefit.scope === "Order"
      ? subtotal.amountMinor
      : eligibleLines.reduce((sum, line) => sum + minor(line.amountMinor), 0n);
  if (baseMinor <= 0n) return null;
  const base = createMoney({ amountMinor: baseMinor, currencyCode: basket.currencyCode });
  let discount =
    promotion.benefit.calculation === "Percentage"
      ? multiplyMoneyByTaxRate(base, parseTaxRate(promotion.benefit.value), "HalfUp")
      : createMoney({
          amountMinor: minor(promotion.benefit.value),
          currencyCode: basket.currencyCode,
        });
  discount = minimum(discount, base);
  if (promotion.benefit.maximumDiscountMinor !== null)
    discount = minimum(
      discount,
      createMoney({
        amountMinor: minor(promotion.benefit.maximumDiscountMinor),
        currencyCode: basket.currencyCode,
      }),
    );
  const remaining = minor(promotion.budgetMinor) - minor(promotion.usageMinor);
  if (remaining <= 0n) return null;
  return minimum(
    discount,
    createMoney({ amountMinor: remaining, currencyCode: basket.currencyCode }),
  );
}

export function simulatePromotions(
  snapshotInputs: readonly PromotionSnapshot[],
  basket: PromotionBasket,
): PromotionSimulation {
  if (
    !Array.isArray(snapshotInputs) ||
    basket === null ||
    typeof basket !== "object" ||
    !Array.isArray(basket.lines) ||
    basket.lines.length === 0
  )
    return fail("PROMOTION_INPUT_INVALID");
  const snapshots = snapshotInputs.map(createPromotionSnapshot);
  const currencyCode = parseCurrencyCode(basket.currencyCode);
  instant(basket.evaluatedAt);
  const lines = basket.lines.map((line) => ({
    ...line,
    lineReference: parsePricingReference(line.lineReference),
    sellableReference: parsePricingReference(line.sellableReference),
    categoryReferences: references(line.categoryReferences),
    amountMinor: minor(line.amountMinor),
  }));
  const subtotal = createMoney({
    amountMinor: lines.reduce((sum, line) => sum + line.amountMinor, 0n),
    currencyCode,
  });
  const normalizedBasket = {
    ...basket,
    basketReference: parsePricingReference(basket.basketReference),
    brandReference: parsePricingReference(basket.brandReference),
    currencyCode,
    segmentReference:
      basket.segmentReference === null ? null : parsePricingReference(basket.segmentReference),
    evaluatedAt: instant(basket.evaluatedAt),
    lines,
  };
  const eligible = snapshots
    .map((promotion) => ({
      promotion,
      discount: candidateDiscount(promotion, normalizedBasket, subtotal),
    }))
    .filter(
      (entry): entry is { promotion: PromotionSnapshot; discount: Money } =>
        entry.discount !== null,
    );
  const byBest = (left: (typeof eligible)[number], right: (typeof eligible)[number]) =>
    right.discount.amountMinor === left.discount.amountMinor
      ? left.promotion.stableCode.localeCompare(right.promotion.stableCode, "en")
      : right.discount.amountMinor > left.discount.amountMinor
        ? 1
        : -1;
  const stackable = eligible.filter((entry) => entry.promotion.stacking === "Stackable");
  const groupBest = [
    ...new Set(
      eligible
        .filter((entry) => entry.promotion.stacking === "SameGroupExclusive")
        .map((entry) => entry.promotion.stackingGroupCode),
    ),
  ].flatMap((group) =>
    eligible
      .filter((entry) => entry.promotion.stackingGroupCode === group)
      .sort(byBest)
      .slice(0, 1),
  );
  const compatible = [...stackable, ...groupBest];
  const exclusivePlans = eligible
    .filter((entry) => entry.promotion.stacking === "Exclusive")
    .map((entry) => [entry]);
  const plans = [compatible, ...exclusivePlans].filter((plan) => plan.length > 0);
  const total = (plan: typeof eligible) =>
    plan.reduce((sum, entry) => sum + entry.discount.amountMinor, 0n);
  const selected =
    plans.sort((left, right) =>
      total(right) === total(left)
        ? left
            .map((e) => e.promotion.stableCode)
            .join("|")
            .localeCompare(right.map((e) => e.promotion.stableCode).join("|"), "en")
        : total(right) > total(left)
          ? 1
          : -1,
    )[0] ?? [];
  const selectedIds = new Set(selected.map((entry) => entry.promotion.promotionReference));
  let discount = createMoney({
    amountMinor: selected.reduce((sum, entry) => sum + entry.discount.amountMinor, 0n),
    currencyCode,
  });
  discount = minimum(discount, subtotal);
  return Object.freeze({
    basketReference: normalizedBasket.basketReference,
    subtotal,
    discount,
    total: subtractMoney(subtotal, discount),
    selections: Object.freeze(
      eligible
        .sort((a, b) => a.promotion.stableCode.localeCompare(b.promotion.stableCode, "en"))
        .map((entry) =>
          Object.freeze({
            promotionReference: entry.promotion.promotionReference,
            versionReference: entry.promotion.versionReference,
            discount: entry.discount,
            decision: selectedIds.has(entry.promotion.promotionReference)
              ? ("Selected" as const)
              : ("NotSelected" as const),
            reasonCode: parsePricingCode(
              selectedIds.has(entry.promotion.promotionReference)
                ? "SELECTED"
                : "STACKING_NOT_SELECTED",
            ),
          }),
        ),
    ),
  });
}
