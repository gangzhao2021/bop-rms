import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";
import { requestCheckoutMutation, retryAfterSeconds } from "./checkout-client.js";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export interface CheckoutSessionSelection {
  readonly cartReference: string;
  readonly cartVersion: number;
  readonly quoteReference: string;
  readonly quoteVersion: 1 | 2;
}
export interface CheckoutSessionView extends CheckoutSessionSelection {
  readonly checkoutSessionReference: string;
  readonly createdAt: string;
}
/**
 * WP-2423: the cart line the store can't make as it stands: how many of that item can still be
 * made with the rest of the cart (0: none), and whether it is short only because other items use
 * the same ingredients. `available` is null when the item can't be sold for another reason.
 */
export interface CheckoutRefusedLine {
  readonly cartItemReference: string;
  readonly available: number | null;
  readonly sharedStock: boolean;
}
export class CheckoutSessionClientError extends Error {
  constructor(
    readonly code:
      | "invalid"
      | "denied"
      | "conflict"
      | "store_closed"
      | "checkout_in_progress"
      | "item_short"
      | "item_unavailable"
      | "unknown",
    /** WP-2423: the server's bounded wait before retrying, when it sent one. */
    readonly retryAfterSeconds: number | null = null,
    /** WP-2423: for item_short / item_unavailable, the cart line it is about (when sent). */
    readonly line: CheckoutRefusedLine | null = null,
  ) {
    super("Checkout session unavailable.");
    this.name = "CheckoutSessionClientError";
  }
}
function exact(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).length !== fields.length ||
    Object.keys(raw).some((key) => !fields.includes(key))
  )
    throw new Error();
  return raw;
}
function parse(value: unknown): CheckoutSessionView {
  const root = exact(value, ["schemaVersion", "session"]);
  const raw = exact(root.session, [
    "checkoutSessionReference",
    "cartReference",
    "cartVersion",
    "quoteReference",
    "quoteVersion",
    "createdAt",
  ]);
  if (
    root.schemaVersion !== 1 ||
    !["checkoutSessionReference", "cartReference", "quoteReference"].every(
      (key) => typeof raw[key] === "string" && uuid.test(raw[key]),
    ) ||
    !Number.isSafeInteger(raw.cartVersion) ||
    Number(raw.cartVersion) < 1 ||
    Number(raw.cartVersion) > 2147483647 ||
    (raw.quoteVersion !== 1 && raw.quoteVersion !== 2) ||
    typeof raw.createdAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(raw.createdAt) ||
    new Date(raw.createdAt).toISOString() !== raw.createdAt
  )
    throw new Error();
  return Object.freeze(raw) as unknown as CheckoutSessionView;
}
/** WP-2423: the cart line an item refusal is about, when the server sent a well-formed one. */
function refusedLine(payload: unknown, short: boolean): CheckoutRefusedLine | null {
  const error =
    payload !== null && typeof payload === "object"
      ? (payload as { error?: { line?: unknown } }).error
      : undefined;
  const line = error?.line;
  if (line === null || typeof line !== "object") return null;
  const raw = line as Record<string, unknown>;
  if (typeof raw.cartItemReference !== "string" || !uuid.test(raw.cartItemReference)) return null;
  if (!short)
    return { cartItemReference: raw.cartItemReference, available: null, sharedStock: false };
  if (
    typeof raw.available !== "number" ||
    !Number.isSafeInteger(raw.available) ||
    raw.available < 0 ||
    typeof raw.sharedStock !== "boolean"
  )
    return null;
  return {
    cartItemReference: raw.cartItemReference,
    available: raw.available,
    sharedStock: raw.sharedStock,
  };
}
/** WP-2423 Q4: the server's error code, when it sent one. */
function errorCode(payload: unknown): string | null {
  const error =
    payload !== null && typeof payload === "object"
      ? (payload as { error?: { code?: unknown } }).error
      : undefined;
  return typeof error?.code === "string" ? error.code : null;
}
export function createCheckoutSessionClient() {
  async function request(path: string, init: RequestInit): Promise<CheckoutSessionView> {
    const current = captureCustomerCsrfContext(),
      csrf = getCustomerCsrfCredential();
    if (csrf === null) throw new CheckoutSessionClientError("denied");
    if (!/^[A-Za-z0-9_-]{43}$/u.test(csrf)) throw new CheckoutSessionClientError("invalid");
    try {
      const { response, payload } = await requestCheckoutMutation(
        path,
        {
          ...init,
          headers: { ...init.headers, "x-csrf-token": csrf },
        },
        current,
      );
      if (!current()) throw new CheckoutSessionClientError("unknown");
      // WP-2423: another guest at the table is checking out this cart; nothing was created.
      if (response.status === 409 && errorCode(payload) === "cart_checkout_in_progress")
        throw new CheckoutSessionClientError("checkout_in_progress", retryAfterSeconds(response));
      // WP-2423: the store can't make the cart as it stands; nothing was created or charged.
      if (response.status === 409 && errorCode(payload) === "checkout_session_item_short")
        throw new CheckoutSessionClientError("item_short", null, refusedLine(payload, true));
      if (response.status === 409 && errorCode(payload) === "checkout_session_item_unavailable")
        throw new CheckoutSessionClientError("item_unavailable", null, refusedLine(payload, false));
      if (![200, 201].includes(response.status))
        throw new CheckoutSessionClientError(
          response.status === 404
            ? "denied"
            : response.status === 409 && errorCode(payload) === "checkout_session_store_closed"
              ? "store_closed"
              : response.status === 409
                ? "conflict"
                : response.status === 400
                  ? "invalid"
                  : "unknown",
        );
      return parse(payload);
    } catch (error) {
      if (error instanceof CheckoutSessionClientError) throw error;
      throw new CheckoutSessionClientError("unknown");
    }
  }
  return Object.freeze({
    async create(selection: CheckoutSessionSelection, createOperationReference: string) {
      if (
        !uuid.test(selection.cartReference) ||
        !uuid.test(selection.quoteReference) ||
        !uuid.test(createOperationReference) ||
        !Number.isSafeInteger(selection.cartVersion) ||
        selection.cartVersion < 1 ||
        selection.cartVersion > 2147483647 ||
        ![1, 2].includes(selection.quoteVersion)
      )
        throw new CheckoutSessionClientError("invalid");
      const expected = { ...selection };
      const result = await request(
        "/api/v1/carts/" + selection.cartReference + "/checkout-sessions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": createOperationReference,
          },
          body: JSON.stringify({
            cartVersion: selection.cartVersion,
            quoteReference: selection.quoteReference,
          }),
        },
      );
      if (
        result.cartReference !== expected.cartReference ||
        result.cartVersion !== expected.cartVersion ||
        result.quoteReference !== expected.quoteReference ||
        result.quoteVersion !== expected.quoteVersion
      )
        throw new CheckoutSessionClientError("conflict");
      return result;
    },
    async read(checkoutSessionReference: string) {
      if (!uuid.test(checkoutSessionReference)) throw new CheckoutSessionClientError("invalid");
      const result = await request("/api/v1/checkout-sessions/" + checkoutSessionReference, {
        method: "GET",
      });
      if (result.checkoutSessionReference !== checkoutSessionReference)
        throw new CheckoutSessionClientError("conflict");
      return result;
    },
  });
}
