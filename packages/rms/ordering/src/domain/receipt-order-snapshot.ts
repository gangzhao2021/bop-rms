import { parseOrderingReference, parseOrderingInstant } from "./cart.js";
import {
  parseOrderItemTransactionSnapshot,
  parseConfiguredOrderItemTransactionSnapshot,
} from "./order-item-snapshot.js";
import { DigitalReceiptError } from "./digital-receipt.js";

const fail = (): never => {
  throw new DigitalReceiptError("DIGITAL_RECEIPT_INPUT_INVALID");
};
function closed(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const entries = fields.map((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    return [field, descriptor.value] as const;
  });
  return Object.fromEntries(entries) as Record<string, unknown>;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    return descriptor.value as unknown;
  });
}
/** Frozen whole-order receipt facts; not a claim of payment, closure or authority.
 * The owner reader must fence the complete current batch/item set through append.
 */
export function parseReceiptOrderSnapshot(value: unknown) {
  try {
    const raw = closed(value, [
      "orderReference",
      "brandReference",
      "storeReference",
      "guestSessionReference",
      "orderNumber",
      "createdAt",
      "batches",
      "items",
    ]);
    const orderReference = parseOrderingReference(raw.orderReference);
    const brandReference = parseOrderingReference(raw.brandReference);
    const storeReference = parseOrderingReference(raw.storeReference);
    const guestSessionReference = parseOrderingReference(raw.guestSessionReference);
    const createdAt = parseOrderingInstant(raw.createdAt);
    if (
      typeof raw.orderNumber !== "string" ||
      raw.orderNumber.length < 1 ||
      raw.orderNumber.length > 80 ||
      Array.from(raw.orderNumber).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      return fail();
    const batches = array(raw.batches, 100).map((value) => {
      const batch = closed(value, ["orderBatchReference", "submittedAt"]);
      const submittedAt = parseOrderingInstant(batch.submittedAt);
      if (submittedAt < createdAt) return fail();
      return Object.freeze({
        orderBatchReference: parseOrderingReference(batch.orderBatchReference),
        submittedAt,
      });
    });
    const identities = new Set([
      orderReference,
      ...batches.map((batch) => batch.orderBatchReference),
    ]);
    if (identities.size !== batches.length + 1) return fail();
    const items = array(raw.items, 100).map((value) => {
      const entry = closed(value, ["snapshotVersion", "snapshot"]);
      if (entry.snapshotVersion !== 1 && entry.snapshotVersion !== 2) return fail();
      const snapshot =
        entry.snapshotVersion === 2
          ? parseConfiguredOrderItemTransactionSnapshot(entry.snapshot)
          : parseOrderItemTransactionSnapshot(entry.snapshot);
      const batch = batches.find(
        (batch) => batch.orderBatchReference === snapshot.orderBatchReference,
      );
      if (
        !batch ||
        identities.has(snapshot.orderItemReference) ||
        snapshot.catalog.brandReference !== brandReference ||
        snapshot.catalog.storeReference !== storeReference ||
        snapshot.snapshotCapturedAt > batch.submittedAt
      )
        return fail();
      identities.add(snapshot.orderItemReference);
      return Object.freeze({ snapshotVersion: entry.snapshotVersion, snapshot });
    });
    if (
      batches.some(
        (batch) =>
          !items.some((item) => item.snapshot.orderBatchReference === batch.orderBatchReference),
      )
    )
      return fail();
    return Object.freeze({
      orderReference,
      brandReference,
      storeReference,
      guestSessionReference,
      orderNumber: raw.orderNumber,
      createdAt,
      batches: Object.freeze(batches),
      items: Object.freeze(items),
    });
  } catch {
    return fail();
  }
}
export type ReceiptOrderSnapshot = ReturnType<typeof parseReceiptOrderSnapshot>;
