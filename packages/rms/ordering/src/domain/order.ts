import {
  parseOrderingInstant,
  parseOrderingReference,
  type CartOrderType,
  type CartSourceChannel,
  type OrderingInstant,
  type OrderingReference,
} from "./cart.js";
import {
  parseCheckoutValidationEvidence,
  type CheckoutValidationEvidence,
} from "./checkout-validation.js";

export type CanonicalOrderPhase = "Submitted";
export type OrderClosureStatus = "Open";
export type OrderPaymentStatus = "NotReported";

export interface OrderItemIdentity {
  readonly orderItemReference: OrderingReference;
  readonly orderBatchReference: OrderingReference;
  readonly cartItemReference: OrderingReference;
}

export interface OrderBatch {
  readonly orderBatchReference: OrderingReference;
  readonly orderReference: OrderingReference;
  readonly submissionReference: OrderingReference;
  readonly sourceCartReference: OrderingReference;
  readonly sourceCartVersion: number;
  readonly checkoutValidationReference: OrderingReference;
  readonly quoteReference: OrderingReference;
  readonly submittedByActorReference: OrderingReference;
  readonly submittedAt: OrderingInstant;
  readonly items: readonly OrderItemIdentity[];
}

export interface OrderAggregate {
  readonly orderReference: OrderingReference;
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly orderType: CartOrderType;
  readonly sourceChannel: CartSourceChannel;
  readonly diningSessionReference: OrderingReference | null;
  readonly createdByActorReference: OrderingReference;
  readonly submittedByActorReference: OrderingReference;
  readonly aggregateVersion: 1;
  readonly canonicalPhase: CanonicalOrderPhase;
  readonly closureStatus: OrderClosureStatus;
  readonly paymentStatus: OrderPaymentStatus;
  readonly createdAt: OrderingInstant;
  readonly batches: readonly [OrderBatch];
}

export interface CreateOrderItemIdentityInput {
  readonly orderItemReference: unknown;
  readonly cartItemReference: unknown;
}

export interface CreateOrderAggregateInput {
  readonly orderReference: unknown;
  readonly orderBatchReference: unknown;
  readonly submissionReference: unknown;
  readonly diningSessionReference: unknown;
  readonly createdByActorReference: unknown;
  readonly submittedByActorReference: unknown;
  readonly submittedAt: unknown;
  readonly checkoutValidationEvidence: unknown;
  readonly items: unknown;
}

export const orderErrorCodes = ["ORDER_INPUT_INVALID", "ORDER_VALIDATION_EXPIRED"] as const;
export type OrderErrorCode = (typeof orderErrorCodes)[number];

export class OrderError extends Error {
  readonly code: OrderErrorCode;

  constructor(code: OrderErrorCode) {
    super(
      code === "ORDER_VALIDATION_EXPIRED"
        ? "checkout validation expired"
        : "order input is invalid",
    );
    this.name = "OrderError";
    this.code = code;
  }
}

function invalid(): never {
  throw new OrderError("ORDER_INPUT_INVALID");
}

function closed(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
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
    if (error instanceof OrderError) throw error;
    return invalid();
  }
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}

function itemIdentity(value: unknown, batchReference: OrderingReference): OrderItemIdentity {
  const raw = closed(value, ["orderItemReference", "cartItemReference"]);
  try {
    return Object.freeze({
      orderItemReference: parseOrderingReference(raw.orderItemReference),
      orderBatchReference: batchReference,
      cartItemReference: parseOrderingReference(raw.cartItemReference),
    });
  } catch {
    return invalid();
  }
}

function parseStoredItem(value: unknown): OrderItemIdentity {
  const raw = closed(value, ["orderItemReference", "orderBatchReference", "cartItemReference"]);
  try {
    return Object.freeze({
      orderItemReference: parseOrderingReference(raw.orderItemReference),
      orderBatchReference: parseOrderingReference(raw.orderBatchReference),
      cartItemReference: parseOrderingReference(raw.cartItemReference),
    });
  } catch {
    return invalid();
  }
}

function parseBatch(value: unknown): OrderBatch {
  const raw = closed(value, [
    "orderBatchReference",
    "orderReference",
    "submissionReference",
    "sourceCartReference",
    "sourceCartVersion",
    "checkoutValidationReference",
    "quoteReference",
    "submittedByActorReference",
    "submittedAt",
    "items",
  ]);
  if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 100) return invalid();
  try {
    const orderBatchReference = parseOrderingReference(raw.orderBatchReference);
    const items = Object.freeze(raw.items.map(parseStoredItem));
    if (
      items.some((item) => item.orderBatchReference !== orderBatchReference) ||
      new Set(items.map((item) => item.orderItemReference)).size !== items.length ||
      new Set(items.map((item) => item.cartItemReference)).size !== items.length
    )
      return invalid();
    return Object.freeze({
      orderBatchReference,
      orderReference: parseOrderingReference(raw.orderReference),
      submissionReference: parseOrderingReference(raw.submissionReference),
      sourceCartReference: parseOrderingReference(raw.sourceCartReference),
      sourceCartVersion: positiveVersion(raw.sourceCartVersion),
      checkoutValidationReference: parseOrderingReference(raw.checkoutValidationReference),
      quoteReference: parseOrderingReference(raw.quoteReference),
      submittedByActorReference: parseOrderingReference(raw.submittedByActorReference),
      submittedAt: parseOrderingInstant(raw.submittedAt),
      items,
    });
  } catch (error) {
    if (error instanceof OrderError) throw error;
    return invalid();
  }
}

