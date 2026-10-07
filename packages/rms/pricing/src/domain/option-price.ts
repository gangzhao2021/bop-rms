import { createEffectivePeriod, type EffectivePeriod } from "@bop/effective-period";
import {
  createCurrencyMetadataSnapshot,
  createMoney,
  parsePricingReference,
  parsePricingDigest,
  parsePricingCode,
  type CurrencyMetadataSnapshot,
  type Money,
  type PricingReference,
  type PricingDigest,
  type PricingCode,
} from "./money-tax-contract.js";
import type { PriceOrderType, PriceScopeKind } from "./price-resolution.js";

export interface OptionPriceRuleSnapshot {
  readonly ruleReference: PricingReference;
  readonly versionReference: PricingReference;
  readonly snapshotDigest: PricingDigest;
  readonly brandReference: PricingReference;
  readonly bindingReference: PricingReference;
  readonly optionReference: PricingReference;
  readonly skuReference: PricingReference | null;
  readonly scopeKind: PriceScopeKind;
  readonly scopeReference: PricingReference | null;
  readonly channelCode: PricingCode | null;
  readonly orderType: PriceOrderType | null;
  readonly lifecycle: "Draft" | "Published" | "Archived";
  readonly currencyMetadata: CurrencyMetadataSnapshot;
  readonly unitAmount: Money;
  readonly includedQuantity: number;
  readonly quantityBasis: "PerItemChoice";
  readonly effectivePeriod: EffectivePeriod;
  readonly createdAt: string;
}
export interface OptionPriceContext {
  readonly brandReference: PricingReference;
  readonly storeReference: PricingReference;
  readonly storeGroupReference: PricingReference | null;
  readonly regionReference: PricingReference | null;
  readonly bindingReference: PricingReference;
  readonly optionReference: PricingReference;
  readonly skuReference: PricingReference;
  readonly channelCode: PricingCode;
  readonly orderType: PriceOrderType;
  readonly currencyMetadata: CurrencyMetadataSnapshot;
  readonly selectedQuantity: number;
  readonly itemQuantity: number;
  readonly evaluatedAt: string;
}
export interface OptionPriceResolution {
  readonly context: OptionPriceContext;
  readonly rule: OptionPriceRuleSnapshot;
  readonly priority: number;
  readonly skuReference: PricingReference;
  readonly selectedQuantity: number;
  readonly itemQuantity: number;
  readonly chargedQuantityPerItem: number;
  readonly chargedQuantity: bigint;
  readonly amount: Money;
  readonly evaluatedAt: string;
}
export class OptionPriceError extends Error {
  constructor(
    readonly code:
      | "OPTION_PRICE_INPUT_INVALID"
      | "OPTION_PRICE_SCOPE_MISMATCH"
      | "OPTION_PRICE_MISSING"
      | "OPTION_PRICE_CONFLICT"
      | "OPTION_PRICE_CALCULATION_FAILED",
  ) {
    super("option price could not be resolved");
    this.name = "OptionPriceError";
  }
}
function invalid(): never {
  throw new OptionPriceError("OPTION_PRICE_INPUT_INVALID");
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return invalid();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      return invalid();
    result[field] = descriptor.value;
  }
  return result;
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return invalid();
  return value;
}
function quantity(value: unknown, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    return invalid();
  return value;
}
const optionalReference = (value: unknown) =>
  value === null ? null : parsePricingReference(value);

