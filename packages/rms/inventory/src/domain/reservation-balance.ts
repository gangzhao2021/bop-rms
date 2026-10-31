import { parseInventoryUnit, type NegativeStockPolicy } from "./inventory-item.js";
import type { StockBalanceSnapshot } from "./stock-movement.js";

export type ReservationBalanceAction =
  "Reserve" | "Release" | "ConsumeReserved" | "ConsumeUnreserved";

/** Required follow-up, never an authorization or a committed movement. */
export type ReservationBalanceControl =
  "None" | "Block" | "ManagerOverrideAndExceptionRequired" | "ExceptionRequired";

export interface ReservationBalanceCalculation {
  readonly action: ReservationBalanceAction;
  readonly quantity: string;
  readonly before: StockBalanceSnapshot;
  readonly after: StockBalanceSnapshot;
  readonly requiredControl: ReservationBalanceControl;
}

export class ReservationBalanceError extends Error {
  constructor(
    readonly code:
      | "INVENTORY_BALANCE_INVALID"
      | "INVENTORY_BALANCE_CONFLICT"
      | "INVENTORY_RESERVATION_QUANTITY_EXCEEDED",
  ) {
    super("Inventory balance calculation failed");
    this.name = "ReservationBalanceError";
  }
}

const scale = 1_000_000n;
const invalid = (): never => {
  throw new ReservationBalanceError("INVENTORY_BALANCE_INVALID");
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return invalid();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
    result[field] = descriptor.value;
  }
  return result;
}
function fixed(value: unknown): bigint {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/u.test(value))
    return invalid();
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const number = BigInt(whole + fraction.padEnd(6, "0"));
  if (negative && number === 0n) return invalid();
  return negative ? -number : number;
}
function decimal(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % scale).toString().padStart(6, "0").replace(/0+$/u, "");
  return (value < 0n ? "-" : "") + (absolute / scale).toString() + (fraction ? "." + fraction : "");
}

/**
 * Pure base-unit arithmetic. The caller must bind the exact owned reservation and stock scope,
 * recheck authorization/policy and atomically commit the resulting ledger movement and Audit.
 */
export function calculateReservationBalance(value: unknown): ReservationBalanceCalculation {
  try {
    const raw = exact(value, [
      "action",
      "quantity",
      "unit",
      "before",
      "expectedVersion",
      "negativeStockPolicy",
    ]);
    if (
      typeof raw.action !== "string" ||
      !["Reserve", "Release", "ConsumeReserved", "ConsumeUnreserved"].includes(raw.action) ||
      typeof raw.negativeStockPolicy !== "string" ||
      !["Block", "ManagerOverride", "AllowWithWarning"].includes(raw.negativeStockPolicy)
    )
      return invalid();
    const unit = parseInventoryUnit(
      exact(raw.unit, [
        "unitCode",
        "dimension",
        "displayPrecision",
        "ledgerPrecision",
        "roundingMode",
      ]),
    );
    const before = exact(raw.before, [
      "onHand",
      "reserved",
      "available",
      "inTransit",
      "unitCode",
      "ledgerVersion",
    ]);
    if (
      !/^[A-Z0-9][A-Z0-9_-]{0,31}$/u.test(unit.unitCode) ||
      before.unitCode !== unit.unitCode ||
      !Number.isSafeInteger(before.ledgerVersion) ||
      Number(before.ledgerVersion) < 1 ||
      Number(before.ledgerVersion) >= Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(raw.expectedVersion) ||
      Number(raw.expectedVersion) < 1
    )
      return invalid();
    if (before.ledgerVersion !== raw.expectedVersion)
      throw new ReservationBalanceError("INVENTORY_BALANCE_CONFLICT");
    const onHand = fixed(before.onHand),
      reserved = fixed(before.reserved),
      available = fixed(before.available),
      inTransit = fixed(before.inTransit),
      quantity = fixed(raw.quantity);
    const quantum = 10n ** BigInt(6 - unit.ledgerPrecision);
    if (
      reserved < 0n ||
      inTransit < 0n ||
      quantity <= 0n ||
      available !== onHand - reserved ||
      [onHand, reserved, available, inTransit, quantity].some((n) => n % quantum !== 0n)
    )
      return invalid();
    const action = raw.action as ReservationBalanceAction;
    if ((action === "Release" || action === "ConsumeReserved") && quantity > reserved)
      throw new ReservationBalanceError("INVENTORY_RESERVATION_QUANTITY_EXCEEDED");
    const nextOnHand =
      onHand - (action === "ConsumeReserved" || action === "ConsumeUnreserved" ? quantity : 0n);
    const nextReserved =
      reserved +
      (action === "Reserve"
        ? quantity
        : action === "Release" || action === "ConsumeReserved"
          ? -quantity
          : 0n);
    const nextAvailable = nextOnHand - nextReserved;
    const control: Record<NegativeStockPolicy, ReservationBalanceControl> = {
      Block: "Block",
      ManagerOverride: "ManagerOverrideAndExceptionRequired",
      AllowWithWarning: "ExceptionRequired",
    };
    const snapshot = (hand: bigint, held: bigint, usable: bigint, version: number) =>
      Object.freeze({
        onHand: decimal(hand),
        reserved: decimal(held),
        available: decimal(usable),
        inTransit: decimal(inTransit),
        unitCode: unit.unitCode,
        ledgerVersion: version,
      }) as StockBalanceSnapshot;
    return Object.freeze({
      action,
      quantity: decimal(quantity),
      before: snapshot(onHand, reserved, available, Number(before.ledgerVersion)),
      after: snapshot(nextOnHand, nextReserved, nextAvailable, Number(before.ledgerVersion) + 1),
      // DEC-INV-COUNT-SHORT (2026-10-18): a posted count may leave stock short against open
      // orders (available below zero). Releasing or consuming what an order already holds never
      // makes that worse, so it needs no control; only a change that lowers availability below
      // zero (a new reservation, consuming unreserved stock) or on-hand below zero does.
      requiredControl:
        nextOnHand < 0n || (nextAvailable < 0n && nextAvailable < available)
          ? control[raw.negativeStockPolicy as NegativeStockPolicy]
          : "None",
    });
  } catch (error) {
    if (error instanceof ReservationBalanceError) throw error;
    return invalid();
  }
}

/**
 * DEC-INV-COUNT-SHORT (2026-10-18): the quantity the kitchen used beyond the counted stock when it
 * finishes a dish whose ingredients an Order already holds, or null when on-hand covers it. A count
 * posted below what open orders hold keeps their reservations; the dish was made, so the stock
 * existed (the count missed it, or supply arrived unrecorded). The ledger records the difference as
 * its own Adjustment before the consumption, for a manager to check with a recount, and on-hand
 * never goes below zero. Exact base-unit decimals; both inputs non-negative, quantity positive.
 */
export function stockUsedBeyondCount(input: {
  readonly onHand: string;
  readonly quantity: string;
}): string | null {
  try {
    const onHand = fixed(input.onHand),
      quantity = fixed(input.quantity);
    if (onHand < 0n || quantity <= 0n) return invalid();
    return onHand >= quantity ? null : decimal(quantity - onHand);
  } catch (error) {
    if (error instanceof ReservationBalanceError) throw error;
    return invalid();
  }
}
