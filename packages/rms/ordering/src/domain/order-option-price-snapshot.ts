import {
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type OrderingHash,
  type OrderingInstant,
  type OrderingReference,
} from "./cart.js";
import type { OrderSnapshotMoney } from "./order-item-snapshot.js";

export interface OrderOptionPriceSnapshot {
  readonly ruleReference: OrderingReference;
  readonly ruleVersionReference: OrderingReference;
  readonly ruleDigest: OrderingHash;
  readonly bindingReference: OrderingReference;
  readonly optionReference: OrderingReference;
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly sellableReference: OrderingReference;
  readonly storeGroupReference: OrderingReference | null;
  readonly regionReference: OrderingReference | null;
  readonly channelCode: string;
  readonly orderType: "DineIn" | "Pickup";
  readonly ruleSkuReference: OrderingReference | null;
  readonly scopeKind: "Brand" | "Region" | "StoreGroup" | "Store";
  readonly scopeReference: OrderingReference | null;
  readonly ruleChannelCode: string | null;
  readonly ruleOrderType: "DineIn" | "Pickup" | null;
  readonly priority: number;
  readonly selectedQuantity: number;
  readonly includedQuantity: number;
  readonly chargedQuantityPerItem: number;
  readonly chargedQuantity: bigint;
  readonly quantityBasis: "PerItemChoice";
  readonly unitPrice: OrderSnapshotMoney;
  readonly subtotal: OrderSnapshotMoney;
  readonly taxBasis: "ParentSellable";
  readonly taxClassificationReference: OrderingReference;
  readonly effectiveFrom: OrderingInstant;
  readonly effectiveUntil: OrderingInstant | null;
  readonly ruleCreatedAt: OrderingInstant;
}
const fields = [
  "ruleReference",
  "ruleVersionReference",
  "ruleDigest",
  "bindingReference",
  "optionReference",
  "brandReference",
  "storeReference",
  "sellableReference",
  "storeGroupReference",
  "regionReference",
  "channelCode",
  "orderType",
  "ruleSkuReference",
  "scopeKind",
  "scopeReference",
  "ruleChannelCode",
  "ruleOrderType",
  "priority",
  "selectedQuantity",
  "includedQuantity",
  "chargedQuantityPerItem",
  "chargedQuantity",
  "quantityBasis",
  "unitPrice",
  "subtotal",
  "taxBasis",
  "taxClassificationReference",
  "effectiveFrom",
  "effectiveUntil",
  "ruleCreatedAt",
] as const;
const fail = (): never => {
  throw new Error("invalid Order Option price snapshot");
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return fail();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail();
  return Object.fromEntries(
    keys.map((key) => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !("value" in d) || !d.enumerable) return fail();
      return [key, d.value];
    }),
  );
}
const ref = (value: unknown) => (value === null ? null : parseOrderingReference(value));
const code = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_-]{0,63}$/u.test(value)) return fail();
  return value;
};
const integer = (value: unknown, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    return fail();
  return value as number;
};
function money(value: unknown, currency: string): OrderSnapshotMoney {
  const raw = closed(value, ["amountMinor", "currencyCode"]);
  if (
    typeof raw.amountMinor !== "bigint" ||
    raw.amountMinor < 0n ||
    raw.amountMinor > 9223372036854775807n ||
    raw.currencyCode !== currency
  )
    return fail();
  return Object.freeze({ amountMinor: raw.amountMinor, currencyCode: currency });
}
/** Exact chosen-rule transaction facts; policy resolution remains Pricing's responsibility. */
export function parseOrderOptionPriceSnapshot(
  value: unknown,
  context: {
    readonly quantity: number;
    readonly currencyCode: string;
    readonly quotedAt: OrderingInstant;
    readonly sellableReference: OrderingReference;
  },
): OrderOptionPriceSnapshot {
  const raw = closed(value, fields);
  const brandReference = parseOrderingReference(raw.brandReference);
  const storeReference = parseOrderingReference(raw.storeReference);
  const sellableReference = parseOrderingReference(raw.sellableReference);
  const storeGroupReference = ref(raw.storeGroupReference),
    regionReference = ref(raw.regionReference);
  const ruleSkuReference = ref(raw.ruleSkuReference),
    scopeReference = ref(raw.scopeReference);
  const channelCode = code(raw.channelCode);
  const ruleChannelCode = raw.ruleChannelCode === null ? null : code(raw.ruleChannelCode);
  if (
    !["DineIn", "Pickup"].includes(String(raw.orderType)) ||
    ![null, "DineIn", "Pickup"].includes(raw.ruleOrderType as string | null) ||
    raw.quantityBasis !== "PerItemChoice" ||
    raw.taxBasis !== "ParentSellable" ||
    sellableReference !== context.sellableReference ||
    (ruleSkuReference !== null && ruleSkuReference !== sellableReference) ||
    (ruleChannelCode !== null && ruleChannelCode !== channelCode) ||
    (raw.ruleOrderType !== null && raw.ruleOrderType !== raw.orderType)
  )
    return fail();
  const scopeKind = raw.scopeKind as OrderOptionPriceSnapshot["scopeKind"];
  const scopeRanks = { Store: 0, StoreGroup: 2, Region: 4, Brand: 6 };
  if (
    !Object.hasOwn(scopeRanks, scopeKind) ||
    (scopeKind === "Brand" && scopeReference !== null) ||
    (scopeKind === "Store" && scopeReference !== storeReference) ||
    (scopeKind === "StoreGroup" &&
      (scopeReference === null || scopeReference !== storeGroupReference)) ||
    (scopeKind === "Region" && (scopeReference === null || scopeReference !== regionReference))
  )
    return fail();
  const priority =
    scopeRanks[scopeKind] + (ruleChannelCode !== null || raw.ruleOrderType !== null ? 1 : 2);
  if (raw.priority !== priority) return fail();
  const selectedQuantity = integer(raw.selectedQuantity, 1, 999);
  const includedQuantity = integer(raw.includedQuantity, 0, 2147483647);
  const chargedQuantityPerItem = Math.max(selectedQuantity - includedQuantity, 0);
  const chargedQuantity = BigInt(chargedQuantityPerItem) * BigInt(context.quantity);
  const unitPrice = money(raw.unitPrice, context.currencyCode),
    subtotal = money(raw.subtotal, context.currencyCode);
  if (
    raw.chargedQuantityPerItem !== chargedQuantityPerItem ||
    raw.chargedQuantity !== chargedQuantity ||
    subtotal.amountMinor !== unitPrice.amountMinor * chargedQuantity
  )
    return fail();
  const effectiveFrom = parseOrderingInstant(raw.effectiveFrom);
  const effectiveUntil =
    raw.effectiveUntil === null ? null : parseOrderingInstant(raw.effectiveUntil);
  const ruleCreatedAt = parseOrderingInstant(raw.ruleCreatedAt);
  if (
    ruleCreatedAt > context.quotedAt ||
    effectiveFrom > context.quotedAt ||
    (effectiveUntil !== null &&
      (effectiveUntil <= effectiveFrom || context.quotedAt >= effectiveUntil))
  )
    return fail();
  return Object.freeze({
    ruleReference: parseOrderingReference(raw.ruleReference),
    ruleVersionReference: parseOrderingReference(raw.ruleVersionReference),
    ruleDigest: parseOrderingHash(raw.ruleDigest),
    bindingReference: parseOrderingReference(raw.bindingReference),
    optionReference: parseOrderingReference(raw.optionReference),
    brandReference,
    storeReference,
    sellableReference,
    storeGroupReference,
    regionReference,
    channelCode,
    orderType: raw.orderType as "DineIn" | "Pickup",
    ruleSkuReference,
    scopeKind,
    scopeReference,
    ruleChannelCode,
    ruleOrderType: raw.ruleOrderType as "DineIn" | "Pickup" | null,
    priority,
    selectedQuantity,
    includedQuantity,
    chargedQuantityPerItem,
    chargedQuantity,
    quantityBasis: "PerItemChoice",
    unitPrice,
    subtotal,
    taxBasis: "ParentSellable",
    taxClassificationReference: parseOrderingReference(raw.taxClassificationReference),
    effectiveFrom,
    effectiveUntil,
    ruleCreatedAt,
  });
}
