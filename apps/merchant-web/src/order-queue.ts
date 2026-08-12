export interface OrderQueueItem {
  readonly orderReference: string;
  readonly orderNumber: string;
  readonly orderType: "DineIn" | "Pickup";
  readonly sourceChannel: "Api" | "Pos" | "Qr" | "Web";
  readonly canonicalPhase: "Submitted" | "Fulfilled";
  readonly paymentStatus: "NotReported";
  readonly kitchenStatus: "Unavailable";
  readonly fulfillmentStatus: "Unavailable" | "Completed";
  readonly submittedAt: string;
  readonly fulfilledAt: string | null;
  readonly tableOrPickupReference: "Unavailable";
  readonly promiseAt: null;
  readonly claimStatus: "Unavailable";
  readonly exceptionStatus: "Unavailable";
  readonly batchCount: number;
  readonly itemCount: number;
}

export interface OrderQueueView {
  readonly screenId: "OPS-ORDER-QUEUE";
  readonly projectionName: "ordering_order_status_v1";
  readonly projectionVersion: 1;
  readonly projectedAt: string;
  readonly freshnessStatus: "Fresh" | "Stale" | "Rebuilding" | "Failed";
  readonly storeLabel: string;
  readonly businessDate: string;
  readonly items: readonly OrderQueueItem[];
}

export interface OrderDetailView {
  readonly screenId: "OPS-ORDER-DETAIL";
  readonly projectionName: "ordering_order_status_v1";
  readonly projectionVersion: 1;
  readonly projectedAt: string;
  readonly freshnessStatus: OrderQueueView["freshnessStatus"];
  readonly order: OrderQueueItem;
  readonly batches: readonly {
    readonly batchReference: string;
    readonly sequence: number;
    readonly itemCount: number;
  }[];
}

export interface OrderQueueClient {
  loadQueue(): Promise<unknown>;
  loadDetail(orderReference: string): Promise<unknown>;
}

export class OrderQueueClientError extends Error {
  readonly code:
    "PermissionDenied" | "NotFound" | "Offline" | "Conflict" | "CommandFailed" | "Unavailable";

  constructor(code: OrderQueueClientError["code"]) {
    super("Order Queue is unavailable");
    this.name = "OrderQueueClientError";
    this.code = code;
  }
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_TEXT = /^[^\p{Cc}\p{Cf}]{1,100}$/u;
const ORDER_NUMBER = /^[A-Z0-9][A-Z0-9-]{0,39}$/u;

function closed(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("ORDER_QUEUE_INVALID");
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("ORDER_QUEUE_INVALID");
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !UUID_V7.test(value)) throw new Error("ORDER_QUEUE_INVALID");
  return value;
}

export function parseOrderRouteReference(value: unknown): string {
  return reference(value);
}

function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !INSTANT.test(value) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new Error("ORDER_QUEUE_INVALID");
  return value;
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("ORDER_QUEUE_INVALID");
  return value as number;
}

function item(value: unknown): OrderQueueItem {
  const input = closed(value, [
    "orderReference",
    "orderNumber",
    "orderType",
    "sourceChannel",
    "canonicalPhase",
    "paymentStatus",
    "kitchenStatus",
    "fulfillmentStatus",
    "submittedAt",
    "fulfilledAt",
    "tableOrPickupReference",
    "promiseAt",
    "claimStatus",
    "exceptionStatus",
    "batchCount",
    "itemCount",
  ]);
  if (
    typeof input.orderNumber !== "string" ||
    !ORDER_NUMBER.test(input.orderNumber) ||
    !["DineIn", "Pickup"].includes(String(input.orderType)) ||
    !["Api", "Pos", "Qr", "Web"].includes(String(input.sourceChannel)) ||
    !["Submitted", "Fulfilled"].includes(String(input.canonicalPhase)) ||
    input.paymentStatus !== "NotReported" ||
    input.kitchenStatus !== "Unavailable" ||
    !["Unavailable", "Completed"].includes(String(input.fulfillmentStatus)) ||
    (input.fulfilledAt !== null && typeof input.fulfilledAt !== "string") ||
    input.tableOrPickupReference !== "Unavailable" ||
    input.promiseAt !== null ||
    input.claimStatus !== "Unavailable" ||
    input.exceptionStatus !== "Unavailable"
  )
    throw new Error("ORDER_QUEUE_INVALID");
  const isFulfilled = input.canonicalPhase === "Fulfilled";
  if (
    isFulfilled !== (input.fulfillmentStatus === "Completed") ||
    isFulfilled !== (input.fulfilledAt !== null)
  )
    throw new Error("ORDER_QUEUE_INVALID");
  return Object.freeze({
    orderReference: reference(input.orderReference),
    orderNumber: input.orderNumber,
    orderType: input.orderType as OrderQueueItem["orderType"],
    sourceChannel: input.sourceChannel as OrderQueueItem["sourceChannel"],
    canonicalPhase: input.canonicalPhase as OrderQueueItem["canonicalPhase"],
    paymentStatus: "NotReported",
    kitchenStatus: "Unavailable",
    fulfillmentStatus: input.fulfillmentStatus as OrderQueueItem["fulfillmentStatus"],
    submittedAt: instant(input.submittedAt),
    fulfilledAt: input.fulfilledAt === null ? null : instant(input.fulfilledAt),
    tableOrPickupReference: "Unavailable",
    promiseAt: null,
    claimStatus: "Unavailable",
    exceptionStatus: "Unavailable",
    batchCount: count(input.batchCount),
    itemCount: count(input.itemCount),
  });
}

