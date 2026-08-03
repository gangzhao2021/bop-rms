import {
  parseOrderingInstant,
  parseOrderingReference,
  type CartOrderType,
  type CartSourceChannel,
  type OrderingInstant,
  type OrderingReference,
} from "./cart.js";

export type OrderStatusFreshness = "Fresh" | "Stale" | "Rebuilding" | "Failed";

export interface OrderStatusMoney {
  readonly amountMinor: bigint;
  readonly currencyCode: string;
}

export interface OrderStatusItemSummary {
  readonly orderItemReference: OrderingReference;
  readonly displayName: string;
  readonly quantity: number;
  readonly lineTotal: OrderStatusMoney;
}

export interface OrderStatusBatchSummary {
  readonly orderBatchReference: OrderingReference;
  readonly submittedAt: OrderingInstant;
  readonly items: readonly OrderStatusItemSummary[];
}

export interface OrderStatusSourceSnapshot {
  readonly sourceVersion: number;
  readonly sourceCheckpoint: OrderingReference;
  readonly sourceDigest: string;
  readonly orderReference: OrderingReference;
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly guestSessionReference: OrderingReference;
  readonly submissionReference: OrderingReference;
  readonly businessDate: string;
  readonly orderNumber: string;
  readonly orderType: CartOrderType;
  readonly sourceChannel: CartSourceChannel;
  readonly canonicalPhase: "Submitted";
  readonly closureStatus: "Open";
  readonly paymentStatus: "NotReported";
  readonly kitchenStatus: "Unavailable";
  readonly fulfillmentStatus: "Unavailable";
  readonly eta: null;
  readonly submittedAt: OrderingInstant;
  readonly batches: readonly OrderStatusBatchSummary[];
}

export interface OrderStatusProjection {
  readonly projectionName: "ordering_order_status_v1";
  readonly projectionVersion: 1;
  readonly generationReference: OrderingReference;
  readonly projectedAt: OrderingInstant;
  readonly freshnessStatus: OrderStatusFreshness;
  readonly snapshot: OrderStatusSourceSnapshot;
}

export const orderStatusProjectionErrorCodes = [
  "ORDER_STATUS_INPUT_INVALID",
  "ORDER_STATUS_VERSION_CONFLICT",
  "ORDER_STATUS_PERMISSION_DENIED",
  "ORDER_STATUS_NOT_FOUND",
  "ORDER_STATUS_DEPENDENCY_UNAVAILABLE",
] as const;
export type OrderStatusProjectionErrorCode = (typeof orderStatusProjectionErrorCodes)[number];

export class OrderStatusProjectionError extends Error {
  readonly code: OrderStatusProjectionErrorCode;
  constructor(code: OrderStatusProjectionErrorCode) {
    super("order status is unavailable");
    this.name = "OrderStatusProjectionError";
    this.code = code;
  }
}

function invalid(): never {
  throw new OrderStatusProjectionError("ORDER_STATUS_INPUT_INVALID");
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
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get ||
        descriptor.set ||
        !descriptor.enumerable
      )
        return invalid();
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof OrderStatusProjectionError) throw error;
    return invalid();
  }
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}

function money(value: unknown): OrderStatusMoney {
  const raw = exact(value, ["amountMinor", "currencyCode"]);
  if (
    typeof raw.amountMinor !== "bigint" ||
    raw.amountMinor < -(2n ** 63n) ||
    raw.amountMinor > 2n ** 63n - 1n ||
    typeof raw.currencyCode !== "string" ||
    !/^[A-Z]{3}$/u.test(raw.currencyCode)
  )
    return invalid();
  return Object.freeze({ amountMinor: raw.amountMinor, currencyCode: raw.currencyCode });
}

function item(value: unknown): OrderStatusItemSummary {
  const raw = exact(value, ["orderItemReference", "displayName", "quantity", "lineTotal"]);
  if (typeof raw.displayName !== "string") return invalid();
  const displayName = raw.displayName.normalize("NFC").trim();
  const quantity = positive(raw.quantity);
  if (displayName.length < 1 || displayName.length > 200 || quantity > 999) return invalid();
  return Object.freeze({
    orderItemReference: parseOrderingReference(raw.orderItemReference),
    displayName,
    quantity,
    lineTotal: money(raw.lineTotal),
  });
}

function batch(value: unknown): OrderStatusBatchSummary {
  const raw = exact(value, ["orderBatchReference", "submittedAt", "items"]);
  if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 100) return invalid();
  const items = Object.freeze(raw.items.map(item));
  if (new Set(items.map((candidate) => candidate.orderItemReference)).size !== items.length)
    return invalid();
  return Object.freeze({
    orderBatchReference: parseOrderingReference(raw.orderBatchReference),
    submittedAt: parseOrderingInstant(raw.submittedAt),
    items,
  });
}