export function createOptionPriceRuleSnapshot(
  value: OptionPriceRuleSnapshot,
): OptionPriceRuleSnapshot {
  try {
    const raw = closed(value, [
      "ruleReference",
      "versionReference",
      "snapshotDigest",
      "brandReference",
      "bindingReference",
      "optionReference",
      "skuReference",
      "scopeKind",
      "scopeReference",
      "channelCode",
      "orderType",
      "lifecycle",
      "currencyMetadata",
      "unitAmount",
      "includedQuantity",
      "quantityBasis",
      "effectivePeriod",
      "createdAt",
    ]);
    const scopeKind = raw.scopeKind as PriceScopeKind;
    if (
      !["Brand", "Region", "StoreGroup", "Store"].includes(scopeKind) ||
      (scopeKind === "Brand" ? raw.scopeReference !== null : raw.scopeReference === null) ||
      !["Draft", "Published", "Archived"].includes(String(raw.lifecycle)) ||
      (raw.orderType !== null && raw.orderType !== "DineIn" && raw.orderType !== "Pickup") ||
      raw.quantityBasis !== "PerItemChoice"
    )
      return invalid();
    const currencyMetadata = createCurrencyMetadataSnapshot(
      raw.currencyMetadata as CurrencyMetadataSnapshot,
    );
    const unitAmount = createMoney(raw.unitAmount as Money);
    if (unitAmount.amountMinor < 0n || unitAmount.currencyCode !== currencyMetadata.currencyCode)
      return invalid();
    return Object.freeze({
      ruleReference: parsePricingReference(raw.ruleReference),
      versionReference: parsePricingReference(raw.versionReference),
      snapshotDigest: parsePricingDigest(raw.snapshotDigest),
      brandReference: parsePricingReference(raw.brandReference),
      bindingReference: parsePricingReference(raw.bindingReference),
      optionReference: parsePricingReference(raw.optionReference),
      skuReference: optionalReference(raw.skuReference),
      scopeKind,
      scopeReference: optionalReference(raw.scopeReference),
      channelCode: raw.channelCode === null ? null : parsePricingCode(raw.channelCode),
      orderType: raw.orderType as PriceOrderType | null,
      lifecycle: raw.lifecycle as OptionPriceRuleSnapshot["lifecycle"],
      currencyMetadata,
      unitAmount,
      includedQuantity: quantity(raw.includedQuantity, 0),
      quantityBasis: "PerItemChoice",
      effectivePeriod: createEffectivePeriod(raw.effectivePeriod as EffectivePeriod),
      createdAt: instant(raw.createdAt),
    });
  } catch {
    return invalid();
  }
}

/** Pricing facts only: does not authorize Catalog selection or infer option tax treatment. */
export function resolveOptionPrice(
  values: readonly OptionPriceRuleSnapshot[],
  input: OptionPriceContext,
): OptionPriceResolution {
  try {
    if (!Array.isArray(values)) return invalid();
    const raw = closed(input, [
      "brandReference",
      "storeReference",
      "storeGroupReference",
      "regionReference",
      "bindingReference",
      "optionReference",
      "skuReference",
      "channelCode",
      "orderType",
      "currencyMetadata",
      "selectedQuantity",
      "itemQuantity",
      "evaluatedAt",
    ]);
    const context = {
      brandReference: parsePricingReference(raw.brandReference),
      storeReference: parsePricingReference(raw.storeReference),
      storeGroupReference: optionalReference(raw.storeGroupReference),
      regionReference: optionalReference(raw.regionReference),
      bindingReference: parsePricingReference(raw.bindingReference),
      optionReference: parsePricingReference(raw.optionReference),
      skuReference: parsePricingReference(raw.skuReference),
      channelCode: parsePricingCode(raw.channelCode),
      currencyMetadata: createCurrencyMetadataSnapshot(
        raw.currencyMetadata as CurrencyMetadataSnapshot,
      ),
      selectedQuantity: quantity(raw.selectedQuantity, 1),
      itemQuantity: quantity(raw.itemQuantity, 1),
      evaluatedAt: instant(raw.evaluatedAt),
      orderType: raw.orderType,
    };
    if (context.orderType !== "DineIn" && context.orderType !== "Pickup") return invalid();
    const rules = values.map(createOptionPriceRuleSnapshot);
    if (new Set(rules.map((rule) => rule.ruleReference)).size !== rules.length)
      throw new OptionPriceError("OPTION_PRICE_CONFLICT");
    const matches = rules
      .filter((rule) => {
        const scope =
          rule.scopeKind === "Brand"
            ? null
            : rule.scopeKind === "Store"
              ? context.storeReference
              : rule.scopeKind === "StoreGroup"
                ? context.storeGroupReference
                : context.regionReference;
        return (
          rule.lifecycle === "Published" &&
          rule.brandReference === context.brandReference &&
          rule.bindingReference === context.bindingReference &&
          rule.optionReference === context.optionReference &&
          (rule.skuReference === null || rule.skuReference === context.skuReference) &&
          rule.scopeReference === scope &&
          (rule.channelCode === null || rule.channelCode === context.channelCode) &&
          (rule.orderType === null || rule.orderType === context.orderType) &&
          rule.effectivePeriod.effectiveFrom.instant <= context.evaluatedAt &&
          (rule.effectivePeriod.effectiveUntil === null ||
            context.evaluatedAt < rule.effectivePeriod.effectiveUntil.instant)
        );
      })
      .map((rule) => ({
        rule,
        priority:
          { Store: 1, StoreGroup: 3, Region: 5, Brand: 7 }[rule.scopeKind] +
          (rule.channelCode === null && rule.orderType === null ? 1 : 0),
      }))
      .sort((a, b) => a.priority - b.priority);
    const selected = matches[0];
    if (selected === undefined) throw new OptionPriceError("OPTION_PRICE_MISSING");
    if (matches.filter((match) => match.priority === selected.priority).length !== 1)
      throw new OptionPriceError("OPTION_PRICE_CONFLICT");
    const rule = selected.rule;
    if (
      rule.createdAt > context.evaluatedAt ||
      JSON.stringify(rule.currencyMetadata) !== JSON.stringify(context.currencyMetadata)
    )
      throw new OptionPriceError("OPTION_PRICE_SCOPE_MISMATCH");
    const chargedQuantityPerItem = Math.max(0, context.selectedQuantity - rule.includedQuantity);
    const chargedQuantity = BigInt(chargedQuantityPerItem) * BigInt(context.itemQuantity);
    let amount: Money;
    try {
      amount = createMoney({
        amountMinor: rule.unitAmount.amountMinor * chargedQuantity,
        currencyCode: rule.unitAmount.currencyCode,
      });
    } catch {
      throw new OptionPriceError("OPTION_PRICE_CALCULATION_FAILED");
    }
    return Object.freeze({
      rule,
      context: Object.freeze({ ...context, orderType: context.orderType }),
      priority: selected.priority,
      skuReference: context.skuReference,
      selectedQuantity: context.selectedQuantity,
      itemQuantity: context.itemQuantity,
      chargedQuantityPerItem,
      chargedQuantity,
      amount,
      evaluatedAt: context.evaluatedAt,
    });
  } catch (error) {
    if (error instanceof OptionPriceError) throw error;
    return invalid();
  }
}

