import {
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type OrderingHash,
  type OrderingInstant,
  type OrderingReference,
} from "./cart.js";
import type { OrderCreationRecord } from "./order-creation.js";
import type { CheckoutValidationEvidence } from "./checkout-validation.js";

export class OrderCapacityLinkError extends Error {
  readonly code = "ORDER_CAPACITY_LINK_INVALID";
  constructor() {
    super("order capacity linkage is invalid");
    this.name = "OrderCapacityLinkError";
  }
}
export interface OrderCapacityLink {
  readonly owner: "Dining" | "Fulfillment";
  readonly commitmentReference: OrderingReference;
  readonly commitmentVersion: 1;
  readonly ownerContextReference: OrderingReference;
  readonly ownerIntentDigest: OrderingHash;
  readonly ownerSnapshotDigest: OrderingHash;
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly orderReference: OrderingReference;
  readonly orderBatchReference: OrderingReference;
  readonly submissionReference: OrderingReference;
  readonly cartReference: OrderingReference;
  readonly cartVersion: number;
  readonly quoteReference: OrderingReference;
  readonly guestSessionReference: OrderingReference;
  readonly paymentOperationReference: OrderingReference;
  readonly preparedAt: OrderingInstant;
  readonly validUntil: OrderingInstant;
}
const referenceKeys = [
  "commitmentReference",
  "ownerContextReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "orderBatchReference",
  "submissionReference",
  "cartReference",
  "quoteReference",
  "guestSessionReference",
  "paymentOperationReference",
] as const;
const keys = [
  ...referenceKeys,
  "owner",
  "commitmentVersion",
  "cartVersion",
  "ownerIntentDigest",
  "ownerSnapshotDigest",
  "preparedAt",
  "validUntil",
] as const;
function invalid(): never {
  throw new OrderCapacityLinkError();
}
/** A closed owner-link receipt, not independent proof that the referenced owner fact exists. */
export function parseOrderCapacityLink(value: unknown): OrderCapacityLink {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const actual = Reflect.ownKeys(value);
    if (
      actual.length !== keys.length ||
      actual.some((k) => typeof k !== "string" || !keys.includes(k as never))
    )
      return invalid();
    const raw: Record<string, unknown> = {};
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d?.enumerable || !("value" in d)) return invalid();
      raw[key] = d.value;
    }
    if (
      (raw.owner !== "Dining" && raw.owner !== "Fulfillment") ||
      raw.commitmentVersion !== 1 ||
      !Number.isSafeInteger(raw.cartVersion) ||
      (raw.cartVersion as number) < 1
    )
      return invalid();
    const preparedAt = parseOrderingInstant(raw.preparedAt),
      validUntil = parseOrderingInstant(raw.validUntil);
    if (preparedAt >= validUntil) return invalid();
    return Object.freeze({
      ...(Object.fromEntries(
        referenceKeys.map((k) => [k, parseOrderingReference(raw[k])]),
      ) as Record<(typeof referenceKeys)[number], OrderingReference>),
      owner: raw.owner,
      commitmentVersion: 1,
      cartVersion: raw.cartVersion as number,
      ownerIntentDigest: parseOrderingHash(raw.ownerIntentDigest),
      ownerSnapshotDigest: parseOrderingHash(raw.ownerSnapshotDigest),
      preparedAt,
      validUntil,
    });
  } catch {
    return invalid();
  }
}
export function assertOrderCapacityLinkMatches(
  link: OrderCapacityLink,
  record: Pick<
    OrderCreationRecord,
    "order" | "submissionReference" | "guestSessionReference" | "createdAt"
  >,
  evidence?: CheckoutValidationEvidence<1 | 2>,
): void {
  const b = record.order.batches[0];
  if (
    (link.owner === "Dining"
      ? record.order.orderType !== "DineIn" ||
        record.order.diningSessionReference !== link.ownerContextReference
      : link.owner !== "Fulfillment" ||
        record.order.orderType !== "Pickup" ||
        record.order.diningSessionReference !== null) ||
    record.order.brandReference !== link.brandReference ||
    record.order.storeReference !== link.storeReference ||
    record.order.orderReference !== link.orderReference ||
    b.orderBatchReference !== link.orderBatchReference ||
    record.submissionReference !== link.submissionReference ||
    b.submissionReference !== link.submissionReference ||
    b.sourceCartReference !== link.cartReference ||
    b.sourceCartVersion !== link.cartVersion ||
    b.quoteReference !== link.quoteReference ||
    record.guestSessionReference !== link.guestSessionReference ||
    record.createdAt < link.preparedAt ||
    record.createdAt >= link.validUntil
  )
    return invalid();
  if (
    evidence !== undefined &&
    (evidence.fulfillment.evidenceReference !== link.commitmentReference ||
      evidence.fulfillment.evidenceVersion !== link.commitmentVersion ||
      evidence.fulfillment.evidenceDigest !== link.ownerSnapshotDigest ||
      evidence.fulfillment.checkedAt < link.preparedAt ||
      evidence.fulfillment.validUntil > link.validUntil ||
      evidence.validUntil > link.validUntil)
  )
    return invalid();
}
