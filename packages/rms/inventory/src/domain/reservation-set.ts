import { parseInventoryInstant, parseInventoryReference } from "./inventory-item.js";
import {
  advanceInventoryReservation,
  parseInventoryReservation,
  InventoryReservationError,
} from "./inventory-reservation.js";
function fail(): never {
  throw new InventoryReservationError("INVENTORY_RESERVATION_INVALID");
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
/** Complete immutable reserve-at-submission result; authorization and transactional persistence are separate. */
export function parseInventoryReservationSet(value: unknown) {
  const raw = closed(value, [
    "schemaVersion",
    "setReference",
    "operationReference",
    "actorReference",
    "auditReference",
    "workflowReference",
    "workflowVersion",
    "requestDigest",
    "entries",
  ]);
  if (
    raw.schemaVersion !== 1 ||
    !Number.isSafeInteger(raw.workflowVersion) ||
    Number(raw.workflowVersion) < 1 ||
    typeof raw.requestDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(raw.requestDigest) ||
    !Array.isArray(raw.entries) ||
    raw.entries.length < 1 ||
    raw.entries.length > 1000 ||
    Reflect.ownKeys(raw.entries).length !== raw.entries.length + 1
  )
    return fail();
  const used = new Map<string, Set<string>>();
  const entries = [];
  let common: string | undefined;
  for (let index = 0; index < raw.entries.length; index++) {
    const slot = Object.getOwnPropertyDescriptor(raw.entries, String(index));
    if (!slot?.enumerable || !("value" in slot)) return fail();
    const e = closed(slot.value, [
      "accountReference",
      "operationReference",
      "movementReference",
      "auditReference",
      "reservation",
    ]);
    const refs = {
      accountReference: parseInventoryReference(e.accountReference),
      operationReference: parseInventoryReference(e.operationReference),
      movementReference: parseInventoryReference(e.movementReference),
      auditReference: parseInventoryReference(e.auditReference),
    };
    const reservation = parseInventoryReservation(e.reservation),
      b = reservation.binding;
    if (
      reservation.version !== 1 ||
      reservation.productionStartedAt !== null ||
      reservation.originalQuantity !== reservation.remainingQuantity ||
      reservation.releasedQuantity !== "0" ||
      reservation.consumedQuantity !== "0" ||
      reservation.updatedAt !== reservation.createdAt
    )
      return fail();
    const binding = JSON.stringify([
      b.tenantReference,
      b.brandReference,
      b.storeReference,
      b.submissionReference,
      b.cartReference,
      b.cartVersion,
      b.quoteReference,
      b.demandReference,
      b.demandDigest,
      reservation.createdAt,
    ]);
    if (common !== undefined && common !== binding) return fail();
    common = binding;
    for (const [field, reference] of Object.entries({
      ...refs,
      reservationReference: reservation.reservationReference,
    })) {
      const set = used.get(field) ?? new Set<string>();
      if (set.has(reference)) return fail();
      set.add(reference);
      used.set(field, set);
    }
    entries.push(Object.freeze({ ...refs, reservation }));
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    setReference: parseInventoryReference(raw.setReference),
    operationReference: parseInventoryReference(raw.operationReference),
    actorReference: parseInventoryReference(raw.actorReference),
    auditReference: parseInventoryReference(raw.auditReference),
    workflowReference: parseInventoryReference(raw.workflowReference),
    workflowVersion: Number(raw.workflowVersion),
    requestDigest: raw.requestDigest,
    entries: Object.freeze(entries),
  });
}
export type InventoryReservationSet = ReturnType<typeof parseInventoryReservationSet>;

/** Pure complete-submission release candidates. The caller must establish cancellation authority,
 * resolve durable replay first, and persist every candidate atomically under current source fences.
 */
export function planInventoryReservationSetRelease(value: unknown) {
  const raw = closed(value, ["set", "current", "occurredAt"]);
  const set = parseInventoryReservationSet(raw.set);
  const occurredAt = parseInventoryInstant(raw.occurredAt);
  if (
    !Array.isArray(raw.current) ||
    raw.current.length !== set.entries.length ||
    Reflect.ownKeys(raw.current).length !== raw.current.length + 1
  )
    return fail();
  const originals = new Map(
    set.entries.map((entry) => [entry.reservation.reservationReference, entry]),
  );
  const entries = [];
  for (let i = 0; i < raw.current.length; i++) {
    const slot = Object.getOwnPropertyDescriptor(raw.current, String(i));
    if (!slot?.enumerable || !("value" in slot)) return fail();
    const item = closed(slot.value, ["accountReference", "reservation"]);
    const accountReference = parseInventoryReference(item.accountReference);
    const current = parseInventoryReservation(item.reservation);
    const original = originals.get(current.reservationReference);
    if (
      !original ||
      original.accountReference !== accountReference ||
      JSON.stringify(current.binding) !== JSON.stringify(original.reservation.binding) ||
      JSON.stringify(current.unit) !== JSON.stringify(original.reservation.unit) ||
      current.originalQuantity !== original.reservation.originalQuantity ||
      current.createdAt !== original.reservation.createdAt ||
      current.productionStartedAt !== null ||
      current.consumedQuantity !== "0" ||
      current.remainingQuantity === "0"
    )
      return fail();
    originals.delete(current.reservationReference);
    const reservation = advanceInventoryReservation(current, {
      reservationReference: current.reservationReference,
      binding: current.binding,
      expectedVersion: current.version,
      action: "Release",
      quantity: current.remainingQuantity,
      occurredAt,
    });
    entries.push(
      Object.freeze({
        accountReference,
        expectedReservationVersion: current.version,
        quantity: current.remainingQuantity,
        reservation,
      }),
    );
  }
  if (originals.size !== 0) return fail();
  entries.sort((a, b) => {
    const left = a.reservation.binding.itemReference + ":" + a.accountReference;
    const right = b.reservation.binding.itemReference + ":" + b.accountReference;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return Object.freeze({
    setReference: set.setReference,
    occurredAt,
    entries: Object.freeze(entries),
  });
}