/** Checks all current Published heads before a new head is installed. The owning
 * writer supplies a complete serialized read; this pure check is not authority. */
export function assertOptionPricePublicationUnambiguous(
  candidateValue: OptionPriceRuleSnapshot,
  currentValues: readonly OptionPriceRuleSnapshot[],
): void {
  try {
    const candidate = createOptionPriceRuleSnapshot(candidateValue);
    if (candidate.lifecycle !== "Published") return invalid();
    if (
      !Array.isArray(currentValues) ||
      Object.getPrototypeOf(currentValues) !== Array.prototype ||
      currentValues.length > 1000 ||
      Reflect.ownKeys(currentValues).length !== currentValues.length + 1
    )
      return invalid();
    const priority = (rule: OptionPriceRuleSnapshot) =>
      ({ Store: 1, StoreGroup: 3, Region: 5, Brand: 7 })[rule.scopeKind] +
      (rule.channelCode === null && rule.orderType === null ? 1 : 0);
    const overlap = (a: string | null, b: string | null) => a === null || b === null || a === b;
    const ids = new Set<string>();
    for (let index = 0; index < currentValues.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(currentValues, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
      const current = createOptionPriceRuleSnapshot(descriptor.value);
      if (ids.has(current.ruleReference)) throw new OptionPriceError("OPTION_PRICE_CONFLICT");
      ids.add(current.ruleReference);
      if (
        current.lifecycle !== "Published" ||
        current.ruleReference === candidate.ruleReference ||
        current.brandReference !== candidate.brandReference ||
        current.bindingReference !== candidate.bindingReference ||
        current.optionReference !== candidate.optionReference ||
        current.scopeKind !== candidate.scopeKind ||
        current.scopeReference !== candidate.scopeReference ||
        priority(current) !== priority(candidate) ||
        !overlap(current.skuReference, candidate.skuReference) ||
        !overlap(current.channelCode, candidate.channelCode) ||
        !overlap(current.orderType, candidate.orderType)
      )
        continue;
      const a = candidate.effectivePeriod,
        b = current.effectivePeriod;
      if (
        (a.effectiveUntil === null || b.effectiveFrom.instant < a.effectiveUntil.instant) &&
        (b.effectiveUntil === null || a.effectiveFrom.instant < b.effectiveUntil.instant)
      )
        throw new OptionPriceError("OPTION_PRICE_CONFLICT");
    }
  } catch (error) {
    if (error instanceof OptionPriceError) throw error;
    return invalid();
  }
}
