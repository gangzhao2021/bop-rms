import { canonicalizeRfc8785 } from "@bop/audit";
import { parseInventoryInstant, parseInventoryReference } from "../domain/inventory-item.js";
import { parseInventoryItemSnapshot } from "../domain/inventory-item-snapshot.js";
import { parseInventoryReservation } from "../domain/inventory-reservation.js";
import { parseSubmissionInventoryFinalValidation } from "../domain/submission-final-validation.js";

/**
 * Explicit prerequisite for workflows requiring intact reservations at payment.
 * Not a default timing policy or authorization. Caller supplies fenced current owner facts
 * and separately checks current publication, lot/expiry, capacity and access.
 */
export function evaluateIntactReservationPaymentRule(
  input: Readonly<{
    record: unknown;
    observedAt: unknown;
    items: readonly unknown[];
    reservations: readonly Readonly<{ accountReference: unknown; reservation: unknown }>[];
  }>,
): boolean {
  try {
    const record = parseSubmissionInventoryFinalValidation(input.record);
    const observedAt = parseInventoryInstant(input.observedAt);
    if (record.observedAt > observedAt || input.items.length !== record.items.length) return false;
    const items = input.items.map(parseInventoryItemSnapshot);
    if (new Set(items.map((item) => item.itemReference)).size !== items.length) return false;
    for (const required of record.items) {
      const item = items.find((candidate) => candidate.itemReference === required.itemReference);
      if (
        !item ||
        item.lifecycle !== "Active" ||
        item.tenantReference !== record.tenantReference ||
        item.brandReference !== record.brandReference ||
        item.aggregateVersion < required.currentItemVersion ||
        item.updatedAt > observedAt ||
        item.trackingPolicy.stockTrackingEnabled !== required.stockTrackingEnabled ||
        canonicalizeRfc8785(item.baseUnit) !== canonicalizeRfc8785(required.unit) ||
        required.disposition === "Deferred"
      )
        return false;
    }
    const originals = record.reservationSet?.entries ?? [];
    if (input.reservations.length !== originals.length) return false;
    const current = input.reservations.map((entry) => ({
      accountReference: parseInventoryReference(entry.accountReference),
      reservation: parseInventoryReservation(entry.reservation),
    }));
    if (
      new Set(current.map((entry) => entry.reservation.reservationReference)).size !==
      current.length
    )
      return false;
    for (const original of originals) {
      const entry = current.find(
        (candidate) =>
          candidate.reservation.reservationReference === original.reservation.reservationReference,
      );
      if (!entry) return false;
      const reservation = entry.reservation;
      if (
        entry.accountReference !== original.accountReference ||
        reservation.version < original.reservation.version ||
        reservation.updatedAt > observedAt ||
        canonicalizeRfc8785(reservation.binding) !==
          canonicalizeRfc8785(original.reservation.binding) ||
        canonicalizeRfc8785(reservation.unit) !== canonicalizeRfc8785(original.reservation.unit) ||
        reservation.originalQuantity !== original.reservation.originalQuantity ||
        reservation.remainingQuantity !== reservation.originalQuantity ||
        reservation.releasedQuantity !== "0" ||
        reservation.consumedQuantity !== "0"
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
