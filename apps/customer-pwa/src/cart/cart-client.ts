import { CartClientError, type CartErrorCode, type CartItemDraft, type CartView } from "./types.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
  setCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";
import { browserRequestTimeoutMs } from "../network/bounded-fetch.js";

const errorStatuses: Partial<Record<CartErrorCode, number>> = {
  cart_request_invalid: 400,
  cart_session_expired: 401,
  cart_not_found: 404,
  cart_version_conflict: 409,
  cart_idempotency_conflict: 409,
  cart_selection_invalid: 422,
  cart_expired: 409,
  cart_abandoned: 409,
  cart_rate_limited: 429,
  cart_service_unavailable: 503,
};
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const canonicalInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const currency = /^[A-Z]{3}$/u;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CartClientError("cart_service_unavailable");
  return value as Record<string, unknown>;
}

function string(value: unknown, pattern?: RegExp): string {
  if (typeof value !== "string" || (pattern !== undefined && !pattern.test(value)))
    throw new CartClientError("cart_service_unavailable");
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new CartClientError("cart_service_unavailable");
  return Number(value);
}

function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new CartClientError("cart_service_unavailable");
  return Object.freeze([...value]);
}

function money(value: unknown) {
  const raw = record(value);
  const amountMinor = string(raw.amountMinor, /^-?(?:0|[1-9][0-9]{0,20})$/u);
  return Object.freeze({ amountMinor, currency: string(raw.currency, currency) });
}