function projection(value: Readonly<Record<string, unknown>>) {
  if (
    value.projectionName !== "ordering_order_status_v1" ||
    value.projectionVersion !== 1 ||
    !["Fresh", "Stale", "Rebuilding", "Failed"].includes(String(value.freshnessStatus))
  )
    throw new Error("ORDER_QUEUE_INVALID");
  return {
    projectionName: "ordering_order_status_v1" as const,
    projectionVersion: 1 as const,
    projectedAt: instant(value.projectedAt),
    freshnessStatus: value.freshnessStatus as OrderQueueView["freshnessStatus"],
  };
}

export function parseOrderQueueView(value: unknown): OrderQueueView {
  const input = closed(value, [
    "screenId",
    "projectionName",
    "projectionVersion",
    "projectedAt",
    "freshnessStatus",
    "storeLabel",
    "businessDate",
    "items",
  ]);
  const parsedDate =
    typeof input.businessDate === "string"
      ? Date.parse(`${input.businessDate}T00:00:00.000Z`)
      : Number.NaN;
  if (
    input.screenId !== "OPS-ORDER-QUEUE" ||
    typeof input.storeLabel !== "string" ||
    !SAFE_TEXT.test(input.storeLabel) ||
    typeof input.businessDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(input.businessDate) ||
    !Number.isFinite(parsedDate) ||
    new Date(parsedDate).toISOString().slice(0, 10) !== input.businessDate ||
    !Array.isArray(input.items) ||
    input.items.length > 100
  )
    throw new Error("ORDER_QUEUE_INVALID");
  const items = Object.freeze(input.items.map(item));
  if (new Set(items.map((order) => order.orderReference)).size !== items.length)
    throw new Error("ORDER_QUEUE_INVALID");
  return Object.freeze({
    screenId: "OPS-ORDER-QUEUE",
    ...projection(input),
    storeLabel: input.storeLabel,
    businessDate: input.businessDate,
    items,
  });
}

export function parseOrderDetailView(value: unknown): OrderDetailView {
  const input = closed(value, [
    "screenId",
    "projectionName",
    "projectionVersion",
    "projectedAt",
    "freshnessStatus",
    "order",
    "batches",
  ]);
  if (
    input.screenId !== "OPS-ORDER-DETAIL" ||
    !Array.isArray(input.batches) ||
    input.batches.length > 100
  )
    throw new Error("ORDER_QUEUE_INVALID");
  const batches = Object.freeze(
    input.batches.map((value) => {
      const batch = closed(value, ["batchReference", "sequence", "itemCount"]);
      return Object.freeze({
        batchReference: reference(batch.batchReference),
        sequence: count(batch.sequence),
        itemCount: count(batch.itemCount),
      });
    }),
  );
  const order = item(input.order);
  if (
    new Set(batches.map((batch) => batch.batchReference)).size !== batches.length ||
    batches.length !== order.batchCount ||
    batches.reduce((total, batch) => total + batch.itemCount, 0) !== order.itemCount
  )
    throw new Error("ORDER_QUEUE_INVALID");
  return Object.freeze({ screenId: "OPS-ORDER-DETAIL", ...projection(input), order, batches });
}

export const unavailableOrderQueueClient: OrderQueueClient = Object.freeze({
  async loadQueue() {
    throw new OrderQueueClientError("Unavailable");
  },
  async loadDetail() {
    throw new OrderQueueClientError("Unavailable");
  },
});
