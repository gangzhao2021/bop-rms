import { parseInventoryUnit } from "./inventory-item.js";
import { ReservationBalanceError } from "./reservation-balance.js";
function fail(): never {
  throw new ReservationBalanceError("INVENTORY_BALANCE_INVALID");
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[field] = d.value;
  }
  return result;
}
function integer(value: unknown, positive: boolean): bigint {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value) ||
    (positive && value === "0")
  )
    return fail();
  return BigInt(value);
}
function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const rest = a % b;
    a = b;
    b = rest;
  }
  return a;
}
/** Quantities are exact fractions of microunits of this pinned Inventory base unit. */
export function calculateRecipeDemandQuantity(value: unknown) {
  const raw = closed(value, ["unit", "quantities"]);
  const unit = parseInventoryUnit(
    closed(raw.unit, [
      "unitCode",
      "dimension",
      "displayPrecision",
      "ledgerPrecision",
      "roundingMode",
    ]),
  );
  if (
    unit.unitCode.length > 32 ||
    !Array.isArray(raw.quantities) ||
    raw.quantities.length > 4096 ||
    Reflect.ownKeys(raw.quantities).length !== raw.quantities.length + 1
  )
    return fail();
  let numerator = 0n,
    denominator = 1n;
  for (let i = 0; i < raw.quantities.length; i++) {
    const slot = Object.getOwnPropertyDescriptor(raw.quantities, String(i));
    if (!slot?.enumerable || !("value" in slot)) return fail();
    const part = closed(slot.value, ["quantityNumerator", "quantityDenominator"]);
    const n = integer(part.quantityNumerator, false),
      d = integer(part.quantityDenominator, true);
    const shared = gcd(denominator, d);
    numerator = numerator * (d / shared) + n * (denominator / shared);
    denominator *= d / shared;
    const divisor = gcd(numerator, denominator);
    numerator /= divisor;
    denominator /= divisor;
    if (numerator.toString().length > 1024 || denominator.toString().length > 1024) return fail();
  }
  const quantum = 10n ** BigInt(6 - unit.ledgerPrecision);
  const divisor = denominator * quantum;
  let ticks = numerator / divisor;
  const remainder = numerator % divisor;
  if (
    unit.roundingMode !== "Down" &&
    (remainder * 2n > divisor ||
      (remainder * 2n === divisor && (unit.roundingMode === "HalfUp" || ticks % 2n === 1n)))
  )
    ticks++;
  const microunits = ticks * quantum;
  const fraction = (microunits % 1000000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return Object.freeze({
    unit,
    quantity: (microunits / 1000000n).toString() + (fraction ? "." + fraction : ""),
    exactMicrounitsNumerator: numerator.toString(),
    exactMicrounitsDenominator: denominator.toString(),
    roundingApplied: remainder !== 0n,
  });
}
