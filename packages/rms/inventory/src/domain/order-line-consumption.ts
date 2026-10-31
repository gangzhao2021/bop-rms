import {
  advanceInventoryReservation,
  InventoryReservationError,
  parseInventoryReservation,
  type InventoryReservation,
} from "./inventory-reservation.js";
import { parseInventoryInstant, parseInventoryReference } from "./inventory-item.js";

/** WP-2423 / Section 30.6: per-Order-line Inventory effects of Kitchen progress. */
export interface OrderLineReservation {
  readonly accountReference: string;
  readonly reservation: InventoryReservation;
}
export interface OrderLineInventoryEffect {
  readonly accountReference: string;
  readonly action: "StartProduction" | "Consume";
  readonly quantity: string | null;
  readonly expectedReservationVersion: number;
  readonly reservation: InventoryReservation;
}
const invalid = (): never => {
  throw new InventoryReservationError("INVENTORY_RESERVATION_INVALID");
};
const micro = (value: string) => {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(6, "0"));
};
const decimal = (value: bigint) => {
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return (value / 1_000_000n).toString() + (fraction ? "." + fraction : "");
};

/**
 * Pure plan for one Order line. `Start` locks every reservation of the line against release.
 * `Progress` consumes the cumulative share completed/required of each reservation, rounded down to
 * its ledger quantum, and the full remainder when the line is complete. The plan is derived from
 * current reservation state, so a replayed or reordered Kitchen event yields no further effect.
 */
export function planOrderLineKitchenEffects(input: {
  readonly cartItemReference: string;
  readonly reservations: readonly OrderLineReservation[];
  readonly kitchen:
    | { readonly kind: "Start" }
    | {
        readonly kind: "Progress";
        readonly completedQuantity: number;
        readonly requiredQuantity: number;
      };
  readonly occurredAt: string;
}): readonly OrderLineInventoryEffect[] {
  const line = parseInventoryReference(input.cartItemReference);
  const occurredAt = parseInventoryInstant(input.occurredAt);
  const kitchen = input.kitchen;
  if (
    kitchen.kind === "Progress" &&
    (!Number.isSafeInteger(kitchen.requiredQuantity) ||
      !Number.isSafeInteger(kitchen.completedQuantity) ||
      kitchen.requiredQuantity < 1 ||
      kitchen.completedQuantity < 0 ||
      kitchen.completedQuantity > kitchen.requiredQuantity)
  )
    return invalid();
  const effects: OrderLineInventoryEffect[] = [];
  for (const entry of input.reservations) {
    const accountReference = parseInventoryReference(entry.accountReference);
    let current = parseInventoryReservation(entry.reservation);
    if (current.schemaVersion !== 2 || current.binding.cartItemReference !== line) return invalid();
    if (current.remainingQuantity === "0") continue;
    if (current.productionStartedAt === null) {
      // Production begins on Start, or implicitly on the first recorded progress.
      const started = advanceInventoryReservation(current, {
        reservationReference: current.reservationReference,
        binding: current.binding,
        expectedVersion: current.version,
        action: "StartProduction",
        quantity: null,
        occurredAt,
      });
      effects.push(
        Object.freeze({
          accountReference,
          action: "StartProduction",
          quantity: null,
          expectedReservationVersion: current.version,
          reservation: started,
        }),
      );
      current = started;
    }
    if (kitchen.kind !== "Progress") continue;
    const quantum = 10n ** BigInt(6 - current.unit.ledgerPrecision);
    const original = micro(current.originalQuantity) - micro(current.releasedQuantity);
    const target =
      kitchen.completedQuantity === kitchen.requiredQuantity
        ? original
        : ((original * BigInt(kitchen.completedQuantity)) /
            BigInt(kitchen.requiredQuantity) /
            quantum) *
          quantum;
    const delta = target - micro(current.consumedQuantity);
    if (delta <= 0n) continue;
    const consumed = advanceInventoryReservation(current, {
      reservationReference: current.reservationReference,
      binding: current.binding,
      expectedVersion: current.version,
      action: "Consume",
      quantity: decimal(delta),
      occurredAt,
    });
    effects.push(
      Object.freeze({
        accountReference,
        action: "Consume",
        quantity: decimal(delta),
        expectedReservationVersion: current.version,
        reservation: consumed,
      }),
    );
  }
  return Object.freeze(effects);
}