function view(value: unknown): CartView {
  const root = record(value);
  const cart = record(root.cart);
  const context = record(cart.context);
  const lifecycle = record(cart.lifecycle);
  if (
    root.schemaVersion !== 1 ||
    !["DineIn", "Pickup"].includes(String(cart.orderType)) ||
    !["Active", "Abandoned", "Expired"].includes(String(lifecycle.status)) ||
    !Array.isArray(cart.items)
  )
    throw new CartClientError("cart_service_unavailable");
  const items = cart.items.map((candidate) => {
    const item = record(candidate);
    if (!Array.isArray(item.configuration)) throw new CartClientError("cart_service_unavailable");
    const configuration = item.configuration.map((candidateOption) => {
      const option = record(candidateOption);
      return Object.freeze({
        optionReference: string(option.optionReference, uuidV7),
        displayName: string(option.displayName),
        quantity: integer(option.quantity),
      });
    });
    const estimate = record(item.lineEstimate);
    const lineEstimate =
      estimate.status === "Available"
        ? Object.freeze({ status: "Available" as const, total: money(estimate.total) })
        : estimate.status === "Unavailable"
          ? Object.freeze({
              status: "Unavailable" as const,
              reasonCode: string(estimate.reasonCode),
            })
          : (() => {
              throw new CartClientError("cart_service_unavailable");
            })();
    return Object.freeze({
      cartItemReference: string(item.cartItemReference, uuidV7),
      sellableReference: string(item.sellableReference, uuidV7),
      displayName: string(item.displayName),
      quantity: integer(item.quantity),
      configuration: Object.freeze(configuration),
      customerNote: item.customerNote === null ? null : string(item.customerNote),
      lineEstimate,
      warnings: strings(item.warnings),
    });
  });
  let quote: CartView["cart"]["quote"] = null;
  if (cart.quote !== null) {
    const raw = record(cart.quote);
    quote = Object.freeze({
      quoteReference: string(raw.quoteReference, uuidV7),
      quoteVersion: integer(raw.quoteVersion),
      cartVersion: integer(raw.cartVersion),
      subtotal: money(raw.subtotal),
      discount: money(raw.discount),
      tax: money(raw.tax),
      fee: money(raw.fee),
      total: money(raw.total),
      expiresAt: string(raw.expiresAt, canonicalInstant),
      warnings: strings(raw.warnings),
      blockingReasons: strings(raw.blockingReasons),
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    cart: Object.freeze({
      cartReference: string(cart.cartReference, uuidV7),
      version: integer(cart.version),
      orderType: cart.orderType as "DineIn" | "Pickup",
      serviceMode: string(cart.serviceMode),
      context: Object.freeze({
        brandName: string(context.brandName),
        storeName: string(context.storeName),
      }),
      lifecycle: Object.freeze({
        status: lifecycle.status as "Active" | "Abandoned" | "Expired",
        idleExpiresAt: string(lifecycle.idleExpiresAt, canonicalInstant),
        absoluteExpiresAt: string(lifecycle.absoluteExpiresAt, canonicalInstant),
      }),
      items: Object.freeze(items),
      quote,
      warnings: strings(cart.warnings),
    }),
  });
}

export interface CustomerCartClient {
  loadCurrent(signal?: AbortSignal): Promise<CartView | null>;
  createCart(input: { readonly operationReference: string }): Promise<CartView>;
  addItem(input: {
    readonly cart: CartView;
    readonly sellableReference: string;
    readonly draft: CartItemDraft;
    readonly operationReference: string;
  }): Promise<CartView>;
  updateItem(input: {
    readonly cart: CartView;
    readonly cartItemReference: string;
    readonly draft: CartItemDraft;
    readonly operationReference: string;
  }): Promise<CartView>;
  removeItem(input: {
    readonly cart: CartView;
    readonly cartItemReference: string;
    readonly operationReference: string;
  }): Promise<CartView>;
}

export function setCustomerCartCsrfCredential(value: string | null): void {
  setCustomerCsrfCredential(value);
}

function csrf(): string {
  const value = getCustomerCsrfCredential();
  if (value === null) throw new CartClientError("cart_session_expired");
  return value;
}

function headers(input: { readonly operationReference: string; readonly version: number }) {
  return {
    "content-type": "application/json",
    "idempotency-key": input.operationReference,
    "if-match": `"${input.version}"`,
    "x-csrf-token": csrf(),
  };
}

function createHeaders(operationReference: string) {
  return {
    "content-type": "application/json",
    "idempotency-key": operationReference,
    "x-csrf-token": csrf(),
  };
}

function parse(response: Response, payload: unknown): CartView | null {
  if (response.ok) return view(payload);
  const error =
    typeof payload === "object" && payload !== null
      ? (payload as { error?: { code?: unknown; currentVersion?: unknown; issueCodes?: unknown } })
          .error
      : undefined;
  const code =
    Object.hasOwn(errorStatuses, String(error?.code)) &&
    errorStatuses[String(error?.code) as CartErrorCode] === response.status
      ? (error?.code as CartErrorCode)
      : "cart_service_unavailable";
  if (code === "cart_not_found" && response.status === 404) return null;
  const retryHeader = response.headers.get("retry-after");
  throw new CartClientError(code, {
    ...(Number.isSafeInteger(error?.currentVersion)
      ? { currentVersion: Number(error?.currentVersion) }
      : {}),
    ...(Array.isArray(error?.issueCodes)
      ? {
          issueCodes: error.issueCodes.filter(
            (value): value is string => typeof value === "string",
          ),
        }
      : {}),
    ...(retryHeader !== null && /^[1-9][0-9]{0,3}$/u.test(retryHeader)
      ? { retryAfterSeconds: Number(retryHeader) }
      : {}),
  });
}

async function request(url: string, init: RequestInit): Promise<CartView | null> {
  const contextCurrent = captureCustomerCsrfContext();
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectCancellation: (error: CartClientError) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = () => {
    controller.abort();
    rejectCancellation(new CartClientError("network_unknown"));
  };
  const timer = setTimeout(cancel, browserRequestTimeoutMs);
  if (init.signal?.aborted) cancel();
  else init.signal?.addEventListener("abort", cancel, { once: true });
  const operation = async () => {
    if (controller.signal.aborted || !contextCurrent())
      throw new CartClientError("network_unknown");
    const response = await globalThis.fetch(url, {
      ...init,
      signal: controller.signal,
      mode: "cors",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    // An aborted or superseded response must not reveal an old Cart or clear newer Session state.
    if (controller.signal.aborted || !contextCurrent()) {
      void response.body?.cancel().catch(() => undefined);
      throw new CartClientError("network_unknown");
    }
    if (response.redirected || response.body === null) {
      void response.body?.cancel().catch(() => undefined);
      throw new CartClientError("cart_service_unavailable");
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      if (controller.signal.aborted || !contextCurrent())
        throw new CartClientError("network_unknown");
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16 * 1024 * 1024) throw new CartClientError("cart_service_unavailable");
      chunks.push(part.value);
    }
    if (controller.signal.aborted || !contextCurrent())
      throw new CartClientError("network_unknown");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new CartClientError("cart_service_unavailable");
    }
    return parse(response, payload);
  };
  try {
    const result = await Promise.race([operation(), cancellation]);
    if (!contextCurrent()) throw new CartClientError("network_unknown");
    return result;
  } catch (error) {
    if (!contextCurrent()) throw new CartClientError("network_unknown");
    if (error instanceof CartClientError) {
      if (error.code === "cart_session_expired") setCustomerCartCsrfCredential(null);
      // An unavailable or malformed write response may follow a committed command.
      if (init.method !== "GET" && error.code === "cart_service_unavailable")
        throw new CartClientError("network_unknown");
      throw error;
    }
    throw new CartClientError("network_unknown");
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", cancel);
    controller.abort();
    if (reader !== undefined) {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

export function createBrowserCustomerCartClient(): CustomerCartClient {
  const client: CustomerCartClient = {
    loadCurrent: (signal?: AbortSignal) =>
      request("/bff/customer/cart", { method: "GET", ...(signal === undefined ? {} : { signal }) }),
    async createCart(input) {
      const contextCurrent = captureCustomerCsrfContext();
      const result = await request("/api/v1/carts", {
        method: "POST",
        headers: createHeaders(input.operationReference),
        body: "{}",
      });
      if (!contextCurrent()) throw new CartClientError("network_unknown");
      if (result === null) throw new CartClientError("cart_not_found");
      return result;
    },
    async addItem(input) {
      const contextCurrent = captureCustomerCsrfContext();
      const result = await request(`/api/v1/carts/${input.cart.cart.cartReference}/items`, {
        method: "POST",
        headers: headers({
          operationReference: input.operationReference,
          version: input.cart.cart.version,
        }),
        body: JSON.stringify({
          sellableReference: input.sellableReference,
          ...input.draft,
        }),
      });
      if (!contextCurrent()) throw new CartClientError("network_unknown");
      if (result === null) throw new CartClientError("cart_not_found");
      return result;
    },
    async updateItem(input) {
      const contextCurrent = captureCustomerCsrfContext();
      const result = await request(
        `/api/v1/carts/${input.cart.cart.cartReference}/items/${input.cartItemReference}`,
        {
          method: "PATCH",
          headers: headers({
            operationReference: input.operationReference,
            version: input.cart.cart.version,
          }),
          body: JSON.stringify(input.draft),
        },
      );
      if (!contextCurrent()) throw new CartClientError("network_unknown");
      if (result === null) throw new CartClientError("cart_not_found");
      return result;
    },
    async removeItem(input) {
      const contextCurrent = captureCustomerCsrfContext();
      const result = await request(
        `/api/v1/carts/${input.cart.cart.cartReference}/items/${input.cartItemReference}`,
        {
          method: "DELETE",
          headers: headers({
            operationReference: input.operationReference,
            version: input.cart.cart.version,
          }),
        },
      );
      if (!contextCurrent()) throw new CartClientError("network_unknown");
      if (result === null) throw new CartClientError("cart_not_found");
      return result;
    },
  };
  return Object.freeze(client);
}
