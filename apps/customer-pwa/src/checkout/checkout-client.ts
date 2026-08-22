import type { CustomerCartClient } from "../cart/cart-client.js";
import { boundedFetch } from "../network/bounded-fetch.js";
import { CartClientError, type CartMoney, type CartView } from "../cart/types.js";
import { getCustomerCsrfCredential } from "../session/customer-transaction-context.js";
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
function parseQuote(value: unknown, cart: CartView): CheckoutQuote {
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
  if (root.schemaVersion !== 1 || raw.cartVersion !== cart.cart.version) throw new Error("invalid");
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

export function createCheckoutClient(cartClient: CustomerCartClient): CheckoutClient {
  return Object.freeze({
    loadCart: () => cartClient.loadCurrent(),
    async quote(cart: CartView, operationReference: string) {
      const csrf = getCustomerCsrfCredential();
      if (csrf === null) throw new CartClientError("cart_session_expired");
      if (!credential.test(csrf) || !uuidV7.test(operationReference))
        throw new CartClientError("cart_request_invalid");
      let response: Response;
      try {
        response = await boundedFetch(
          globalThis.fetch,
          `/api/v1/carts/${cart.cart.cartReference}/quote`,
          {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: {
              "content-type": "application/json",
              "idempotency-key": operationReference,
              "x-csrf-token": csrf,
            },
            body: JSON.stringify({ cartVersion: cart.cart.version }),
          },
        );
      } catch {
        throw new CartClientError("network_unknown");
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new CartClientError("cart_service_unavailable");
      }
      try {
        if (response.ok) return parseQuote(body, cart);
        const errorRoot = exact(body, ["schemaVersion", "error"]);
        if (errorRoot.schemaVersion !== 1) throw new CartClientError("cart_service_unavailable");
        const error = exact(errorRoot.error, ["code", "messageKey"]);
        text(error.messageKey, /^[a-z][a-z0-9_.-]{0,127}$/u);
        const code = String(error.code);
        throw new CartClientError(
          code === "quote_version_conflict"
            ? "cart_version_conflict"
            : code === "quote_configuration_invalid"
              ? "cart_selection_invalid"
              : code === "quote_request_invalid"
                ? "cart_request_invalid"
                : "cart_service_unavailable",
        );
      } catch (error) {
        if (error instanceof CartClientError) throw error;
        throw new CartClientError("cart_service_unavailable");
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
  bytes[6] = ((bytes[6] ?? 0) & 15) | 112;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = [...bytes].map((v) => v.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function createCheckoutController(
  client: CheckoutClient,
  keyFactory = key,
): CheckoutController {
  let state: CheckoutState = { status: "loading" };
  let online = typeof navigator === "undefined" || navigator.onLine !== false;
  let pendingKey: string | null = null;
  let quoteFlight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: CheckoutState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const cart = () => ("cart" in state ? state.cart : null);
  const fail = (error: unknown, current: CartView | null) => {
    const parsed = error instanceof CartClientError ? error.code : "cart_service_unavailable";
    if (parsed !== "network_unknown") pendingKey = null;
    publish({
      status:
        parsed === "cart_session_expired"
          ? "session-expired"
          : parsed === "cart_version_conflict"
            ? "conflict"
            : parsed === "cart_selection_invalid" || parsed === "cart_request_invalid"
              ? "validation"
              : parsed === "network_unknown"
                ? "outcome-unknown"
                : "unavailable",
      cart: current,
      canRetry: parsed === "network_unknown",
    });
  };
  const executeQuote = async () => {
    const current = cart();
    if (!online) {
      publish({ status: "offline", cart: current, canRetry: pendingKey !== null });
      return;
    }
    if (current === null) return;
    pendingKey ??= keyFactory();
    publish({ status: "pending", cart: current });
    try {
      const result = await client.quote(current, pendingKey);
      pendingKey = null;
      publish({ status: "ready", cart: current, quote: result });
    } catch (error) {
      if (error instanceof CartClientError && error.code === "cart_version_conflict") {
        pendingKey = null;
        try {
          const refreshed = await client.loadCart();
          publish({ status: "conflict", cart: refreshed, canRetry: false });
          return;
        } catch {
          publish({ status: "unavailable", cart: current, canRetry: false });
          return;
        }
      }
      fail(error, current);
    }
  };
  const quote = (): Promise<void> => {
    if (quoteFlight !== null) return quoteFlight;
    const current = executeQuote();
    quoteFlight = current;
    void current.then(
      () => {
        if (quoteFlight === current) quoteFlight = null;
      },
      () => {
        if (quoteFlight === current) quoteFlight = null;
      },
    );
    return current;
  };
  return Object.freeze({
    getState: () => state,
    async load() {
      if (!online) {
        publish({ status: "offline", cart: cart(), canRetry: false });
        return;
      }
      try {
        const current = await client.loadCart();
        pendingKey = null;
        publish(
          current === null || current.cart.items.length === 0
            ? { status: "empty" }
            : { status: "ready", cart: current, quote: null },
        );
      } catch (error) {
        fail(error, null);
      }
    },
    quote,
    retry: quote,
    setOnline(value: boolean) {
      online = value;
      if (!value) publish({ status: "offline", cart: cart(), canRetry: pendingKey !== null });
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
