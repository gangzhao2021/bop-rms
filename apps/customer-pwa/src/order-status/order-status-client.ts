import { boundedFetch } from "../network/bounded-fetch.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";
import {
  OrderStatusClientError,
  parseOrderStatusView,
  type CustomerOrderStatusClient,
  type OrderStatusSubscriptionCallbacks,
} from "./order-status-controller.js";
import type { OrderStatusView } from "./types.js";

const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const credential = /^[A-Za-z0-9_-]{43}$/u;

function record(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("invalid status");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = descriptors[key];
      return !descriptor || !descriptor.enumerable || !("value" in descriptor);
    })
  )
    throw new Error("invalid status");
  return value as Record<string, unknown>;
}

function decodeMoney(value: unknown) {
  const money = record(value);
  if (
    typeof money.amountMinor !== "string" ||
    !/^(?:0|-?[1-9][0-9]{0,18})$/u.test(money.amountMinor)
  )
    throw new Error("invalid status");
  const amountMinor = BigInt(money.amountMinor);
  if (amountMinor < -(2n ** 63n) || amountMinor > 2n ** 63n - 1n) throw new Error("invalid status");
  return { ...money, amountMinor };
}

function decodeStatus(value: unknown, orderReference: string): OrderStatusView {
  const root = record(value);
  if (Object.keys(root).length !== 2 || root.schemaVersion !== 1 || !Object.hasOwn(root, "status"))
    throw new Error("invalid status");
  const status = record(root.status);
  const order = record(status.order);
  if (!Array.isArray(order.batches) || order.batches.length > 20) throw new Error("invalid status");
  const batches = order.batches.map((value: unknown) => {
    const batch = record(value);
    if (!Array.isArray(batch.items) || batch.items.length > 100) throw new Error("invalid status");
    const items = batch.items.map((value: unknown) => {
      const item = record(value);
      return { ...item, lineTotal: decodeMoney(item.lineTotal) };
    });
    return { ...batch, items };
  });
  let sources: Record<string, unknown> | undefined;
  if (Object.hasOwn(status, "sources")) {
    sources = record(status.sources);
    if (sources.payments !== null) {
      if (!Array.isArray(sources.payments) || sources.payments.length > 100)
        throw new Error("invalid status");
      sources = {
        ...sources,
        payments: sources.payments.map((value: unknown) => {
          const payment = record(value);
          return {
            ...payment,
            amount: payment.amount === null ? null : decodeMoney(payment.amount),
          };
        }),
      };
    }
  }
  return parseOrderStatusView(
    {
      ...status,
      order: { ...order, batches },
      ...(sources ? { sources } : {}),
    },
    orderReference,
  );
}

export function createHttpOrderStatusClient(
  request: typeof globalThis.fetch = globalThis.fetch,
): CustomerOrderStatusClient {
  return Object.freeze({
    async load(orderReference: string): Promise<OrderStatusView> {
      if (!reference.test(orderReference)) throw new OrderStatusClientError("service_unavailable");
      const csrf = getCustomerCsrfCredential();
      const contextCurrent = captureCustomerCsrfContext();
      if (csrf === null || !credential.test(csrf))
        throw new OrderStatusClientError("permission_denied");
      try {
        const response = await boundedFetch(request, `/api/v1/orders/${orderReference}/status`, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          redirect: "error",
          headers: { accept: "application/json", "x-csrf-token": csrf },
        });
        if (!contextCurrent()) throw new OrderStatusClientError("permission_denied");
        if (response.status === 401 || response.status === 403)
          throw new OrderStatusClientError("permission_denied");
        if (response.status === 404) throw new OrderStatusClientError("not_found");
        if (response.status !== 200) throw new OrderStatusClientError("service_unavailable");
        const payload: unknown = await response.json();
        if (!contextCurrent()) throw new OrderStatusClientError("permission_denied");
        return decodeStatus(payload, orderReference);
      } catch (error) {
        if (!contextCurrent()) throw new OrderStatusClientError("permission_denied");
        if (error instanceof OrderStatusClientError) throw error;
        throw new OrderStatusClientError("service_unavailable");
      }
    },
    subscribe(_orderReference: string, callbacks: OrderStatusSubscriptionCallbacks) {
      callbacks.onError();
      return () => undefined;
    },
  });
}