export function parseOrderStatusSourceSnapshot(value: unknown): OrderStatusSourceSnapshot {
  const raw = exact(value, [
    "sourceVersion",
    "sourceCheckpoint",
    "sourceDigest",
    "orderReference",
    "brandReference",
    "storeReference",
    "guestSessionReference",
    "submissionReference",
    "businessDate",
    "orderNumber",
    "orderType",
    "sourceChannel",
    "canonicalPhase",
    "closureStatus",
    "paymentStatus",
    "kitchenStatus",
    "fulfillmentStatus",
    "eta",
    "submittedAt",
    "batches",
  ]);
  if (
    typeof raw.orderNumber !== "string" ||
    !/^[1-9][0-9]{0,18}$/u.test(raw.orderNumber) ||
    typeof raw.sourceDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(raw.sourceDigest) ||
    typeof raw.businessDate !== "string" ||
    !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u.test(raw.businessDate) ||
    !["DineIn", "Pickup"].includes(String(raw.orderType)) ||
    !["Api", "Pos", "Qr", "Web"].includes(String(raw.sourceChannel)) ||
    raw.canonicalPhase !== "Submitted" ||
    raw.closureStatus !== "Open" ||
    raw.paymentStatus !== "NotReported" ||
    raw.kitchenStatus !== "Unavailable" ||
    raw.fulfillmentStatus !== "Unavailable" ||
    raw.eta !== null ||
    !Array.isArray(raw.batches) ||
    raw.batches.length < 1 ||
    raw.batches.length > 20
  )
    return invalid();
  const submittedAt = parseOrderingInstant(raw.submittedAt);
  const batches = Object.freeze(raw.batches.map(batch));
  const currencies = new Set(
    batches.flatMap((candidate) =>
      candidate.items.map((itemValue) => itemValue.lineTotal.currencyCode),
    ),
  );
  if (
    new Set(batches.map((candidate) => candidate.orderBatchReference)).size !== batches.length ||
    batches.some((candidate) => Date.parse(candidate.submittedAt) < Date.parse(submittedAt)) ||
    currencies.size !== 1
  )
    return invalid();
  return Object.freeze({
    sourceVersion: positive(raw.sourceVersion),
    sourceCheckpoint: parseOrderingReference(raw.sourceCheckpoint),
    sourceDigest: raw.sourceDigest,
    orderReference: parseOrderingReference(raw.orderReference),
    brandReference: parseOrderingReference(raw.brandReference),
    storeReference: parseOrderingReference(raw.storeReference),
    guestSessionReference: parseOrderingReference(raw.guestSessionReference),
    submissionReference: parseOrderingReference(raw.submissionReference),
    businessDate: raw.businessDate,
    orderNumber: raw.orderNumber,
    orderType: raw.orderType as CartOrderType,
    sourceChannel: raw.sourceChannel as CartSourceChannel,
    canonicalPhase: "Submitted",
    closureStatus: "Open",
    paymentStatus: "NotReported",
    kitchenStatus: "Unavailable",
    fulfillmentStatus: "Unavailable",
    eta: null,
    submittedAt,
    batches,
  });
}

export function parseOrderStatusProjection(value: unknown): OrderStatusProjection {
  const raw = exact(value, [
    "projectionName",
    "projectionVersion",
    "generationReference",
    "projectedAt",
    "freshnessStatus",
    "snapshot",
  ]);
  if (
    raw.projectionName !== "ordering_order_status_v1" ||
    raw.projectionVersion !== 1 ||
    !["Fresh", "Stale", "Rebuilding", "Failed"].includes(String(raw.freshnessStatus))
  )
    return invalid();
  return Object.freeze({
    projectionName: "ordering_order_status_v1",
    projectionVersion: 1,
    generationReference: parseOrderingReference(raw.generationReference),
    projectedAt: parseOrderingInstant(raw.projectedAt),
    freshnessStatus: raw.freshnessStatus as OrderStatusFreshness,
    snapshot: parseOrderStatusSourceSnapshot(raw.snapshot),
  });
}

export function buildOrderStatusProjection(input: {
  readonly source: unknown;
  readonly generationReference: unknown;
  readonly projectedAt: unknown;
}): OrderStatusProjection {
  return parseOrderStatusProjection({
    projectionName: "ordering_order_status_v1",
    projectionVersion: 1,
    generationReference: input.generationReference,
    projectedAt: input.projectedAt,
    freshnessStatus: "Fresh",
    snapshot: input.source,
  });
}