export function parseOrderAggregate(value: unknown): OrderAggregate {
  const raw = closed(value, [
    "orderReference",
    "brandReference",
    "storeReference",
    "orderType",
    "sourceChannel",
    "diningSessionReference",
    "createdByActorReference",
    "submittedByActorReference",
    "aggregateVersion",
    "canonicalPhase",
    "closureStatus",
    "paymentStatus",
    "createdAt",
    "batches",
  ]);
  if (
    raw.aggregateVersion !== 1 ||
    raw.canonicalPhase !== "Submitted" ||
    raw.closureStatus !== "Open" ||
    raw.paymentStatus !== "NotReported" ||
    !["DineIn", "Pickup"].includes(String(raw.orderType)) ||
    !["Api", "Pos", "Qr", "Web"].includes(String(raw.sourceChannel)) ||
    !Array.isArray(raw.batches) ||
    raw.batches.length !== 1
  )
    return invalid();
  try {
    const orderReference = parseOrderingReference(raw.orderReference);
    const createdAt = parseOrderingInstant(raw.createdAt);
    const diningSessionReference =
      raw.diningSessionReference === null
        ? null
        : parseOrderingReference(raw.diningSessionReference);
    const batch = parseBatch(raw.batches[0]);
    if (
      (raw.orderType === "DineIn") !== (diningSessionReference !== null) ||
      batch.orderReference !== orderReference ||
      batch.submittedByActorReference !== raw.submittedByActorReference ||
      batch.submittedAt !== createdAt ||
      new Set([
        orderReference,
        batch.orderBatchReference,
        ...batch.items.map((item) => item.orderItemReference),
      ]).size !==
        2 + batch.items.length
    )
      return invalid();
    return Object.freeze({
      orderReference,
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      orderType: raw.orderType as CartOrderType,
      sourceChannel: raw.sourceChannel as CartSourceChannel,
      diningSessionReference,
      createdByActorReference: parseOrderingReference(raw.createdByActorReference),
      submittedByActorReference: parseOrderingReference(raw.submittedByActorReference),
      aggregateVersion: 1,
      canonicalPhase: "Submitted",
      closureStatus: "Open",
      paymentStatus: "NotReported",
      createdAt,
      batches: Object.freeze([batch]) as readonly [OrderBatch],
    });
  } catch (error) {
    if (error instanceof OrderError) throw error;
    return invalid();
  }
}

function validationEvidence(value: unknown): CheckoutValidationEvidence {
  try {
    return parseCheckoutValidationEvidence(value);
  } catch {
    return invalid();
  }
}

export function createOrderAggregate(input: CreateOrderAggregateInput): OrderAggregate {
  const raw = closed(input, [
    "orderReference",
    "orderBatchReference",
    "submissionReference",
    "diningSessionReference",
    "createdByActorReference",
    "submittedByActorReference",
    "submittedAt",
    "checkoutValidationEvidence",
    "items",
  ]);
  if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 100) return invalid();
  try {
    const evidence = validationEvidence(raw.checkoutValidationEvidence);
    const submittedAt = parseOrderingInstant(raw.submittedAt);
    if (Date.parse(submittedAt) >= Date.parse(evidence.validUntil))
      throw new OrderError("ORDER_VALIDATION_EXPIRED");
    if (Date.parse(submittedAt) < Date.parse(evidence.validatedAt)) return invalid();
    const orderReference = parseOrderingReference(raw.orderReference);
    const orderBatchReference = parseOrderingReference(raw.orderBatchReference);
    const submittedByActorReference = parseOrderingReference(raw.submittedByActorReference);
    const diningSessionReference =
      raw.diningSessionReference === null
        ? null
        : parseOrderingReference(raw.diningSessionReference);
    const items = Object.freeze(raw.items.map((item) => itemIdentity(item, orderBatchReference)));
    const expectedCartItems = new Set(evidence.catalogLines.map((line) => line.cartItemReference));
    if (
      (evidence.orderType === "DineIn") !== (diningSessionReference !== null) ||
      items.length !== expectedCartItems.size ||
      items.some((item) => !expectedCartItems.has(item.cartItemReference)) ||
      new Set(items.map((item) => item.cartItemReference)).size !== items.length ||
      new Set([
        orderReference,
        orderBatchReference,
        ...items.map((item) => item.orderItemReference),
      ]).size !==
        2 + items.length
    )
      return invalid();
    return parseOrderAggregate({
      orderReference,
      brandReference: evidence.brandReference,
      storeReference: evidence.storeReference,
      orderType: evidence.orderType,
      sourceChannel: evidence.sourceChannel,
      diningSessionReference,
      createdByActorReference: parseOrderingReference(raw.createdByActorReference),
      submittedByActorReference,
      aggregateVersion: 1,
      canonicalPhase: "Submitted",
      closureStatus: "Open",
      paymentStatus: "NotReported",
      createdAt: submittedAt,
      batches: [
        {
          orderBatchReference,
          orderReference,
          submissionReference: parseOrderingReference(raw.submissionReference),
          sourceCartReference: evidence.cartReference,
          sourceCartVersion: evidence.cartVersion,
          checkoutValidationReference: evidence.validationReference,
          quoteReference: evidence.quoteReference,
          submittedByActorReference,
          submittedAt,
          items,
        },
      ],
    });
  } catch (error) {
    if (error instanceof OrderError) throw error;
    return invalid();
  }
}
