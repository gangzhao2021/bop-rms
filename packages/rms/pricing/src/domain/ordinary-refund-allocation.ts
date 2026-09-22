import {
  createMoney,
  parseCurrencyCode,
  parseAmountMinor,
  parsePricingCode,
  parsePricingDigest,
  parsePricingReference,
} from "./money-tax-contract.js";
import { allocateMoney } from "./money-tax.js";

export const ordinaryRefundAllocationVersion = "ORDINARY_REFUND_ALLOCATION_V1" as const;
const fail = (): never => {
  throw new Error("ORDINARY_REFUND_ALLOCATION_INVALID");
};
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return fail();
  const fields = Reflect.ownKeys(value);
  if (
    fields.length !== keys.length ||
    fields.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail();
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property?.enumerable || !("value" in property)) return fail();
    copy[key] = property.value;
  }
  return copy;
}
function nonnegative(value: unknown): bigint {
  const amount = parseAmountMinor(value);
  if (amount < 0n) return fail();
  return amount;
}
function quantity(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > 999)
    return fail();
  return value;
}

/** Original captured Pricing source only. Caller supplies complete immutable lines
 * and occupied original unit ordinals, and binds the result to a durable claim.
 * No browser amount or remaining-line repricing is accepted as authority.
 */
export function allocateOrdinaryRefund(value: unknown) {
  try {
    const raw = exact(value, [
      "sourceReference",
      "sourceDigest",
      "currencyCode",
      "tipAmountMinor",
      "serviceChargeAmountMinor",
      "serviceChargeTaxAmountMinor",
      "items",
    ]);
    const sourceReference = parsePricingReference(raw.sourceReference);
    const sourceDigest = parsePricingDigest(raw.sourceDigest);
    if (
      raw.currencyCode !== "CAD" ||
      !Array.isArray(raw.items) ||
      raw.items.length < 1 ||
      raw.items.length > 1000
    )
      return fail();
    const tip = nonnegative(raw.tipAmountMinor);
    const serviceCharge = nonnegative(raw.serviceChargeAmountMinor);
    const serviceChargeTax = nonnegative(raw.serviceChargeTaxAmountMinor);
    const seen = new Set<string>();
    const items = raw.items
      .map((value) => {
        const item = exact(value, [
          "orderItemReference",
          "quantity",
          "netAmountMinor",
          "taxAmountMinor",
          "occupiedUnitOrdinals",
          "refundQuantity",
        ]);
        const reference = parsePricingReference(item.orderItemReference);
        if (seen.has(reference)) return fail();
        seen.add(reference);
        const originalQuantity = quantity(item.quantity, 1);
        if (
          !Array.isArray(item.occupiedUnitOrdinals) ||
          item.occupiedUnitOrdinals.length > originalQuantity
        )
          return fail();
        const occupied = new Set(item.occupiedUnitOrdinals.map((value) => quantity(value, 1)));
        if (
          occupied.size !== item.occupiedUnitOrdinals.length ||
          [...occupied].some((ordinal) => ordinal > originalQuantity)
        )
          return fail();
        const previousQuantity = occupied.size;
        const refundQuantity = quantity(item.refundQuantity);
        if (previousQuantity + refundQuantity > originalQuantity) return fail();
        return {
          orderItemReference: reference,
          allocationKey: parsePricingCode("ITEM_" + reference.replaceAll("-", "").toUpperCase()),
          quantity: originalQuantity,
          occupiedQuantity: previousQuantity,
          refundUnitOrdinals: Object.freeze(
            Array.from({ length: originalQuantity }, (_, index) => index + 1)
              .filter((ordinal) => !occupied.has(ordinal))
              .slice(0, refundQuantity),
          ),
          refundQuantity,
          netAmountMinor: nonnegative(item.netAmountMinor),
          taxAmountMinor: nonnegative(item.taxAmountMinor),
        };
      })
      .sort((a, b) => a.allocationKey.localeCompare(b.allocationKey, "en"));
    if (!items.some((item) => item.refundQuantity > 0)) return fail();
    const netTotal = items.reduce((sum, item) => sum + item.netAmountMinor, 0n);
    const shares = items.map((item) => ({
      allocationKey: item.allocationKey,
      weight: netTotal > 0n ? item.netAmountMinor : BigInt(item.quantity),
    }));
    const split = (total: bigint) =>
      new Map(
        allocateMoney(
          createMoney({ amountMinor: total, currencyCode: parseCurrencyCode("CAD") }),
          shares,
        ).map((entry) => [String(entry.allocationKey), entry.amount.amountMinor]),
      );
    const tips = split(tip),
      fees = split(serviceCharge),
      feeTaxes = split(serviceChargeTax);
    const results = items.map((item) => {
      const originalTip = tips.get(item.allocationKey),
        originalFee = fees.get(item.allocationKey),
        originalFeeTax = feeTaxes.get(item.allocationKey);
      if (originalTip === undefined || originalFee === undefined || originalFeeTax === undefined)
        return fail();
      const entitlement = (amount: bigint, count: number) =>
        (amount * BigInt(count)) / BigInt(item.quantity);
      const delta = (amount: bigint) =>
        item.refundUnitOrdinals.reduce(
          (sum, ordinal) => sum + entitlement(amount, ordinal) - entitlement(amount, ordinal - 1),
          0n,
        );
      const components = Object.freeze({
        netAmountMinor: delta(item.netAmountMinor),
        taxAmountMinor: delta(item.taxAmountMinor),
        tipAmountMinor: delta(originalTip),
        serviceChargeAmountMinor: delta(originalFee),
        serviceChargeTaxAmountMinor: delta(originalFeeTax),
      });
      const amountMinor = Object.values(components).reduce((sum, value) => sum + value, 0n);
      return Object.freeze({
        orderItemReference: item.orderItemReference,
        refundQuantity: item.refundQuantity,
        refundUnitOrdinals: item.refundUnitOrdinals,
        occupiedQuantityAfter: item.occupiedQuantity + item.refundQuantity,
        components,
        amountMinor: nonnegative(amountMinor),
      });
    });
    return Object.freeze({
      algorithmVersion: ordinaryRefundAllocationVersion,
      sourceReference,
      sourceDigest,
      currencyCode: "CAD" as const,
      zeroNetWeighting: netTotal === 0n ? ("Quantity" as const) : ("NetAmount" as const),
      items: Object.freeze(results),
      amountMinor: nonnegative(results.reduce((sum, item) => sum + item.amountMinor, 0n)),
    });
  } catch {
    return fail();
  }
}
