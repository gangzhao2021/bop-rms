import type { OrderStatusState, OrderStatusView, RealtimeAvailability } from "./types.js";

const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

export type OrderStatusClientErrorCode =
  "permission_denied" | "not_found" | "feature_disabled" | "service_unavailable";

export class OrderStatusClientError extends Error {
  readonly code: OrderStatusClientErrorCode;

  constructor(code: OrderStatusClientErrorCode) {
    super("Order status is unavailable.");
    this.name = "OrderStatusClientError";
    this.code = code;
  }
}

export interface OrderStatusSubscriptionCallbacks {
  readonly onOpen: () => void;
  readonly onHint: () => void;
  readonly onError: () => void;
}

export interface CustomerOrderStatusClient {
  load(orderReference: string): Promise<unknown>;
  subscribe(orderReference: string, callbacks: OrderStatusSubscriptionCallbacks): () => void;
}

export function createUnavailableOrderStatusClient(): CustomerOrderStatusClient {
  return Object.freeze({
    async load(): Promise<never> {
      throw new OrderStatusClientError("service_unavailable");
    },
    subscribe(): () => void {
      return () => undefined;
    },
  });
}

function invalid(): never {
  throw new Error("invalid order status");
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
        !("value" in descriptor) ||
        descriptor.get ||
        descriptor.set ||
        !descriptor.enumerable
      )
        return invalid();
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch {
    return invalid();
  }
}

function parseReference(value: unknown): string {
  if (typeof value !== "string" || !reference.test(value)) return invalid();
  return value;
}

function parseInstant(value: unknown): string {
  if (typeof value !== "string" || !instant.test(value) || !Number.isFinite(Date.parse(value)))
    return invalid();
  return value;
}

function parseMoney(value: unknown) {
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

function parseItem(value: unknown) {
  const raw = exact(value, ["orderItemReference", "displayName", "quantity", "lineTotal"]);
  if (
    typeof raw.displayName !== "string" ||
    raw.displayName !== raw.displayName.normalize("NFC").trim() ||
    raw.displayName.length < 1 ||
    raw.displayName.length > 200 ||
    !Number.isSafeInteger(raw.quantity) ||
    (raw.quantity as number) < 1 ||
    (raw.quantity as number) > 999
  )
    return invalid();
  return Object.freeze({
    orderItemReference: parseReference(raw.orderItemReference),
    displayName: raw.displayName,
    quantity: raw.quantity as number,
    lineTotal: parseMoney(raw.lineTotal),
  });
}

function parseBatch(value: unknown) {
  const raw = exact(value, ["orderBatchReference", "submittedAt", "items"]);
  if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 100) return invalid();
  const items = Object.freeze(raw.items.map(parseItem));
  if (new Set(items.map((item) => item.orderItemReference)).size !== items.length) return invalid();
  return Object.freeze({
    orderBatchReference: parseReference(raw.orderBatchReference),
    submittedAt: parseInstant(raw.submittedAt),
    items,
  });
}

export function parseOrderStatusView(value: unknown, expectedReference: string): OrderStatusView {
  const raw = exact(value, [
    "projectionName",
    "projectionVersion",
    "sourceCheckpoint",
    "projectedAt",
    "freshnessStatus",
    "order",
  ]);
  if (
    raw.projectionName !== "ordering_order_status_v1" ||
    raw.projectionVersion !== 1 ||
    !["Fresh", "Stale", "Rebuilding", "Failed"].includes(String(raw.freshnessStatus))
  )
    return invalid();
  const order = exact(raw.order, [
    "orderReference",
    "orderNumber",
    "orderType",
    "canonicalPhase",
    "paymentStatus",
    "kitchenStatus",
    "fulfillmentStatus",
    "fulfilledAt",
    "eta",
    "submittedAt",
    "batches",
  ]);
  if (
    parseReference(order.orderReference) !== expectedReference ||
    typeof order.orderNumber !== "string" ||
    !/^[1-9][0-9]{0,18}$/u.test(order.orderNumber) ||
    !["DineIn", "Pickup"].includes(String(order.orderType)) ||
    !["Submitted", "Fulfilled"].includes(String(order.canonicalPhase)) ||
    order.paymentStatus !== "NotReported" ||
    order.kitchenStatus !== "Unavailable" ||
    !["Unavailable", "Completed"].includes(String(order.fulfillmentStatus)) ||
    order.eta !== null ||
    !Array.isArray(order.batches) ||
    order.batches.length < 1 ||
    order.batches.length > 20
  )
    return invalid();
  const submittedAt = parseInstant(order.submittedAt);
  const fulfilledAt = order.fulfilledAt === null ? null : parseInstant(order.fulfilledAt);
  const batches = Object.freeze(order.batches.map(parseBatch));
  const currencies = new Set(
    batches.flatMap((batch) => batch.items.map((item) => item.lineTotal.currencyCode)),
  );
  if (
    new Set(batches.map((batch) => batch.orderBatchReference)).size !== batches.length ||
    batches.some((batch) => Date.parse(batch.submittedAt) < Date.parse(submittedAt)) ||
    currencies.size !== 1 ||
    (order.fulfillmentStatus === "Unavailable" &&
      (order.canonicalPhase !== "Submitted" || fulfilledAt !== null)) ||
    (order.fulfillmentStatus === "Completed" &&
      (order.canonicalPhase !== "Fulfilled" ||
        fulfilledAt === null ||
        Date.parse(fulfilledAt) < Date.parse(submittedAt)))
  )
    return invalid();
  return Object.freeze({
    projectionName: "ordering_order_status_v1",
    projectionVersion: 1,
    sourceCheckpoint: parseReference(raw.sourceCheckpoint),
    projectedAt: parseInstant(raw.projectedAt),
    freshnessStatus: raw.freshnessStatus as OrderStatusView["freshnessStatus"],
    order: Object.freeze({
      orderReference: expectedReference,
      orderNumber: order.orderNumber,
      orderType: order.orderType as "DineIn" | "Pickup",
      canonicalPhase: order.canonicalPhase as "Submitted" | "Fulfilled",
      paymentStatus: "NotReported",
      kitchenStatus: "Unavailable",
      fulfillmentStatus: order.fulfillmentStatus as "Unavailable" | "Completed",
      fulfilledAt,
      eta: null,
      submittedAt,
      batches,
    }),
  });
}

