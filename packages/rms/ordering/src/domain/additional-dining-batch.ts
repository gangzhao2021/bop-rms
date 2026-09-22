import {
  parseCheckoutValidationEvidence,
  parseConfiguredCheckoutValidationEvidence,
} from "./checkout-validation.js";
import { parseCartAggregate, parseOrderingReference, parseOrderingInstant } from "./cart.js";
import { parseOrderBatch } from "./order.js";
import {
  createOrderItemSnapshots,
  createConfiguredOrderItemSnapshots,
  type CreateOrderItemSnapshotsInput,
  parseOrderItemTransactionSnapshot,
  parseConfiguredOrderItemTransactionSnapshot,
} from "./order-item-snapshot.js";
export class AdditionalDiningBatchError extends Error {
  readonly code = "ADDITIONAL_DINING_BATCH_INPUT_INVALID";
  constructor() {
    super("additional Dining batch snapshot is invalid");
    this.name = "AdditionalDiningBatchError";
  }
}
const fail = (): never => {
  throw new AdditionalDiningBatchError();
};
function exact(value: unknown, fields: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail();
  return Object.fromEntries(
    fields.map((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
      return [field, descriptor.value as unknown];
    }),
  );
}
function items(value: unknown) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > 100 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    return descriptor.value as unknown;
  });
}
/** Immutable additional submission facts only. Writer must independently fence
 * current Order version, active Dining Session/Host, Checkout, Inventory and payment
 * policy. Parsing this record does not authorize adding a Batch.
 */
export function parseAdditionalDiningBatchSnapshot(value: unknown) {
  try {
    const raw = exact(value, [
      "orderReference",
      "brandReference",
      "storeReference",
      "diningSessionReference",
      "guestSessionReference",
      "originalOrderCreatedAt",
      "expectedOrderVersion",
      "batchSequence",
      "snapshotVersion",
      "batch",
      "items",
    ]);
    const orderReference = parseOrderingReference(raw.orderReference);
    const brandReference = parseOrderingReference(raw.brandReference),
      storeReference = parseOrderingReference(raw.storeReference);
    const originalOrderCreatedAt = parseOrderingInstant(raw.originalOrderCreatedAt);
    if (
      typeof raw.expectedOrderVersion !== "number" ||
      !Number.isSafeInteger(raw.expectedOrderVersion) ||
      raw.expectedOrderVersion < 1 ||
      raw.expectedOrderVersion >= 2147483647 ||
      typeof raw.batchSequence !== "number" ||
      !Number.isSafeInteger(raw.batchSequence) ||
      raw.batchSequence < 2 ||
      raw.batchSequence > 2147483647 ||
      (raw.snapshotVersion !== 1 && raw.snapshotVersion !== 2)
    )
      return fail();
    const batch = parseOrderBatch(raw.batch);
    if (batch.orderReference !== orderReference || batch.submittedAt < originalOrderCreatedAt)
      return fail();
    const snapshots = items(raw.items).map((item) =>
      raw.snapshotVersion === 2
        ? parseConfiguredOrderItemTransactionSnapshot(item)
        : parseOrderItemTransactionSnapshot(item),
    );
    if (
      snapshots.length !== batch.items.length ||
      new Set([
        orderReference,
        batch.orderBatchReference,
        ...snapshots.map((item) => item.orderItemReference),
      ]).size !==
        snapshots.length + 2
    )
      return fail();
    snapshots.forEach((item, index) => {
      const identity = batch.items[index];
      if (
        !identity ||
        item.orderItemReference !== identity.orderItemReference ||
        item.cartItemReference !== identity.cartItemReference ||
        item.orderBatchReference !== batch.orderBatchReference ||
        item.catalog.brandReference !== brandReference ||
        item.catalog.storeReference !== storeReference ||
        item.snapshotCapturedAt > batch.submittedAt
      )
        return fail();
    });
    return Object.freeze({
      orderReference,
      brandReference,
      storeReference,
      diningSessionReference: parseOrderingReference(raw.diningSessionReference),
      guestSessionReference: parseOrderingReference(raw.guestSessionReference),
      originalOrderCreatedAt,
      expectedOrderVersion: raw.expectedOrderVersion,
      batchSequence: raw.batchSequence,
      snapshotVersion: raw.snapshotVersion,
      batch,
      items: Object.freeze(snapshots),
    });
  } catch {
    return fail();
  }
}
export type AdditionalDiningBatchSnapshot = ReturnType<typeof parseAdditionalDiningBatchSnapshot>;

/** Constructs new Batch facts from current checkout inputs, never a replacement Order header.
 * The transactional writer remains responsible for current parent/Host/Inventory authority.
 */
export function createAdditionalDiningBatchSnapshot(input: {
  snapshot: CreateOrderItemSnapshotsInput;
  quoteVersion: 1 | 2;
  submissionReference: unknown;
  submittedAt: unknown;
  parent: {
    orderReference: unknown;
    brandReference: unknown;
    storeReference: unknown;
    diningSessionReference: unknown;
    originalOrderCreatedAt: unknown;
    expectedOrderVersion: unknown;
    batchSequence: unknown;
  };
}): AdditionalDiningBatchSnapshot {
  if (input.quoteVersion !== 1 && input.quoteVersion !== 2) return fail();
  const evidence =
    input.quoteVersion === 2
      ? parseConfiguredCheckoutValidationEvidence(input.snapshot.checkoutValidationEvidence)
      : parseCheckoutValidationEvidence(input.snapshot.checkoutValidationEvidence);
  const cart = parseCartAggregate(input.snapshot.cart);
  const orderReference = parseOrderingReference(input.parent.orderReference);
  const diningSessionReference = parseOrderingReference(input.parent.diningSessionReference);
  const submittedAt = parseOrderingInstant(input.submittedAt);
  if (
    evidence.orderType !== "DineIn" ||
    cart.orderType !== "DineIn" ||
    cart.diningSessionReference !== diningSessionReference ||
    parseOrderingReference(input.snapshot.orderReference) !== orderReference ||
    parseOrderingReference(input.parent.brandReference) !== evidence.brandReference ||
    parseOrderingReference(input.parent.storeReference) !== evidence.storeReference ||
    submittedAt < evidence.validatedAt ||
    submittedAt >= evidence.validUntil
  )
    return fail();
  const snapshots =
    input.quoteVersion === 2
      ? createConfiguredOrderItemSnapshots(input.snapshot)
      : createOrderItemSnapshots(input.snapshot);
  const orderBatchReference = parseOrderingReference(input.snapshot.orderBatchReference);
  return parseAdditionalDiningBatchSnapshot({
    ...input.parent,
    orderReference,
    diningSessionReference,
    guestSessionReference: evidence.guestSessionReference,
    snapshotVersion: input.quoteVersion,
    batch: {
      orderBatchReference,
      orderReference,
      submissionReference: parseOrderingReference(input.submissionReference),
      sourceCartReference: evidence.cartReference,
      sourceCartVersion: evidence.cartVersion,
      checkoutValidationReference: evidence.validationReference,
      quoteReference: evidence.quoteReference,
      submittedByActorReference: evidence.guestSessionReference,
      submittedAt,
      items: snapshots.map((item) => ({
        orderBatchReference,
        orderItemReference: item.orderItemReference,
        cartItemReference: item.cartItemReference,
      })),
    },
    items: snapshots,
  });
}
