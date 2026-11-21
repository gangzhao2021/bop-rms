import {
  parseInventoryReference,
  parseInventoryInstant,
  parseInventoryDecimal,
  parseInventoryUnit,
} from "./inventory-item.js";
import { parseInventoryReservationSet } from "./reservation-set.js";

export class InventoryFinalValidationError extends Error {
  readonly code = "INVENTORY_FINAL_VALIDATION_INVALID";
  constructor() {
    super("Inventory final validation is invalid");
    this.name = "InventoryFinalValidationError";
  }
}
function fail(): never {
  throw new InventoryFinalValidationError();
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
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
function list(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    return d.value;
  });
}
function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) return fail();
  return Number(value);
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) return fail();
  return value;
}
function actionCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u.test(value)) return fail();
  return value;
}
function fixed(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(6, "0"));
}
/**
 * Immutable consistency contract, not authorization or proof of persistence.
 * Deferred is an outstanding configured action, never an implicit Payment approval.
 * The writer must derive all items from current owner sources in the same transaction.
 */
export function parseSubmissionInventoryFinalValidation(value: unknown) {
  try {
    const refs = [
      "validationReference",
      "operationReference",
      "actorReference",
      "auditReference",
      "tenantReference",
      "brandReference",
      "storeReference",
      "orderReference",
      "submissionReference",
      "cartReference",
      "quoteReference",
      "demandReference",
      "workflowReference",
      "workflowVersionReference",
      "transitionReference",
    ] as const;
    const raw = closed(value, [
      "schemaVersion",
      ...refs,
      "cartVersion",
      "workflowVersion",
      "demandDigest",
      "observedAt",
      "items",
      "reservationSet",
    ]);
    if (raw.schemaVersion !== 1) return fail();
    const references = Object.fromEntries(
      refs.map((key) => [key, parseInventoryReference(raw[key])]),
    ) as Readonly<Record<(typeof refs)[number], ReturnType<typeof parseInventoryReference>>>;
    const cartVersion = positiveInteger(raw.cartVersion);
    const workflowVersion = positiveInteger(raw.workflowVersion);
    const demandDigest = digest(raw.demandDigest);
    const observedAt = parseInventoryInstant(raw.observedAt);
    const seen = new Set<string>();
    const items = list(raw.items, 4096).map((value) => {
      const item = closed(value, [
        "itemReference",
        "currentItemVersion",
        "configurationOperationReferences",
        "unit",
        "quantity",
        "stockTrackingEnabled",
        "disposition",
        "deferredActionCode",
      ]);
      const itemReference = parseInventoryReference(item.itemReference);
      if (seen.has(itemReference)) return fail();
      seen.add(itemReference);
      const sourceRefs = list(item.configurationOperationReferences, 4096).map(
        parseInventoryReference,
      );
      if (sourceRefs.length === 0 || new Set(sourceRefs).size !== sourceRefs.length) return fail();
      const unit = parseInventoryUnit(
        closed(item.unit, [
          "unitCode",
          "dimension",
          "displayPrecision",
          "ledgerPrecision",
          "roundingMode",
        ]),
      );
      const quantity = parseInventoryDecimal(item.quantity);
      const amount = fixed(quantity);
      if (
        amount % 10n ** BigInt(6 - unit.ledgerPrecision) !== 0n ||
        typeof item.stockTrackingEnabled !== "boolean"
      )
        return fail();
      const disposition = item.disposition;
      if (!["Reserved", "NotTracked", "ZeroDemand", "Deferred"].includes(String(disposition)))
        return fail();
      const deferredActionCode =
        item.deferredActionCode === null ? null : actionCode(item.deferredActionCode);
      if (
        (disposition === "ZeroDemand") !== (amount === 0n) ||
        (disposition === "NotTracked" && item.stockTrackingEnabled) ||
        ((disposition === "Reserved" || disposition === "Deferred") &&
          !item.stockTrackingEnabled) ||
        (disposition === "Deferred") !== (deferredActionCode !== null)
      )
        return fail();
      return Object.freeze({
        itemReference,
        currentItemVersion: positiveInteger(item.currentItemVersion),
        configurationOperationReferences: Object.freeze(sourceRefs),
        unit,
        quantity,
        stockTrackingEnabled: item.stockTrackingEnabled,
        disposition: disposition as "Reserved" | "NotTracked" | "ZeroDemand" | "Deferred",
        deferredActionCode,
      });
    });
    const reservationSet =
      raw.reservationSet === null ? null : parseInventoryReservationSet(raw.reservationSet);
    const reserved = new Map(
      items
        .filter((item) => item.disposition === "Reserved")
        .map((item) => [item.itemReference, item]),
    );
    if ((reserved.size === 0) !== (reservationSet === null)) return fail();
    if (reservationSet !== null) {
      if (
        reservationSet.actorReference !== references.actorReference ||
        reservationSet.workflowReference !== references.workflowReference ||
        reservationSet.workflowVersion !== workflowVersion
      )
        return fail();
      const totals = new Map<string, bigint>();
      for (const entry of reservationSet.entries) {
        const r = entry.reservation;
        const b = r.binding;
        const item = reserved.get(b.itemReference);
        if (
          !item ||
          (
            [
              "unitCode",
              "dimension",
              "displayPrecision",
              "ledgerPrecision",
              "roundingMode",
            ] as const
          ).some((field) => item.unit[field] !== r.unit[field])
        )
          return fail();
        for (const field of [
          "tenantReference",
          "brandReference",
          "storeReference",
          "submissionReference",
          "cartReference",
          "quoteReference",
          "demandReference",
        ] as const)
          if (b[field] !== references[field]) return fail();
        if (
          b.cartVersion !== cartVersion ||
          b.demandDigest !== demandDigest ||
          r.createdAt !== observedAt
        )
          return fail();
        totals.set(
          b.itemReference,
          (totals.get(b.itemReference) ?? 0n) + fixed(r.originalQuantity),
        );
      }
      for (const [reference, item] of reserved) {
        if (totals.get(reference) !== fixed(item.quantity)) return fail();
      }
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      ...references,
      cartVersion,
      workflowVersion,
      demandDigest,
      observedAt,
      items: Object.freeze(items),
      reservationSet,
    });
  } catch {
    return fail();
  }
}
export type SubmissionInventoryFinalValidation = ReturnType<
  typeof parseSubmissionInventoryFinalValidation
>;
