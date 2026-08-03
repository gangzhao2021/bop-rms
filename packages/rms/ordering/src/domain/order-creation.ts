import {
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type OrderingHash,
  type OrderingInstant,
  type OrderingReference,
} from "./cart.js";
import {
  parseOrderItemTransactionSnapshot,
  type OrderItemTransactionSnapshot,
} from "./order-item-snapshot.js";
import { createOrderNumberAllocation, type OrderNumberAllocation } from "./order-number.js";
import { parseOrderAggregate, type OrderAggregate } from "./order.js";

export interface OrderCreationRecord {
  readonly submissionReference: OrderingReference;
  readonly submissionIntentHash: OrderingHash;
  readonly guestSessionReference: OrderingReference;
  readonly order: OrderAggregate;
  readonly items: readonly OrderItemTransactionSnapshot[];
  readonly orderNumberAllocation: OrderNumberAllocation;
  readonly createdAt: OrderingInstant;
}

export type CreateOrderResult =
  | { readonly status: "Created"; readonly record: OrderCreationRecord }
  | { readonly status: "AlreadyCreated"; readonly record: OrderCreationRecord };

export const orderCreationErrorCodes = [
  "ORDER_CREATE_INPUT_INVALID",
  "ORDER_CREATE_PERMISSION_DENIED",
  "ORDER_CREATE_IDEMPOTENCY_CONFLICT",
  "ORDER_CREATE_VALIDATION_EXPIRED",
  "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
] as const;

export type OrderCreationErrorCode = (typeof orderCreationErrorCodes)[number];

export class OrderCreationError extends Error {
  readonly code: OrderCreationErrorCode;

  constructor(code: OrderCreationErrorCode) {
    super("order creation is unavailable");
    this.name = "OrderCreationError";
    this.code = code;
  }
}

function invalid(): never {
  throw new OrderCreationError("ORDER_CREATE_INPUT_INVALID");
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return invalid();
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof OrderCreationError) throw error;
    return invalid();
  }
}

export function parseOrderCreationRecord(value: unknown): OrderCreationRecord {
  const raw = exact(value, [
    "submissionReference",
    "submissionIntentHash",
    "guestSessionReference",
    "order",
    "items",
    "orderNumberAllocation",
    "createdAt",
  ]);
  if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 100) return invalid();
  try {
    const submissionReference = parseOrderingReference(raw.submissionReference);
    const guestSessionReference = parseOrderingReference(raw.guestSessionReference);
    const createdAt = parseOrderingInstant(raw.createdAt);
    const order = parseOrderAggregate(raw.order);
    const items = Object.freeze(raw.items.map(parseOrderItemTransactionSnapshot));
    const allocationRaw = exact(raw.orderNumberAllocation, [
      "orderReference",
      "brandReference",
      "storeReference",
      "businessDate",
      "sequence",
      "orderNumber",
      "allocatedAt",
      "businessDateResolution",
    ]);
    const allocation = createOrderNumberAllocation({
      orderReference: allocationRaw.orderReference,
      allocatedAt: allocationRaw.allocatedAt,
      sequence: allocationRaw.sequence,
      businessDateResolution: allocationRaw.businessDateResolution,
    });
    const batch = order.batches[0];
    const identities = new Map(batch.items.map((item) => [item.orderItemReference, item]));
    if (
      batch.submissionReference !== submissionReference ||
      order.submittedByActorReference !== guestSessionReference ||
      batch.submittedByActorReference !== guestSessionReference ||
      order.createdAt !== createdAt ||
      batch.submittedAt !== createdAt ||
      allocation.orderReference !== order.orderReference ||
      allocation.brandReference !== order.brandReference ||
      allocation.storeReference !== order.storeReference ||
      allocation.allocatedAt !== createdAt ||
      items.length !== identities.size ||
      items.some((item) => {
        const identity = identities.get(item.orderItemReference);
        return (
          identity === undefined ||
          identity.orderBatchReference !== item.orderBatchReference ||
          identity.cartItemReference !== item.cartItemReference ||
          item.orderBatchReference !== batch.orderBatchReference ||
          item.snapshotCapturedAt !== createdAt
        );
      })
    )
      return invalid();
    return Object.freeze({
      submissionReference,
      submissionIntentHash: parseOrderingHash(raw.submissionIntentHash),
      guestSessionReference,
      order,
      items,
      orderNumberAllocation: allocation,
      createdAt,
    });
  } catch (error) {
    if (error instanceof OrderCreationError) throw error;
    return invalid();
  }
}