export interface OrderStatusController {
  getState(): OrderStatusState;
  load(): Promise<void>;
  refresh(): Promise<void>;
  setOnline(value: boolean): void;
  dispose(): void;
  subscribe(listener: () => void): () => void;
}

export function createOrderStatusController(
  orderReference: string,
  client: CustomerOrderStatusClient,
): OrderStatusController {
  let state: OrderStatusState = reference.test(orderReference)
    ? { status: "loading" }
    : { status: "invalid-reference" };
  let online = typeof navigator === "undefined" || navigator.onLine !== false;
  let stopped = false;
  let request = 0;
  let realtime: RealtimeAvailability = "connecting";
  let unsubscribeRealtime: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: OrderStatusState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const currentView = () =>
    state.status === "ready" || state.status === "offline" ? state.view : null;
  const loadCanonical = async () => {
    if (stopped || !reference.test(orderReference)) return;
    const retained = currentView();
    if (!online) {
      publish({ status: "offline", view: retained });
      return;
    }
    const token = ++request;
    if (retained) publish({ status: "ready", view: retained, realtime, refreshing: true });
    else publish({ status: "loading" });
    try {
      const view = parseOrderStatusView(await client.load(orderReference), orderReference);
      if (!stopped && online && token === request)
        publish({ status: "ready", view, realtime, refreshing: false });
    } catch (error) {
      if (stopped || token !== request) return;
      if (error instanceof OrderStatusClientError) {
        const mapped =
          error.code === "permission_denied"
            ? "permission-denied"
            : error.code === "not_found"
              ? "not-found"
              : error.code === "feature_disabled"
                ? "feature-disabled"
                : "unavailable";
        publish({ status: mapped });
      } else publish({ status: "unavailable" });
    }
  };
  const updateRealtime = (value: RealtimeAvailability) => {
    realtime = value;
    if (state.status === "ready") publish({ ...state, realtime });
  };
  const startRealtime = () => {
    if (!online || stopped || !reference.test(orderReference) || unsubscribeRealtime) return;
    try {
      const candidate = client.subscribe(orderReference, {
        onOpen: () => {
          if (!online || stopped) return;
          updateRealtime("available");
          void loadCanonical();
        },
        onHint: () => {
          if (online && !stopped) void loadCanonical();
        },
        onError: () => {
          if (online && !stopped) updateRealtime("unavailable");
        },
      });
      if (typeof candidate !== "function") {
        updateRealtime("unavailable");
        return;
      }
      unsubscribeRealtime = candidate;
    } catch {
      updateRealtime("unavailable");
    }
  };
  return Object.freeze({
    getState: () => state,
    async load() {
      if (!reference.test(orderReference)) return;
      await loadCanonical();
      startRealtime();
    },
    refresh: loadCanonical,
    setOnline(value: boolean) {
      online = value;
      if (!value) {
        request += 1;
        unsubscribeRealtime?.();
        unsubscribeRealtime = null;
        publish({ status: "offline", view: currentView() });
      }
    },
    dispose() {
      stopped = true;
      request += 1;
      unsubscribeRealtime?.();
      unsubscribeRealtime = null;
      listeners.clear();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
