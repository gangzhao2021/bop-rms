import type { CustomerCartClient } from "../cart/cart-client.js";
import { browserRequestTimeoutMs } from "../network/bounded-fetch.js";
import { CartClientError, type CartMoney, type CartView } from "../cart/types.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";
import type { CheckoutQuote, CheckoutState } from "./types.js";

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const currency = /^[A-Z]{3}$/u;
const credential = /^[A-Za-z0-9_-]{43}$/u;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid");
  return value as Record<string, unknown>;
}
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const raw = record(value);
  const keys = Object.keys(raw);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key)))
    throw new Error("invalid");
  return raw;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("invalid");
  return Number(value);
}
function text(value: unknown, pattern?: RegExp): string {
  if (typeof value !== "string" || (pattern && !pattern.test(value))) throw new Error("invalid");
  return value;
}
function money(value: unknown): CartMoney {
  const raw = exact(value, ["amountMinor", "currency"]);
  return Object.freeze({
    amountMinor: text(raw.amountMinor, /^-?(?:0|[1-9][0-9]{0,20})$/u),
    currency: text(raw.currency, currency),
  });
}
function codes(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(item))
  )
    throw new Error("invalid");
  return Object.freeze([...value]);
}
function parseQuote(value: unknown, expectedCartVersion: number): CheckoutQuote {
  const root = exact(value, ["schemaVersion", "quote"]);
  const raw = exact(root.quote, [
    "quoteReference",
    "quoteVersion",
    "cartVersion",
    "currency",
    "subtotal",
    "discount",
    "tax",
    "fee",
    "total",
    "expiresAt",
    "warnings",
    "blockingReasons",
    "priceChange",
  ]);
  const quoteCurrency = text(raw.currency, currency);
  if (root.schemaVersion !== 1 || raw.cartVersion !== expectedCartVersion)
    throw new Error("invalid");
  const price =
    raw.priceChange === null
      ? null
      : exact(raw.priceChange, [
          "previousQuoteReference",
          "outcome",
          "totalChange",
          "requiresReconfirmation",
          "evaluatedAt",
        ]);
  const amounts = [
    money(raw.subtotal),
    money(raw.discount),
    money(raw.tax),
    money(raw.fee),
    money(raw.total),
  ];
  const [subtotal, discount, tax, fee, total] = amounts;
  if (
    amounts.some((value) => value.currency !== quoteCurrency) ||
    (price !== null && typeof price.requiresReconfirmation !== "boolean")
  )
    throw new Error("invalid");
  if (
    subtotal === undefined ||
    discount === undefined ||
    tax === undefined ||
    fee === undefined ||
    total === undefined
  )
    throw new Error("invalid");
  if (price !== null) text(price.previousQuoteReference, uuidV7);
  const expiresAt = text(raw.expiresAt, instant);
  if (Number.isNaN(Date.parse(expiresAt))) throw new Error("invalid");
  const totalChange = price === null ? null : money(price.totalChange);
  const evaluatedAt = price === null ? null : text(price.evaluatedAt, instant);
  if (
    (totalChange !== null && totalChange.currency !== quoteCurrency) ||
    (evaluatedAt !== null && Number.isNaN(Date.parse(evaluatedAt)))
  )
    throw new Error("invalid");
  return Object.freeze({
    quoteReference: text(raw.quoteReference, uuidV7),
    quoteVersion: integer(raw.quoteVersion),
    cartVersion: integer(raw.cartVersion),
    subtotal,
    discount,
    tax,
    fee,
    total,
    expiresAt,
    warnings: codes(raw.warnings),
    blockingReasons: codes(raw.blockingReasons),
    priceChange:
      price === null
        ? null
        : Object.freeze({
            outcome: text(price.outcome, /^[A-Za-z][A-Za-z0-9]{0,63}$/u),
            totalChange: totalChange as CartMoney,
            requiresReconfirmation: price.requiresReconfirmation as boolean,
            evaluatedAt: evaluatedAt as string,
          }),
  });
}

export interface CheckoutClient {
  loadCart(): Promise<CartView | null>;
  quote(cart: CartView, operationReference: string): Promise<CheckoutQuote>;
}

/** Quote writes remain uncertain when the complete response cannot be confirmed. */
async function requestQuote(url: string, init: RequestInit, contextCurrent: () => boolean) {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectCancellation: (error: CartClientError) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectCancellation(new CartClientError("network_unknown"));
  }, browserRequestTimeoutMs);
  const check = () => {
    if (controller.signal.aborted || !contextCurrent())
      throw new CartClientError("network_unknown");
  };
  const operation = async () => {
    check();
    const response = await globalThis.fetch(url, {
      ...init,
      signal: controller.signal,
      mode: "cors",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (
      controller.signal.aborted ||
      !contextCurrent() ||
      response.redirected ||
      response.body === null
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new CartClientError("network_unknown");
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      check();
      const part = await reader.read();
      check();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16 * 1024 * 1024) throw new CartClientError("network_unknown");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    check();
    return { response, payload };
  };
  try {
    const result = await Promise.race([operation(), cancellation]);
    check();
    return result;
  } catch {
    throw new CartClientError("network_unknown");
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader !== undefined) {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

export function createCheckoutClient(cartClient: CustomerCartClient): CheckoutClient {
  return Object.freeze({
    loadCart: () => cartClient.loadCurrent(),
    async quote(cart: CartView, operationReference: string) {
      const contextCurrent = captureCustomerCsrfContext();
      const csrf = getCustomerCsrfCredential();
      if (csrf === null) throw new CartClientError("cart_session_expired");
      if (!credential.test(csrf) || !uuidV7.test(operationReference))
        throw new CartClientError("cart_request_invalid");
      let cartReference: string;
      let cartVersion: number;
      try {
        cartReference = text(cart.cart.cartReference, uuidV7);
        cartVersion = integer(cart.cart.version);
      } catch {
        throw new CartClientError("cart_request_invalid");
      }
      const { response, payload } = await requestQuote(
        "/api/v1/carts/" + cartReference + "/quote",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": operationReference,
            "x-csrf-token": csrf,
          },
          body: JSON.stringify({ cartVersion }),
        },
        contextCurrent,
      );
      try {
        if (!contextCurrent()) throw new CartClientError("network_unknown");
        if (response.status === 200 || response.status === 201)
          return parseQuote(payload, cartVersion);
        const errorRoot = exact(payload, ["schemaVersion", "error"]);
        if (errorRoot.schemaVersion !== 1) throw new Error("invalid");
        const error = exact(errorRoot.error, ["code", "messageKey"]);
        text(error.messageKey, /^[a-z][a-z0-9_.-]{0,127}$/u);
        const known = {
          quote_version_conflict: [409, "cart_version_conflict"],
          quote_idempotency_conflict: [409, "cart_idempotency_conflict"],
          quote_configuration_invalid: [422, "cart_selection_invalid"],
          quote_request_invalid: [400, "cart_request_invalid"],
        } as const;
        const contract = Object.hasOwn(known, String(error.code))
          ? known[error.code as keyof typeof known]
          : undefined;
        throw new CartClientError(
          contract !== undefined && response.status === contract[0]
            ? contract[1]
            : "network_unknown",
        );
      } catch (error) {
        if (!contextCurrent()) throw new CartClientError("network_unknown");
        if (error instanceof CartClientError) throw error;
        throw new CartClientError("network_unknown");
      }
    },
  });
}

export interface CheckoutController {
  getState(): CheckoutState;
  load(): Promise<void>;
  quote(): Promise<void>;
  retry(): Promise<void>;
  setOnline(value: boolean): void;
  subscribe(listener: () => void): () => void;
}
function key(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 255;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 15) | 112;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = [...bytes].map((v) => v.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface QuotePlan {
  readonly cart: CartView;
  readonly operationReference: string;
  readonly contextCurrent: () => boolean;
  outcomeUnknown: boolean;
}
function snapshotCart(current: CartView): CartView {
  const copy = structuredClone(current);
  const pending: object[] = [copy];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const value = pending.pop();
    if (value === undefined || seen.has(value)) continue;
    seen.add(value);
    for (const field of Object.values(value))
      if (field !== null && typeof field === "object") pending.push(field);
    Object.freeze(value);
  }
  return copy;
}
export function createCheckoutController(
  client: CheckoutClient,
  keyFactory = key,
): CheckoutController {
  let state: CheckoutState = { status: "loading" };
  let online = typeof navigator === "undefined" || navigator.onLine !== false;
  let plan: QuotePlan | null = null;
  let quoteFlight: Promise<void> | null = null;
  let revision = 0;
  let querySequence = 0;
  let offlineWasEmpty = false;
  const listeners = new Set<() => void>();
  const publish = (next: CheckoutState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const cart = () => ("cart" in state ? state.cart : null);
  const unresolved = () => {
    const available = plan?.contextCurrent() === true;
    publish({
      status: online ? "outcome-unknown" : "offline",
      cart: available ? (plan?.cart ?? null) : null,
      canRetry: available,
    });
  };
  const fail = (error: unknown, current: CartView | null) => {
    const parsed = error instanceof CartClientError ? error.code : "cart_service_unavailable";
    publish({
      status: !online
        ? "offline"
        : parsed === "cart_session_expired"
          ? "session-expired"
          : parsed === "cart_version_conflict" || parsed === "cart_idempotency_conflict"
            ? "conflict"
            : parsed === "cart_selection_invalid" || parsed === "cart_request_invalid"
              ? "validation"
              : "unavailable",
      cart: parsed === "cart_session_expired" ? null : current,
      canRetry: false,
    });
  };
  const executeQuote = async () => {
    const current = plan?.cart ?? cart();
    if (!online) {
      publish({
        status: "offline",
        cart: plan !== null && !plan.contextCurrent() ? null : current,
        canRetry: plan !== null && plan.contextCurrent(),
      });
      return;
    }
    if (current === null || current.cart.items.length === 0) return;
    revision += 1;
    if (plan === null) {
      const contextCurrent = captureCustomerCsrfContext();
      try {
        plan = {
          cart: snapshotCart(current),
          operationReference: keyFactory(),
          contextCurrent,
          outcomeUnknown: false,
        };
      } catch (error) {
        fail(error, current);
        return;
      }
    }
    const active = plan;
    if (!active.contextCurrent()) {
      active.outcomeUnknown = true;
      unresolved();
      return;
    }
    publish({ status: "pending", cart: active.cart });
    try {
      const result = await client.quote(active.cart, active.operationReference);
      if (!active.contextCurrent() || result.cartVersion !== active.cart.cart.version)
        throw new CartClientError("network_unknown");
      plan = null;
      publish(
        online
          ? { status: "ready", cart: active.cart, quote: result }
          : { status: "offline", cart: active.cart, canRetry: false },
      );
    } catch (error) {
      if (
        active.outcomeUnknown ||
        !active.contextCurrent() ||
        (error instanceof CartClientError && error.code === "network_unknown")
      ) {
        active.outcomeUnknown = true;
        unresolved();
        return;
      }
      plan = null;
      if (error instanceof CartClientError && error.code === "cart_version_conflict" && online) {
        try {
          const refreshed = await client.loadCart();
          if (!active.contextCurrent()) {
            fail(new CartClientError("cart_session_expired"), null);
            return;
          }
          publish({ status: online ? "conflict" : "offline", cart: refreshed, canRetry: false });
        } catch (refreshError) {
          fail(refreshError, active.cart);
        }
        return;
      }
      fail(error, active.cart);
    }
  };
  const quote = (): Promise<void> => {
    if (quoteFlight !== null) return quoteFlight;
    // Install the flight before publishing or calling injected providers/listeners.
    let complete: () => void = () => undefined;
    const flight = new Promise<void>((resolve) => {
      complete = resolve;
    });
    quoteFlight = flight;
    const settle = () => {
      if (quoteFlight === flight) quoteFlight = null;
      complete();
    };
    void executeQuote().then(settle, (error) => {
      if (plan?.outcomeUnknown) unresolved();
      else fail(error, cart());
      settle();
    });
    return flight;
  };
  return Object.freeze({
    getState: () => state,
    async load() {
      if (quoteFlight !== null) return;
      if (!online) {
        if (plan !== null) unresolved();
        else publish({ status: "offline", cart: cart(), canRetry: false });
        return;
      }
      const observedRevision = revision;
      const query = ++querySequence;
      const contextCurrent = captureCustomerCsrfContext();
      try {
        const current = await client.loadCart();
        if (
          observedRevision !== revision ||
          query !== querySequence ||
          quoteFlight !== null ||
          !online
        )
          return;
        if (plan !== null) {
          unresolved();
          return;
        }
        if (!contextCurrent()) {
          fail(new CartClientError("cart_service_unavailable"), null);
          return;
        }
        publish(
          current === null || current.cart.items.length === 0
            ? { status: "empty" }
            : { status: "ready", cart: current, quote: null },
        );
      } catch (error) {
        if (
          observedRevision !== revision ||
          query !== querySequence ||
          quoteFlight !== null ||
          !online
        )
          return;
        if (plan !== null) unresolved();
        else fail(error, null);
      }
    },
    quote,
    retry: () => (plan === null ? Promise.resolve() : quote()),
    setOnline(value: boolean) {
      if (online === value) return;
      online = value;
      revision += 1;
      if (!value) {
        offlineWasEmpty = state.status === "empty";
        publish({
          status: "offline",
          cart: plan !== null && !plan.contextCurrent() ? null : cart(),
          canRetry: plan !== null && plan.contextCurrent(),
        });
        return;
      }
      if (quoteFlight !== null) {
        if (plan !== null && !plan.contextCurrent()) {
          unresolved();
          return;
        }
        const current = plan?.cart ?? cart();
        publish(
          current === null
            ? { status: "unavailable", cart: null, canRetry: false }
            : { status: "pending", cart: current },
        );
        return;
      }
      if (plan !== null) {
        unresolved();
        return;
      }
      const current = cart();
      publish(
        current === null
          ? offlineWasEmpty
            ? { status: "empty" }
            : { status: "unavailable", cart: null, canRetry: false }
          : current.cart.items.length === 0
            ? { status: "empty" }
            : { status: "ready", cart: current, quote: null },
      );
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
}
